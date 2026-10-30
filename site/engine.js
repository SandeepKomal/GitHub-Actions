// The workflow engine behind the playground: it reads a workflow, decides
// whether an event triggers it, expands jobs and matrices, and runs every step
// on a modelled runner, printing what GitHub Actions would print. Nothing here
// talks to GitHub. No DOM, so tests/check_playground.js drives it under Node.
"use strict";

(function (root) {
  const { parse, at } = root.AQYaml;
  const OWNER = "devquest", REPO = "shop", FULL = `${OWNER}/${REPO}`;
  const WORK = `/home/runner/work/${REPO}/${REPO}`;
  const SCRIPT = "/home/runner/work/_temp/0f3c9b2e.sh";
  const FILES = { output: "/home/runner/work/_temp/_runner_file_commands/set_output", env: "/home/runner/work/_temp/_runner_file_commands/set_env",
    summary: "/home/runner/work/_temp/_runner_file_commands/step_summary", path: "/home/runner/work/_temp/_runner_file_commands/add_path" };
  const CONCURRENT_JOBS = 20; // the Free plan's limit for standard Linux runners
  const DEFAULT_TIMEOUT = 360;

  // --- small helpers ------------------------------------------------------------

  function hash(text) {
    let a = 0x811c9dc5, b = 0x01000193;
    for (const ch of String(text)) { a = Math.imul(a ^ ch.charCodeAt(0), 16777619); b = Math.imul(b + ch.charCodeAt(0), 2246822519) ^ (b >>> 13); }
    const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
    return (hex(a) + hex(b) + hex(a ^ b) + hex(Math.imul(a, b)) + hex(a + b)).slice(0, 40);
  }
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const keys = (o) => (isObj(o) ? Object.keys(o) : []);
  // Contexts and their properties are case-insensitive.
  function prop(obj, key) {
    if (obj == null || typeof obj !== "object") return null;
    if (Array.isArray(obj)) { const n = Number(key); return Number.isInteger(n) && n >= 0 && n < obj.length ? obj[n] : null; }
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    const k = Object.keys(obj).find((x) => x.toLowerCase() === String(key).toLowerCase());
    return k === undefined ? null : obj[k];
  }
  const toStr = (v) => (v == null ? "" : typeof v === "boolean" ? String(v) : typeof v === "number" ? (Number.isInteger(v) || !Number.isFinite(v) ? String(v) : String(Number(v.toPrecision(15)))) : Array.isArray(v) ? "Array" : typeof v === "object" ? "Object" : String(v));
  const truthy = (v) => !(v == null || v === false || v === 0 || v === "" || (typeof v === "number" && Number.isNaN(v)));
  const fmtSecs = (s) => (!Number.isFinite(s) ? "6h 0m" : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);

  // --- expressions: ${{ ... }} ----------------------------------------------------

  class ExprError extends Error {}
  class ShellSyntax extends Error {}
  // A step failure with a message for the log, as opposed to a bug.
  class StepError extends Error {}
  const FUNCS = ["contains", "startswith", "endswith", "format", "join", "tojson", "fromjson", "hashfiles", "success", "failure", "always", "cancelled"];
  const CONTEXTS = ["github", "env", "vars", "job", "jobs", "steps", "runner", "secrets", "strategy", "matrix", "needs", "inputs"];

  function lex(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      const pos = i + 1;
      if (c === "'") {
        let j = i + 1, v = "";
        for (;;) {
          if (j >= src.length) throw new ExprError(`Unexpected end of expression: '${src.slice(i)}'. Located at position ${pos} within expression: ${src}`);
          if (src[j] === "'") { if (src[j + 1] === "'") { v += "'"; j += 2; continue; } break; }
          v += src[j++];
        }
        out.push({ t: "str", v, pos });
        i = j + 1;
        continue;
      }
      const rest = src.slice(i);
      let m = /^(0x[0-9a-fA-F]+|-?\d+(\.\d+)?([eE][-+]?\d+)?)/.exec(rest);
      if (m && (c !== "-" || !out.length || out[out.length - 1].t === "op")) { out.push({ t: "num", v: Number(m[0]), pos }); i += m[0].length; continue; }
      m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(rest);
      if (m) { out.push({ t: "id", v: m[0], pos }); i += m[0].length; continue; }
      m = /^(==|!=|<=|>=|&&|\|\||[<>!()[\].,*])/.exec(rest);
      if (m) { out.push({ t: "op", v: m[0], pos }); i += m[0].length; continue; }
      throw new ExprError(`Unexpected symbol: '${c}'. Located at position ${pos} within expression: ${src}`);
    }
    return out;
  }

  function parseExpr(src) {
    const toks = lex(src);
    let i = 0;
    const peek = (v) => toks[i] && toks[i].t === "op" && toks[i].v === v;
    const fail = (tok) => new ExprError(tok ? `Unexpected symbol: '${tok.t === "str" ? `'${tok.v}'` : tok.v}'. Located at position ${tok.pos} within expression: ${src}`
      : `Unexpected end of expression: '${src}'. Located at position ${src.length} within expression: ${src}`);
    const bin = (next, ops) => () => {
      let left = next();
      while (toks[i] && toks[i].t === "op" && ops.includes(toks[i].v)) { const op = toks[i++].v; left = { k: "bin", op, l: left, r: next() }; }
      return left;
    };
    const unary = () => (peek("!") ? (i++, { k: "not", e: unary() }) : postfix(primary()));
    const cmp = bin(unary, ["<", "<=", ">", ">="]);
    const eq = bin(cmp, ["==", "!="]);
    const and = bin(eq, ["&&"]);
    const or = bin(and, ["||"]);
    function primary() {
      const t = toks[i++];
      if (!t) throw fail(null);
      if (t.t === "num" || t.t === "str") return { k: "lit", v: t.v };
      if (t.t === "op" && t.v === "(") { const e = or(); if (!peek(")")) throw fail(toks[i]); i++; return e; }
      if (t.t !== "id") throw fail(t);
      const low = t.v.toLowerCase();
      if (low === "true" || low === "false") return { k: "lit", v: low === "true" };
      if (low === "null") return { k: "lit", v: null };
      if (peek("(")) {
        i++;
        const args = [];
        if (!peek(")")) for (;;) { args.push(or()); if (peek(",")) { i++; continue; } break; }
        if (!peek(")")) throw fail(toks[i]);
        i++;
        return { k: "call", name: low, raw: t.v, args, pos: t.pos };
      }
      return { k: "ctx", name: low, raw: t.v, pos: t.pos };
    }
    function postfix(e) {
      for (;;) {
        if (peek(".")) {
          i++;
          const t = toks[i++];
          if (t && t.t === "op" && t.v === "*") e = { k: "star", o: e };
          else if (t && (t.t === "id" || t.t === "num")) e = { k: "get", o: e, key: { k: "lit", v: String(t.v) } };
          else throw fail(t);
        } else if (peek("[")) {
          i++;
          if (peek("*")) { i++; e = { k: "star", o: e }; } else e = { k: "get", o: e, key: or() };
          if (!peek("]")) throw fail(toks[i]);
          i++;
        } else return e;
      }
    }
    const tree = or();
    if (i < toks.length) throw fail(toks[i]);
    return tree;
  }

  function coerce(v) {
    if (v === null) return 0;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") return v;
    if (typeof v === "string") return v.trim() === "" ? 0 : Number(v.trim());
    return NaN;
  }
  function looseEq(a, b) {
    if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
    if (typeof a === "object" || typeof b === "object") return a === b;
    if (typeof a === typeof b) return a === b;
    return coerce(a) === coerce(b);
  }

  function evaluate(src, ctx) {
    const tree = parseExpr(src);
    const ev = (n) => {
      switch (n.k) {
        case "lit": return n.v;
        case "ctx": return ctx.data[n.name] === undefined ? null : ctx.data[n.name];
        case "not": return !truthy(ev(n.e));
        case "star": { const o = ev(n.o); const list = Array.isArray(o) ? o : isObj(o) ? Object.values(o) : []; list.star = true; return list; }
        case "get": {
          const o = ev(n.o), k = toStr(ev(n.key));
          if (Array.isArray(o) && o.star) { const r = o.map((x) => prop(x, k)).filter((x) => x != null); r.star = true; return r; }
          const v = prop(o, k);
          return v === undefined ? null : v;
        }
        case "bin": {
          if (n.op === "&&") { const l = ev(n.l); return truthy(l) ? ev(n.r) : l; }
          if (n.op === "||") { const l = ev(n.l); return truthy(l) ? l : ev(n.r); }
          const l = ev(n.l), r = ev(n.r);
          if (n.op === "==") return looseEq(l, r);
          if (n.op === "!=") return !looseEq(l, r);
          const [a, b] = typeof l === "string" && typeof r === "string" ? [l.toLowerCase(), r.toLowerCase()] : [coerce(l), coerce(r)];
          return n.op === "<" ? a < b : n.op === "<=" ? a <= b : n.op === ">" ? a > b : a >= b;
        }
        case "call": {
          const a = n.args.map(ev);
          switch (n.name) {
            case "contains": return Array.isArray(a[0]) ? a[0].some((x) => looseEq(x, a[1])) : toStr(a[0]).toLowerCase().includes(toStr(a[1]).toLowerCase());
            case "startswith": return toStr(a[0]).toLowerCase().startsWith(toStr(a[1]).toLowerCase());
            case "endswith": return toStr(a[0]).toLowerCase().endsWith(toStr(a[1]).toLowerCase());
            case "format": return toStr(a[0]).replace(/\{\{|\}\}|\{(\d+)\}/g, (m, d) => (m === "{{" ? "{" : m === "}}" ? "}" : toStr(a[Number(d) + 1])));
            case "join": return Array.isArray(a[0]) ? a[0].map(toStr).join(a.length > 1 ? toStr(a[1]) : ",") : toStr(a[0]);
            case "tojson": return JSON.stringify(a[0] === undefined ? null : a[0], null, 2);
            case "fromjson": try { return JSON.parse(toStr(a[0])); } catch { throw new ExprError(`Error reading JToken from JsonReader. Path '', line 0, position 0.`); }
            case "hashfiles": return ctx.hashFiles ? ctx.hashFiles(a.map(toStr)) : "";
            case "success": return ctx.status === "success";
            case "failure": return ctx.status === "failure";
            case "cancelled": return ctx.status === "cancelled";
            case "always": return true;
            default: throw new ExprError(`Unrecognized function: '${n.raw}'. Located at position ${n.pos} within expression: ${src}`);
          }
        }
        default: return null;
      }
    };
    return ev(tree);
  }

  // Which contexts and functions an expression uses, for validation.
  function namesIn(src) {
    const out = [];
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (n.k === "ctx") out.push({ kind: "ctx", name: n.name, raw: n.raw, pos: n.pos });
      if (n.k === "call") out.push({ kind: "call", name: n.name, raw: n.raw, pos: n.pos });
      for (const v of Object.values(n)) if (v && typeof v === "object") (Array.isArray(v) ? v.forEach(walk) : walk(v));
    };
    walk(parseExpr(src));
    return out;
  }
  const exprsIn = (s) => (typeof s === "string" ? [...s.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1].trim()) : []);
  // An if: may be written with or without ${{ }}.
  const ifExpr = (v) => {
    const s = toStr(v).trim();
    const m = /^\$\{\{([\s\S]*)\}\}$/.exec(s);
    if (m && !m[1].includes("}}")) return m[1].trim();
    // Text around a ${{ }} makes the whole if a string, and a non-empty string is true.
    return s.includes("${{") ? "true" : s;
  };
  const hasStatusFn = (src) => /\b(success|failure|always|cancelled)\s*\(/i.test(src);

  // Replace ${{ }} in a string. Errors are returned, as GitHub fails the step.
  function interpolate(s, ctx) {
    if (typeof s !== "string") return s;
    return s.replace(/\$\{\{([\s\S]*?)\}\}/g, (m, e) => toStr(evaluate(e.trim(), ctx)));
  }
  // A value that is one ${{ }} keeps its type (a number, a list, an object).
  function value(v, ctx) {
    if (typeof v !== "string") return v;
    const m = /^\s*\$\{\{([\s\S]*?)\}\}\s*$/.exec(v);
    return m && !m[1].includes("}}") ? evaluate(m[1].trim(), ctx) : interpolate(v, ctx);
  }

  // --- glob filters for branches, tags and paths -------------------------------------

  function globRe(p) {
    let re = "";
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === "*" && p[i + 1] === "*") { re += ".*"; i++; if (p[i + 1] === "/") { re += "/?"; i++; } }
      else if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else if (c === "+" && i > 0) re += "+";
      else if (c === "[") { const j = p.indexOf("]", i); if (j > i) { re += p.slice(i, j + 1).replace(/\\/g, "\\\\"); i = j; } else re += "\\["; }
      else re += c.replace(/[.^$()|{}\\]/g, "\\$&");
    }
    return new RegExp("^" + re + "$");
  }
  function filterMatch(patterns, value) {
    let ok = false;
    for (const raw of [].concat(patterns)) {
      const p = toStr(raw);
      if (p.startsWith("!")) { if (globRe(p.slice(1)).test(value)) ok = false; } else if (globRe(p).test(value)) ok = true;
    }
    return ok;
  }

  // --- validation -------------------------------------------------------------------

  const EVENTS = ["branch_protection_rule", "check_run", "check_suite", "create", "delete", "deployment", "deployment_status", "discussion", "discussion_comment", "fork", "gollum",
    "issue_comment", "issues", "label", "merge_group", "milestone", "page_build", "public", "pull_request", "pull_request_review", "pull_request_review_comment",
    "pull_request_target", "push", "registry_package", "release", "repository_dispatch", "schedule", "status", "watch", "workflow_call", "workflow_dispatch", "workflow_run"];
  const TOP = ["name", "run-name", "on", "permissions", "env", "defaults", "concurrency", "jobs"];
  const JOB = ["name", "needs", "runs-on", "permissions", "environment", "concurrency", "outputs", "env", "defaults", "if", "steps", "timeout-minutes", "strategy",
    "continue-on-error", "container", "services", "uses", "with", "secrets", "snapshot"];
  const STEP = ["id", "if", "name", "uses", "run", "shell", "with", "env", "continue-on-error", "timeout-minutes", "working-directory"];
  const SCOPES = ["actions", "attestations", "checks", "contents", "deployments", "discussions", "id-token", "issues", "models", "packages", "pages",
    "pull-requests", "repository-projects", "security-events", "statuses"];
  // Which contexts each place may use, as in GitHub's context availability table.
  const ALLOWED = {
    "workflow-env": ["github", "secrets", "inputs", "vars"],
    "job-if": ["github", "needs", "vars", "inputs"],
    "job": ["github", "needs", "strategy", "matrix", "vars", "inputs"],
    "job-env": ["github", "needs", "strategy", "matrix", "vars", "secrets", "inputs"],
    "job-outputs": ["github", "needs", "strategy", "matrix", "job", "runner", "env", "vars", "secrets", "steps", "inputs"],
    "step-if": ["github", "needs", "strategy", "matrix", "job", "runner", "env", "vars", "steps", "inputs"],
    "step": ["github", "needs", "strategy", "matrix", "job", "runner", "env", "vars", "secrets", "steps", "inputs"],
    "call": ["github", "needs", "strategy", "matrix", "vars", "secrets", "inputs"]
  };

  function validate(wf, file) {
    const errs = [];
    const add = (obj, key, msg) => { const p = at(obj, key); errs.push(p ? `The workflow is not valid. ${file} (Line: ${p.line}, Col: ${p.col}): ${msg}` : `The workflow is not valid. ${file}: ${msg}`); };
    const unexpected = (obj, allowed) => keys(obj).forEach((k) => { if (!allowed.includes(k)) add(obj, k, `Unexpected value '${k}'`); });
    const exprCheck = (obj, key, where, whole) => {
      const v = obj[key];
      const list = whole ? [ifExpr(v)] : typeof v === "string" ? exprsIn(v) : [];
      for (const e of list) {
        if (!e) continue;
        try {
          for (const n of namesIn(e)) {
            if (n.kind === "ctx" && !ALLOWED[where].includes(n.name)) { add(obj, key, `Unrecognized named-value: '${n.raw}'. Located at position ${n.pos} within expression: ${e}`); break; }
            if (n.kind === "call" && (!FUNCS.includes(n.name) || (n.name === "hashfiles" && !/^step/.test(where)))) { add(obj, key, `Unrecognized function: '${n.raw}'. Located at position ${n.pos} within expression: ${e}`); break; }
          }
        } catch (err) { if (err instanceof ExprError) add(obj, key, err.message); else throw err; }
      }
    };
    const deep = (obj, where) => { if (isObj(obj)) for (const k of keys(obj)) (isObj(obj[k]) ? deep(obj[k], where) : exprCheck(obj, k, where)); };

    if (!isObj(wf)) return [`The workflow is not valid. ${file}: No event triggers defined in \`on\``];
    unexpected(wf, TOP);
    const on = wf.on;
    if (on == null || (Array.isArray(on) && !on.length) || (isObj(on) && !keys(on).length)) errs.push(`The workflow is not valid. ${file}: No event triggers defined in \`on\``);
    else {
      const list = typeof on === "string" ? [on] : Array.isArray(on) ? on.map(toStr) : keys(on);
      for (const ev of list) if (!EVENTS.includes(ev)) (isObj(on) ? add(on, ev, `Unexpected value '${ev}'`) : add(wf, "on", `Unexpected value '${ev}'`));
      if (isObj(on)) for (const ev of ["push", "pull_request", "pull_request_target"]) {
        const f = on[ev];
        if (!isObj(f)) continue;
        for (const [a, b] of [["branches", "branches-ignore"], ["tags", "tags-ignore"], ["paths", "paths-ignore"]]) {
          if (a in f && b in f) add(f, b, `you may only define one of \`${a}\` and \`${b}\` for a single event`);
        }
      }
      if (isObj(on) && isObj(on.workflow_dispatch) && isObj(on.workflow_dispatch.inputs)) {
        for (const [name, inp] of Object.entries(on.workflow_dispatch.inputs)) {
          if (isObj(inp) && inp.type === "choice" && !Array.isArray(inp.options)) add(on.workflow_dispatch.inputs, name, "Required property is missing: options");
        }
      }
    }
    if (isObj(wf.env)) deep(wf.env, "workflow-env");
    checkPermissions(wf, "permissions", add);
    if (!("jobs" in wf)) errs.push(`The workflow is not valid. ${file} (Line: 1, Col: 1): Required property is missing: jobs`);
    else if (!isObj(wf.jobs) || !keys(wf.jobs).length) add(wf, "jobs", "Required property is missing: jobs");
    const jobs = isObj(wf.jobs) ? wf.jobs : {};
    for (const [id, job] of Object.entries(jobs)) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) || id.length >= 100) {
        add(jobs, id, `The identifier '${id}' is invalid. IDs may only contain alphanumeric characters, '_', and '-'. IDs must start with a letter or '_' and must be less than 100 characters.`);
        continue;
      }
      if (!isObj(job)) { add(jobs, id, `Unexpected value '${toStr(job)}'`); continue; }
      unexpected(job, job.uses != null ? ["name", "uses", "with", "secrets", "needs", "if", "permissions", "strategy", "concurrency"] : JOB);
      if (job.uses == null && !("runs-on" in job)) add(jobs, id, "Required property is missing: runs-on");
      if (job.uses == null && !("steps" in job)) add(jobs, id, "Required property is missing: steps");
      for (const n of [].concat(job.needs == null ? [] : job.needs)) {
        if (!(toStr(n) in jobs)) add(job, "needs", `Job '${id}' depends on unknown job '${toStr(n)}'.`);
      }
      if ("if" in job) exprCheck(job, "if", "job-if", true);
      for (const k of ["runs-on", "timeout-minutes", "environment", "name", "continue-on-error"]) if (k in job) (isObj(job[k]) ? deep(job[k], "job") : exprCheck(job, k, "job"));
      if (isObj(job.concurrency)) deep(job.concurrency, "job"); else if ("concurrency" in job) exprCheck(job, "concurrency", "job");
      if (isObj(job.env)) deep(job.env, "job-env");
      if (isObj(job.outputs)) deep(job.outputs, "job-outputs");
      if (isObj(job.with)) deep(job.with, "call");
      checkPermissions(job, "permissions", add);
      if (job.uses != null) continue;
      if (!Array.isArray(job.steps)) { if ("steps" in job) add(job, "steps", "Unexpected value '" + toStr(job.steps) + "'"); continue; }
      const ids = new Set();
      job.steps.forEach((step, i) => {
        if (!isObj(step)) { add(job.steps, i, `Unexpected value '${toStr(step)}'`); return; }
        unexpected(step, STEP);
        if (step.uses == null && step.run == null) add(job.steps, i, "There's not enough info to determine what you meant. Add one of these properties: run, uses");
        if (step.uses != null && step.run != null) add(step, "run", "Unexpected value 'run'");
        if (step.uses != null && !/^(\.\/|docker:\/\/)/.test(toStr(step.uses)) && !/^[^/@\s]+\/[^@\s]+@\S+$/.test(toStr(step.uses))) {
          add(step, "uses", `Expected format {org}/{repo}[/path]@ref. Actual '${toStr(step.uses)}'`);
        }
        if (step.id != null) {
          if (ids.has(toStr(step.id))) add(step, "id", `The identifier '${toStr(step.id)}' may not be used more than once within the same scope.`);
          ids.add(toStr(step.id));
        }
        if ("if" in step) exprCheck(step, "if", "step-if", true);
        for (const k of ["run", "name", "uses", "shell", "working-directory", "timeout-minutes", "continue-on-error"]) if (k in step) exprCheck(step, k, "step");
        if (isObj(step.with)) deep(step.with, "step");
        if (isObj(step.env)) deep(step.env, "step");
      });
    }
    // A cycle in needs.
    const seen = new Map();
    const visit = (id, trail) => {
      if (seen.get(id) === 2) return;
      if (seen.get(id) === 1) { const from = trail[trail.length - 1]; add(jobs[from], "needs", `Job '${from}' depends on job '${id}' which creates a cycle in the dependency graph.`); return; }
      seen.set(id, 1);
      const job = jobs[id];
      for (const n of isObj(job) ? [].concat(job.needs == null ? [] : job.needs).map(toStr) : []) if (n in jobs) visit(n, [...trail, id]);
      seen.set(id, 2);
    };
    if (!errs.length) keys(jobs).forEach((id) => visit(id, []));
    return [...new Set(errs)];
  }

  function checkPermissions(obj, key, add) {
    const p = obj[key];
    if (p === undefined) return;
    if (typeof p === "string") { if (!/^(read-all|write-all)$/.test(p)) add(obj, key, `Unexpected value '${p}'`); return; }
    if (p === null || (isObj(p) && !keys(p).length)) return;
    if (!isObj(p)) { add(obj, key, `Unexpected value '${toStr(p)}'`); return; }
    for (const [scope, level] of Object.entries(p)) {
      if (!SCOPES.includes(scope)) add(p, scope, `Unexpected value '${scope}'`);
      else if (!(scope === "id-token" ? ["write", "none"] : scope === "models" ? ["read", "none"] : ["read", "write", "none"]).includes(toStr(level))) add(p, scope, `Unexpected value '${toStr(level)}'`);
    }
  }

  // --- events -------------------------------------------------------------------------

  // The events the playground can send. A scenario may change their details.
  const EVENT_TYPES = {
    push: { label: "Push to main", name: "push", ref: "refs/heads/main", changed: ["src/cart.js"], message: "Fix the cart total" },
    "push-branch": { label: "Push to feature/login", name: "push", ref: "refs/heads/feature/login", changed: ["src/login.js"], message: "Add the login form" },
    "push-docs": { label: "Push a docs-only change", name: "push", ref: "refs/heads/main", changed: ["docs/setup.md"], message: "Update the setup guide" },
    "pr-docs": { label: "Pull request changing only docs", name: "pull_request", ref: "refs/pull/46/merge", head: "docs/typo", changed: ["docs/setup.md"], title: "Fix a typo in the setup guide", number: 46 },
    "merge-queue": { label: "Merge queue checks the pull request", name: "merge_group", ref: "refs/heads/gh-readonly-queue/main/pr-42-5d6e7f8", head: "feature/login", changed: ["src/login.js"], title: "Add the login form", number: 42 },
    "push-tag": { label: "Push tag v1.4.0", name: "push", ref: "refs/tags/v1.4.0", changed: [], message: "Release 1.4.0" },
    pr: { label: "Pull request from a branch", name: "pull_request", ref: "refs/pull/42/merge", head: "feature/login", changed: ["src/login.js"], title: "Add the login form", number: 42 },
    fork: { label: "Pull request from a fork", name: "pull_request", ref: "refs/pull/43/merge", head: "patch-1", fork: true, changed: ["src/cart.js"], title: "Fix typo in the cart", number: 43 },
    "prt-fork": { label: "Fork pull request (pull_request_target)", name: "pull_request_target", ref: "refs/heads/main", head: "patch-1", fork: true, changed: ["package.json"], title: "Update dependencies", number: 44 },
    dispatch: { label: "Run workflow (workflow_dispatch)", name: "workflow_dispatch", ref: "refs/heads/main", changed: [] },
    schedule: { label: "Schedule fires", name: "schedule", ref: "refs/heads/main", changed: [] },
    "pr-twice": { label: "Two pushes to a pull request, 30 seconds apart", name: "pull_request", ref: "refs/pull/42/merge", head: "feature/login", changed: ["src/login.js"], title: "Add the login form", number: 42, twice: true },
    dependabot: { label: "Dependabot pull request", name: "pull_request", ref: "refs/pull/45/merge", head: "dependabot/npm_and_yarn/vite-7.1.1", changed: ["package.json", "package-lock.json"], title: "Bump vite from 7.1.0 to 7.1.1", number: 45, dependabot: true },
    "push-twice": { label: "Two pushes, 30 seconds apart", name: "push", ref: "refs/heads/main", changed: ["src/cart.js"], message: "Fix the cart total", twice: true }
  };

  function eventFor(world, id, inputs) {
    const base = EVENT_TYPES[id] || EVENT_TYPES.push;
    const ev = { id, ...base, ...((world.events || {})[id] || {}) };
    ev.inputs = inputs || {};
    ev.branch = ev.ref.startsWith("refs/heads/") ? ev.ref.slice(11) : null;
    ev.tag = ev.ref.startsWith("refs/tags/") ? ev.ref.slice(10) : null;
    ev.base = ev.name.startsWith("pull_request") || ev.name === "merge_group" ? world.repo.defaultBranch : null;
    return ev;
  }

  // Does this event trigger the workflow? Returns null, or why not.
  function notTriggered(wf, ev) {
    const on = wf.on;
    const list = typeof on === "string" ? [on] : Array.isArray(on) ? on.map(toStr) : keys(on);
    if (!list.includes(ev.name)) return `This workflow has no \`${ev.name}\` trigger, so the ${ev.name} event does not start it.`;
    const f = isObj(on) ? on[ev.name] : null;
    if (ev.name === "schedule" && !(isObj(on) && Array.isArray(on.schedule) && on.schedule.some((s) => isObj(s) && s.cron))) return "The schedule trigger has no cron entry.";
    if (!isObj(f)) return null;
    if (ev.name === "push") {
      const branchF = "branches" in f || "branches-ignore" in f, tagF = "tags" in f || "tags-ignore" in f;
      if (ev.tag) {
        if (branchF && !tagF) return `Tag ${ev.tag} was pushed, but this push trigger lists only branches, so tags do not start it.`;
        if ("tags" in f && !filterMatch(f.tags, ev.tag)) return `Tag ${ev.tag} does not match \`tags\`.`;
        if ("tags-ignore" in f && filterMatch(f["tags-ignore"], ev.tag)) return `Tag ${ev.tag} matches \`tags-ignore\`.`;
        return null; // paths filters are not evaluated for tags
      }
      if (tagF && !branchF) return `A push to ${ev.branch} does not start a push trigger that lists only tags.`;
      if ("branches" in f && !filterMatch(f.branches, ev.branch)) return `Branch ${ev.branch} does not match \`branches: ${JSON.stringify([].concat(f.branches))}\`.`;
      if ("branches-ignore" in f && filterMatch(f["branches-ignore"], ev.branch)) return `Branch ${ev.branch} matches \`branches-ignore\`.`;
    }
    if (ev.name === "merge_group") {
      if (f.types && ![].concat(f.types).map(toStr).includes("checks_requested")) return "The merge queue sends checks_requested, which is not in `types`.";
      if ("branches" in f && !filterMatch(f.branches, ev.base)) return `The merge queue targets ${ev.base}, which does not match \`branches\`.`;
      return null;
    }
    if (ev.name.startsWith("pull_request")) {
      const types = f.types ? [].concat(f.types).map(toStr) : ["opened", "synchronize", "reopened"];
      if (!types.includes("opened") && !types.includes("synchronize")) return `The pull request was opened, which is not in \`types: ${JSON.stringify(types)}\`.`;
      if ("branches" in f && !filterMatch(f.branches, ev.base)) return `The pull request targets ${ev.base}, which does not match \`branches\`.`;
      if ("branches-ignore" in f && filterMatch(f["branches-ignore"], ev.base)) return `The pull request targets ${ev.base}, which matches \`branches-ignore\`.`;
    }
    if (ev.name === "push" || ev.name.startsWith("pull_request")) {
      if ("paths" in f && !ev.changed.some((p) => filterMatch(f.paths, p))) return `None of the changed files (${ev.changed.join(", ")}) match \`paths: ${JSON.stringify([].concat(f.paths))}\`.`;
      if ("paths-ignore" in f && ev.changed.length && ev.changed.every((p) => filterMatch(f["paths-ignore"], p))) return `Every changed file matches \`paths-ignore\`.`;
    }
    return null;
  }

  // --- the GITHUB_TOKEN ---------------------------------------------------------------

  const PERM_LABEL = (s) => s.split("-").map((w) => (w === "id" ? "Id" : w[0].toUpperCase() + w.slice(1))).join("").replace("IdToken", "IdToken");
  function tokenPermissions(world, wfPerm, jobPerm, ev) {
    const spec = jobPerm !== undefined ? jobPerm : wfPerm;
    let p;
    if (spec === undefined) {
      p = world.repo.permissive ? Object.fromEntries(SCOPES.filter((s) => s !== "id-token" && s !== "models").map((s) => [s, "write"])) : { contents: "read", packages: "read" };
    } else if (spec === "read-all") p = Object.fromEntries(SCOPES.filter((s) => s !== "id-token").map((s) => [s, "read"]));
    else if (spec === "write-all") p = Object.fromEntries(SCOPES.map((s) => [s, s === "models" ? "read" : "write"]));
    else p = isObj(spec) ? Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, toStr(v)]).filter(([, v]) => v !== "none")) : {};
    if ((ev.fork && ev.name === "pull_request") || ev.dependabot) {
      for (const k of Object.keys(p)) if (p[k] === "write") p[k] = "read";
      delete p["id-token"];
    }
    p.metadata = "read";
    return p;
  }
  const can = (perms, scope, level) => perms[scope] === "write" || (level === "read" && perms[scope] === "read");

  // --- actions ---------------------------------------------------------------------------

  // Real versions and the Node.js runtime each one declares in its action.yml.
  const SHAS = {
    "actions/checkout": { "v6.1.0": "d23441a48e516b6c34aea4fa41551a30e30af803", "v6.0.2": "de0fac2e4500dabe0009e67214ff5f5447ce83dd", "v5.1.0": "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09", "v7.0.1": "3d3c42e5aac5ba805825da76410c181273ba90b1" },
    "actions/setup-node": { "v6.5.0": "249970729cb0ef3589644e2896645e5dc5ba9c38", "v7.1.0": "949feb2413d6458794dcd2491c4babbbce0c15c1" },
    "actions/setup-python": { "v6.3.0": "ece7cb06caefa5fff74198d8649806c4678c61a1", "v7.1.0": "6d4fd22b20465ccc0f7354476588e8df7c9ca0e0" },
    "actions/cache": { "v5.1.0": "caa296126883cff596d87d8935842f9db880ef25", "v6.1.0": "55cc8345863c7cc4c66a329aec7e433d2d1c52a9" },
    "actions/upload-artifact": { "v6.0.0": "b7c566a772e6b6bfb58ed0dc250532a479d7789f", "v7.0.2": "cf430e030ddbb5b0abf93d22962f4752f3646cd9" },
    "actions/download-artifact": { "v7.0.0": "37930b1c2abaa49bbe596cd826c3c89aef350131", "v8.0.2": "9000827ccba6bdab643e8b6fd33ac0654aef8333" },
    "aws-actions/configure-aws-credentials": { "v6.3.0": "e1253824e5c10ff9df46874f81ed3ec929e19cfd" }
  };
  // [first major, last major, runtime by major]
  const RUNTIMES = {
    "actions/checkout": { 2: "node12", 3: "node16", 4: "node20", 5: "node24", 6: "node24", 7: "node24" },
    "actions/setup-node": { 3: "node16", 4: "node20", 5: "node24", 6: "node24", 7: "node24" },
    "actions/setup-python": { 4: "node16", 5: "node20", 6: "node24", 7: "node24" },
    "actions/setup-java": { 4: "node20", 5: "node24" },
    "actions/cache": { 3: "node20", 4: "node20", 5: "node24", 6: "node24" },
    "actions/upload-artifact": { 3: "node20", 4: "node20", 5: "node20", 6: "node24", 7: "node24" },
    "actions/download-artifact": { 3: "node20", 4: "node20", 5: "node20", 6: "node20", 7: "node24", 8: "node24" },
    "aws-actions/configure-aws-credentials": { 4: "node20", 5: "node20", 6: "node24" },
    "github/codeql-action/init": { 3: "node20", 4: "node24" },
    "github/codeql-action/analyze": { 3: "node20", 4: "node24" },
    "actions/github-script": { 7: "node20", 8: "node24" }
  };
  const OFFICIAL_OWNERS = ["actions", "aws-actions", "github"];

  // Resolve "owner/repo[/path]@ref": {name, ref, runtime, sha} or {error}.
  function resolveAction(uses, world) {
    const m = /^([^/@]+\/[^/@]+)(\/[^@]*)?@(.+)$/.exec(uses);
    if (!m) return { error: `Expected format {org}/{repo}[/path]@ref. Actual '${uses}'` };
    const name = m[1] + (m[2] || ""), ref = m[3];
    const custom = (world.actions || {})[m[1]];
    if (custom) {
      const r = custom.refs[ref];
      if (!r) return { error: `Unable to resolve action \`${uses}\`, unable to find version \`${ref}\`` };
      return { name, ref, runtime: "node24", sha: r.sha, custom: r, repo: m[1] };
    }
    const table = RUNTIMES[name];
    if (!table) {
      if (OFFICIAL_OWNERS.includes(m[1].split("/")[0])) return { error: `Unable to resolve action \`${uses}\`, repository not found` };
      return { name, ref, runtime: "node24", sha: /^[0-9a-f]{40}$/.test(ref) ? ref : hash(uses), unknown: true, repo: m[1] };
    }
    const shas = SHAS[name] || {};
    const bySha = Object.entries(shas).find(([, s]) => s === ref);
    let major;
    if (bySha) major = Number(/^v(\d+)/.exec(bySha[0])[1]);
    else if (/^[0-9a-f]{40}$/.test(ref)) major = Math.max(...Object.keys(table).map(Number));
    else { const v = /^v(\d+)(\.\d+){0,2}$/.exec(ref); major = v ? Number(v[1]) : null; }
    if (major == null || !table[major]) return { error: `Unable to resolve action \`${uses}\`, unable to find version \`${ref}\`` };
    return { name, ref, runtime: table[major], major, sha: shas[ref] || (bySha ? ref : /^[0-9a-f]{40}$/.test(ref) ? ref : hash(uses)), repo: m[1] };
  }

  const NODE20_WARNING = (list) => `Node.js 20 actions are deprecated. The following actions are running on Node.js 20 and may not work as expected: ${list.join(", ")}. ` +
    "Actions will be forced to run with Node.js 24 by default starting June 16th, 2026. Node.js 20 will be removed from the runner on September 23rd, 2026. Please check if updated versions of these actions are available that support Node.js 24. " +
    "To opt into Node.js 24 now, set the FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true environment variable on the runner or in your workflow file. " +
    "Once Node.js 24 becomes the default, you can temporarily opt out by setting ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true. " +
    "For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/";
  const ARTIFACT_V3 = (name) => `This request has been automatically failed because it uses a deprecated version of \`${name}: v3\`. Learn more: https://github.blog/changelog/2024-04-16-deprecation-notice-v3-of-the-artifact-actions/`;

  // What each action does. sx is the running job; w is its evaluated "with".
  const ACTIONS = {
    "actions/checkout": (sx, w) => {
      const ref = toStr(w.ref);
      const pr = sx.ev.number != null;
      const head = pr && ref && (ref.includes(sx.github.event.pull_request.head.sha) || ref === sx.github.event.pull_request.head.ref || /refs\/pull\/\d+\/(head|merge)/.test(ref));
      const repo = toStr(w.repository) || FULL;
      sx.ws = { ...sx.world.repo.files, ...sx.files, ...(head || (sx.ev.fork && sx.ev.name === "pull_request") ? sx.world.forkFiles || {} : {}) };
      if (head && sx.ev.name === "pull_request_target") sx.untrusted = true;
      sx.fetchDepth = w["fetch-depth"] == null ? 1 : Number(w["fetch-depth"]);
      // A token other than the GITHUB_TOKEN is kept for later pushes; their events start workflows.
      sx.pushToken = w.token && toStr(w.token) !== sx.secrets.GITHUB_TOKEN ? (toStr(w.token) ? "other" : "empty") : "github";
      const lfs = w.lfs === true || toStr(w.lfs) === "true";
      if (lfs) Object.assign(sx.ws, sx.world.lfs || {});
      sx.persisted = w["persist-credentials"] !== false && toStr(w["persist-credentials"]) !== "false";
      return { lines: [`Syncing repository: ${repo}`, "Getting Git version info", `Temporarily overriding HOME='/home/runner/work/_temp/7d3a' before making global git config changes`,
        `Adding repository directory to the temporary git global config as a safe directory`, `/usr/bin/git config --global --add safe.directory ${WORK}`,
        `Deleting the contents of '${WORK}'`, "Initializing the repository", "Fetching the repository",
        head ? `Determining the checkout info` : "Determining the checkout info", `Checking out the ref`,
        ...(lfs ? ["Fetching LFS objects", "/usr/bin/git lfs fetch origin " + (sx.github.sha || "")] : []),
        `/usr/bin/git log -1 --format=%H`, head ? sx.github.event.pull_request.head.sha : sx.github.sha], secs: lfs ? 6 : 2 };
    },
    "actions/setup-node": (sx, w) => {
      const v = toStr(w["node-version"] || (sx.ws && sx.ws[".nvmrc"]) || "").trim();
      const major = /^(lts\/\*|node|latest)$/.test(v) ? 24 : Number((/^v?(\d+)/.exec(v) || [])[1]);
      if (!v) return { lines: ["Attempting to resolve the latest version from the manifest...", "##[warning]The `node-version` input is not supplied. Using the Node.js version that is installed on the runner."], secs: 1, node: 22 };
      if (!(major >= 18 && major <= 26 && major % 2 === 0)) return { fail: [`Unable to find Node version '${v}' for platform linux and architecture x64.`] };
      sx.node = major;
      const lines = [`Attempting to download ${v}...`, `Acquiring ${major}.${major === 24 ? "11.1" : "20.0"} - x64 from https://github.com/actions/node-versions/releases/download/...`, "Extracting ...", "Adding to the cache ...",
        "Environment details", `  node: v${major}.${major === 24 ? "11.1" : "20.0"}`, "  npm: 10.9.2"];
      if (w.cache) {
        const pm = toStr(w.cache);
        if (!/^(npm|yarn|pnpm)$/.test(pm)) return { fail: [`Caching for '${pm}' is not supported`] };
        const lock = w["cache-dependency-path"] ? toStr(w["cache-dependency-path"]) : ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock"].find((f) => sx.ws && f in sx.ws);
        if (!lock) return { fail: [`Dependencies lock file is not found in ${WORK}. Supported file patterns: package-lock.json,npm-shrinkwrap.json,yarn.lock`] };
        const h = hashFilesIn(sx.ws, [lock]);
        if (!h) return { fail: ["Some specified paths were not resolved, unable to cache dependencies."] };
        const key = `node-cache-Linux-x64-${pm}-${h}`;
        const hit = sx.cacheGet(key, []);
        lines.push(hit ? `Cache restored from key: ${key}` : `${pm} cache is not found`);
        if (hit) sx.npmCache = true;
        sx.post.push({ name: "Post Run actions/setup-node", run: () => saveCache(sx, key, hit === key, `Cache saved with the key: ${key}`) });
      }
      return { lines, secs: 3 };
    },
    "actions/setup-python": (sx, w) => {
      const v = toStr(w["python-version"]);
      const known = ["3.9", "3.10", "3.11", "3.12", "3.13", "3.14", "3.x", "pypy3.10", "pypy3.11"];
      if (!v) return { lines: ["Python is installed on the runner: 3.12.3"], secs: 1 };
      if (!known.includes(v) && !/^3\.(9|1[0-4])\.\d+$/.test(v)) {
        return { fail: [`The version '${v}' with architecture 'x64' was not found for Ubuntu 24.04.`, "The list of all available versions can be found here: https://raw.githubusercontent.com/actions/python-versions/main/versions-manifest.json"] };
      }
      sx.python = v;
      const lines = [`Installed versions`, `  Successfully set up CPython (${v === "3.x" ? "3.14.0" : v.split(".").length === 2 ? v + ".9" : v})`];
      if (w.cache) {
        const dep = toStr(w["cache-dependency-path"] || "**/requirements.txt");
        const h = hashFilesIn(sx.ws || {}, dep.split("\n").filter(Boolean)) || (!w["cache-dependency-path"] && hashFilesIn(sx.ws || {}, ["**/pyproject.toml"]));
        if (!h) return { fail: [`No file in ${WORK} matched to [${dep.split("\n").filter(Boolean).join(",")}${w["cache-dependency-path"] ? "" : " or **/pyproject.toml"}], make sure you have checked out the target repository`] };
        const key = `setup-python-Linux-x64-24.04-Ubuntu-python-${v}-pip-${h}`;
        const hit = sx.cacheGet(key, []);
        lines.push(hit ? `Cache restored from key: ${key}` : "pip cache is not found");
        sx.post.push({ name: "Post Run actions/setup-python", run: () => saveCache(sx, key, hit === key, `Cache saved with the key: ${key}`) });
      }
      return { lines, secs: 4 };
    },
    "actions/cache": (sx, w) => {
      const key = toStr(w.key);
      if (!w.path) return { fail: ["Input required and not supplied: path"] };
      if (!key) return { fail: ["Input required and not supplied: key"] };
      const restore = toStr(w["restore-keys"]).split("\n").map((s) => s.trim()).filter(Boolean);
      const hit = sx.cacheGet(key, restore);
      const paths = toStr(w.path).split("\n").map((s) => s.trim()).filter(Boolean);
      if (hit && paths.some((p) => /node_modules|\.npm/.test(p))) sx.npmCache = true;
      if (hit && paths.some((p) => /\.cache\/pip/.test(p))) sx.pipCache = true;
      sx.post.push({ name: `Post Run ${sx.stepUses}`, run: () => saveCache(sx, key, hit === key, `Cache saved with key: ${key}`) });
      return { lines: hit ? [`Cache restored from key: ${hit}`] : [`Cache not found for input keys: ${[key, ...restore].join(", ")}`], secs: hit ? 4 : 1, outputs: { "cache-hit": hit === key ? "true" : "false" } };
    },
    "actions/upload-artifact": (sx, w, a) => {
      if (a.major === 3) return { fail: [ARTIFACT_V3("actions/upload-artifact")], setup: true };
      const name = toStr(w.name) || "artifact";
      const paths = toStr(w.path).split("\n").map((s) => s.trim()).filter(Boolean);
      const files = Object.keys(sx.ws || {}).filter((f) => paths.some((p) => f === p || f.startsWith(p.replace(/\/?$/, "/")) || globRe(p).test(f)));
      const mode = toStr(w["if-no-files-found"] || "warn");
      if (!files.length) {
        const msg = `No files were found with the provided path: ${paths.join("\n")}. No artifacts will be uploaded.`;
        return mode === "error" ? { fail: [msg] } : { lines: mode === "warn" ? [["Warning: " + msg, "warn"]] : [msg], secs: 1, warn: mode === "warn" ? msg : null };
      }
      if (sx.artifacts[name] && w.overwrite !== true && toStr(w.overwrite) !== "true") return { fail: ["Failed to CreateArtifact: Received non-retryable error: Failed request: (409) Conflict: an artifact with this name already exists on the workflow run"] };
      // Files are stored relative to the directory that was uploaded.
      const dirs = paths.filter((p) => !(p in sx.ws)).map((p) => p.replace(/\/?$/, "/"));
      const rel = (f) => { const d = paths.length === 1 && dirs.find((x) => f.startsWith(x)); return d ? f.slice(d.length) : f; };
      sx.artifacts[name] = Object.fromEntries(files.map((f) => [rel(f), sx.ws[f]]));
      const id = 4100000000 + Object.keys(sx.artifacts).length;
      const size = files.reduce((n, f) => n + String(sx.ws[f]).length, 0) + 380;
      return { lines: [`With the provided path, there will be ${files.length} file${files.length === 1 ? "" : "s"} uploaded`, "Artifact name is valid!", "Root directory input is valid!",
        "Beginning upload of artifact content to blob storage", `Uploaded bytes ${size}`, "Finished uploading artifact content to blob storage!", "Finalizing artifact upload",
        `Artifact ${name}.zip successfully finalized. Artifact ID ${id}`, `Artifact ${name} has been successfully uploaded! Final size is ${size} bytes. Artifact ID is ${id}`,
        `Artifact download URL: https://github.com/${FULL}/actions/runs/${sx.github.run_id}/artifacts/${id}`], secs: 2, outputs: { "artifact-id": String(id) } };
    },
    "actions/download-artifact": (sx, w, a) => {
      if (a.major === 3) return { fail: [ARTIFACT_V3("actions/download-artifact")], setup: true };
      const name = toStr(w.name);
      const pick = name ? (sx.artifacts[name] ? { [name]: sx.artifacts[name] } : null) : sx.artifacts;
      if (!pick) return { fail: [`Unable to download artifact(s): Artifact '${name}' not found`], lines: ["Downloading single artifact"] };
      const dest = toStr(w.path);
      sx.ws = sx.ws || {};
      // One named artifact lands in path; with no name, each gets a folder of its own.
      for (const [n, files] of Object.entries(pick)) for (const [f, c] of Object.entries(files)) sx.ws[(dest ? dest.replace(/\/?$/, "/") : "") + (name ? "" : n + "/") + f] = c;
      const list = Object.keys(pick);
      return { lines: [name ? "Downloading single artifact" : "No input name, artifact-ids or pattern filtered specified, downloading all artifacts", "Preparing to download the following artifacts:",
        ...list.map((n, i) => `- ${n} (ID: ${4100000001 + i}, Size: 1024, Expected Digest: sha256:${hash(n).slice(0, 32)})`), `Total of ${list.length} artifact(s) downloaded`,
        "Download artifact has finished successfully"], secs: 2 };
    },
    "aws-actions/configure-aws-credentials": (sx, w) => {
      const role = toStr(w["role-to-assume"]);
      const region = toStr(w["aws-region"]);
      if (!region) return { fail: ["Input required and not supplied: aws-region"] };
      if (!role) return { fail: ["Credentials could not be loaded, please check your action inputs: Could not load credentials from any providers"] };
      if (!can(sx.perms, "id-token", "write")) {
        return { lines: ["It looks like you might be trying to authenticate with OIDC. Did you mean to set the `id-token` permission? If you are not trying to authenticate with OIDC and the action is working successfully, you can ignore this message."],
          fail: ["Credentials could not be loaded, please check your action inputs: Could not load credentials from any providers"] };
      }
      const sub = sx.oidcSub();
      const trust = sx.world.trustFile ? sx.files[sx.world.trustFile] : null;
      const roles = sx.world.roles || {};
      const r = roles[role];
      const ok = r && trustAllows(trust || r.trust, sub, toStr(w.audience || "sts.amazonaws.com"));
      sx.oidc.push({ role, sub, ok });
      if (!ok) return { lines: ["Assuming role with OIDC"], fail: ["Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity"] };
      sx.aws = { role, account: role.split(":")[4] || "123456789012" };
      sx.secretValues.push("ASIA_PLAYGROUND_ONLY");
      return { lines: ["Assuming role with OIDC", `Authenticated as assumedRoleId AROA_PLAYGROUND:GitHubActions`], secs: 2 };
    }
  };

  // Caches are immutable: an exact hit is not saved again, and a key another job saved first cannot be.
  function saveCache(sx, key, exact, saved) {
    if (exact) return [`Cache hit occurred on the primary key ${key}, not saving cache.`];
    if (sx.cacheHas(key)) return [["Warning: Failed to save: Failed to CreateCacheEntry: Received non-retryable error: Failed request: (409) Conflict: cache entry with the same key, version, and scope already exists", "warn"]];
    sx.cacheSet(key);
    return [saved];
  }

  // A trust policy as JSON (string) or object: does it let this sub assume the role?
  function trustAllows(policy, sub, aud) {
    let doc = policy;
    if (typeof policy === "string") { try { doc = JSON.parse(policy); } catch { return false; } }
    const stmts = isObj(doc) ? [].concat(doc.Statement || []) : [];
    return stmts.some((s) => {
      if (!isObj(s) || s.Effect !== "Allow" || ![].concat(s.Action || []).includes("sts:AssumeRoleWithWebIdentity")) return false;
      const fed = isObj(s.Principal) ? toStr(s.Principal.Federated) : "";
      if (!fed.endsWith("oidc-provider/token.actions.githubusercontent.com")) return false;
      const cond = isObj(s.Condition) ? s.Condition : {};
      const check = (op, claim, val) => {
        const block = cond[op];
        if (!isObj(block) || !(claim in block)) return null;
        return [].concat(block[claim]).some((p) => (op === "StringLike" ? globRe(toStr(p).replace(/\*/g, "**")).test(val) : toStr(p) === val));
      };
      const audOk = [check("StringEquals", "token.actions.githubusercontent.com:aud", aud), check("StringLike", "token.actions.githubusercontent.com:aud", aud)];
      const subOk = [check("StringEquals", "token.actions.githubusercontent.com:sub", sub), check("StringLike", "token.actions.githubusercontent.com:sub", sub)];
      return !audOk.includes(false) && !subOk.includes(false) && subOk.some((x) => x !== null);
    });
  }

  // hashFiles(): a hash of every matching file, or '' when none match.
  function hashFilesIn(ws, patterns) {
    const files = Object.keys(ws || {}).filter((f) => filterMatch(patterns.map((p) => p.replace(/^\.\//, "")), f)).sort();
    return files.length ? hash(files.map((f) => f + "\0" + ws[f]).join("\0")).slice(0, 64).padEnd(64, "0") : "";
  }

  // --- the shell ------------------------------------------------------------------------

  // Words are lists of [text, quote] parts; operators are strings.
  function shellTokens(line) {
    const out = [];
    let word = null, i = 0;
    const push = (t, q) => { if (!word) word = []; word.push([t, q]); };
    const end = () => { if (word) out.push(word); word = null; };
    while (i < line.length) {
      const c = line[i];
      if (c === "'") { const j = line.indexOf("'", i + 1); if (j < 0) throw new ShellSyntax("unexpected EOF while looking for matching `''"); push(line.slice(i + 1, j), "'"); i = j + 1; continue; }
      if (c === '"') {
        let j = i + 1, s = "";
        while (j < line.length && line[j] !== '"') { if (line[j] === "\\" && j + 1 < line.length) { s += /["\\$`]/.test(line[j + 1]) ? line[j + 1] : "\\" + line[j + 1]; j += 2; continue; } s += line[j++]; }
        if (j >= line.length) throw new ShellSyntax("unexpected EOF while looking for matching `\"'");
        push(s, '"'); i = j + 1; continue;
      }
      if (c === "$" && line[i + 1] === "(") {
        let depth = 0, j = i + 1;
        for (; j < line.length; j++) { if (line[j] === "(") depth++; else if (line[j] === ")" && --depth === 0) break; }
        push(line.slice(i, j + 1), ""); i = j + 1; continue;
      }
      if (c === "\\" && i + 1 < line.length) { push(line[i + 1], "'"); i += 2; continue; }
      if (/\s/.test(c)) { end(); i++; continue; }
      if (c === "#" && !word) break;
      const op = /^(&&|\|\||2>&1|2>>|2>|>>|&>|<<-?|[;|&<>])/.exec(line.slice(i));
      if (op) { end(); out.push(op[0]); i += op[0].length; continue; }
      push(c, ""); i++;
    }
    end();
    return out;
  }

  const headOf = (list) => (list.length && typeof list[0] !== "string" ? list[0].map((p) => p[0]).join("") : "");

  // Split a script into statements: and-or lists, with their line and any here-document.
  function statements(script) {
    const src = script.replace(/\\\n/g, " ").split("\n");
    const out = [];
    for (let n = 0; n < src.length; n++) {
      let text = src[n];
      const ln = n + 1;
      const hd = /<<-?\s*['"]?(\w+)['"]?/.exec(text);
      let stdin = null;
      if (hd) {
        const body = [];
        n++;
        while (n < src.length && src[n].trim() !== hd[1]) body.push(src[n++]);
        stdin = body.join("\n") + "\n";
        text = text.replace(hd[0], "");
      }
      const lists = [[]];
      const bg = [];
      for (const t of shellTokens(text)) { if (t === ";" || t === "&") { bg[lists.length - 1] = t === "&"; lists.push([]); } else lists[lists.length - 1].push(t); }
      lists.forEach((list, i) => {
        // Keywords that carry a command after them (then echo, do echo) become two statements.
        let rest = list;
        while (/^(then|do|else)$/.test(headOf(rest))) { out.push({ kw: headOf(rest), ln }); rest = rest.slice(1); }
        if (!rest.length) return;
        const head = headOf(rest);
        if (/^(fi|done)$/.test(head)) out.push({ kw: head, ln });
        else if (/^(if|elif|while|until|for)$/.test(head)) out.push({ kw: head, list: rest.slice(1), ln });
        else out.push({ list: rest, bg: !!bg[i], ln, stdin: i === 0 ? stdin : null });
      });
    }
    return out;
  }

  // Group statements into if, for and while blocks.
  function blocks(stmts) {
    let k = 0;
    const expect = (kw) => {
      if (stmts[k] && stmts[k].kw === kw) { k++; return; }
      throw new ShellSyntax(stmts[k] ? `line ${stmts[k].ln}: syntax error near unexpected token \`${stmts[k].kw || headOf(stmts[k].list)}'` : `line ${(stmts[stmts.length - 1] || { ln: 1 }).ln}: syntax error: unexpected end of file`);
    };
    const block = (stops) => {
      const out = [];
      while (k < stmts.length) {
        const st = stmts[k];
        if (st.kw && stops.includes(st.kw)) return out;
        k++;
        if (!st.kw) out.push({ type: "cmd", st });
        else if (st.kw === "if") {
          const node = { type: "if", branches: [], els: null };
          expect("then");
          node.branches.push([st, block(["elif", "else", "fi"])]);
          while (stmts[k] && stmts[k].kw === "elif") { const c = stmts[k++]; expect("then"); node.branches.push([c, block(["elif", "else", "fi"])]); }
          if (stmts[k] && stmts[k].kw === "else") { k++; node.els = block(["fi"]); }
          expect("fi");
          out.push(node);
        } else if (st.kw === "for" || st.kw === "while" || st.kw === "until") {
          expect("do");
          const body = block(["done"]);
          expect("done");
          out.push({ type: st.kw, st, body });
        } else throw new ShellSyntax(`line ${st.ln}: syntax error near unexpected token \`${st.kw}'`);
      }
      if (stops.length) throw new ShellSyntax(`line ${(stmts[stmts.length - 1] || { ln: 1 }).ln}: syntax error: unexpected end of file`);
      return out;
    };
    return block([]);
  }

  const MAX_LOOP = 10000;
  function runScript(script, sx, opts) {
    const lines = [];
    sx.substErr = sx.substErr || [];
    const state = { code: 0, exited: false, secs: 0, hang: false };
    let tree;
    try { tree = blocks(statements(script)); } catch (e) { if (!(e instanceof ShellSyntax)) throw e; lines.push([`${SCRIPT}: ${/^line /.test(e.message) ? e.message : "line 1: " + e.message}`, "err"]); return { lines, code: 2, secs: 0, hang: false }; }
    const stop = () => state.exited || state.hang;
    const test = (st) => andOr(st.list, sx, state, lines, st.ln, null, true) === 0;
    const run = (nodes) => {
      for (const node of nodes) {
        if (stop()) return;
        if (node.type === "if") {
          const branch = node.branches.find(([c]) => !stop() && test(c));
          if (stop()) return;
          run(branch ? branch[1] : node.els || []);
        } else if (node.type === "for") {
          const [name, inWord, ...items] = node.st.list.filter((t) => typeof t !== "string");
          if (!name) throw new ShellSyntax(`line ${node.st.ln}: syntax error near unexpected token \`do'`);
          const values = inWord && expandWord(inWord, sx, state) === "in"
            ? items.flatMap((w) => { const v = expandWord(w, sx, state); return w.some(([, q]) => q) ? [v] : v.split(/\s+/).filter(Boolean); }) : [];
          for (const v of values.slice(0, MAX_LOOP)) { sx.env[expandWord(name, sx, state)] = v; run(node.body); if (stop()) return; }
        } else if (node.type === "while" || node.type === "until") {
          let n = 0;
          while (!stop() && test(node.st) === (node.type === "while")) {
            if (++n > MAX_LOOP) { state.hang = true; return; }
            run(node.body);
          }
        } else {
          const { list, bg, ln, stdin } = node.st;
          if (headOf(list) === "case") { lines.push(["(the playground does not run `case` statements)", "dim"]); continue; }
          if (bg) { runBackground(list, sx, state, lines, ln); continue; }
          const code = andOr(list, sx, state, lines, ln, stdin, false);
          if (state.hang) return;
          if (code !== 0 && opts.errexit && sx.errexit !== false && !state.guarded) { state.code = code; state.exited = true; return; }
          state.code = code;
        }
      }
    };
    try { run(tree); } catch (e) { if (!(e instanceof ShellSyntax)) throw e; lines.push([`${SCRIPT}: ${e.message}`, "err"]); return { lines, code: 2, secs: state.secs, hang: false }; }
    if (state.hang) return { lines, code: 0, secs: Infinity, hang: true };
    return { lines, code: state.code, secs: state.secs, hang: false };
  }

  function runBackground(list, sx, state, lines, ln) {
    const words = list.filter((t) => typeof t !== "string").map((w) => expandWord(w, sx));
    const cmd = words.join(" ");
    if (/^(npm (start|run start|run serve)|node server\.js|python -m http\.server)/.test(cmd)) { sx.server = true; lines.push([`[1] ${3000 + ln}`, "dim"]); }
  }

  // a && b || c: returns the status of the last command run.
  function andOr(list, sx, state, lines, ln, stdin, guarded) {
    const parts = [[]];
    const ops = [];
    for (const t of list) { if (t === "&&" || t === "||") { ops.push(t); parts.push([]); } else parts[parts.length - 1].push(t); }
    let code = 0;
    let last = -1;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0 && ((ops[i - 1] === "&&" && code !== 0) || (ops[i - 1] === "||" && code === 0))) continue;
      code = pipeline(parts[i], sx, state, lines, ln, i === 0 ? stdin : null);
      last = i;
      if (state.exited || state.hang) return code;
    }
    // set -e ignores a failure on the left of && or ||.
    state.guarded = guarded || last < parts.length - 1;
    return code;
  }

  function pipeline(tokens, sx, state, lines, ln, stdin) {
    const cmds = [[]];
    for (const t of tokens) { if (t === "|") cmds.push([]); else cmds[cmds.length - 1].push(t); }
    let input = stdin;
    let code = 0;
    const codes = [];
    for (let i = 0; i < cmds.length; i++) {
      const res = command(cmds[i], sx, state, ln, input);
      if (state.hang || state.exited) { lines.push(...res.err.map((t) => [t, "err"])); return res.code; }
      const last = i === cmds.length - 1;
      lines.push(...res.err.map((t) => [t, "err"]));
      if (last && res.out != null) for (const l of res.out.replace(/\n$/, "").split("\n")) if (res.out !== "") lines.push([l, ""]);
      input = res.out == null ? "" : res.out;
      codes.push(res.code);
      code = res.code;
    }
    if (sx.pipefail) code = codes.reduce((c, x) => (x !== 0 ? x : c), 0);
    return code;
  }

  function expandWord(word, sx, state) {
    return word.map(([t, q]) => {
      if (q === "'") return t;
      return t.replace(/\$\(([^()]*)\)|\$\{(\w+)(:?[-=])?([^}]*)\}|\$(\w+|\?)/g, (m, sub, name, op, def, simple) => {
        if (sub != null) {
          const r = runScript(sub, { ...sx, quiet: true }, { errexit: false });
          sx.substCode = r.code;
          sx.substErr.push(...r.lines.filter((l) => l[1] === "err").map((l) => l[0]));
          return r.lines.filter((l) => l[1] !== "err").map((l) => l[0]).join("\n");
        }
        const k = name || simple;
        if (k === "?") return String(state ? state.code : 0);
        const v = sx.env[k];
        return op && (v == null || v === "") ? def : v == null ? "" : String(v);
      });
    }).join("");
  }

  // One simple command, with its redirections. Returns {out, err, code}.
  function command(tokens, sx, state, ln, stdin) {
    const words = [];
    sx.substCode = 0;
    sx.substErr = [];
    let redirect = null, append = false, errToOut = false, quietErr = false;
    // The word after a redirection; an operator or nothing there is a syntax error.
    const target = (i) => (tokens[i] && typeof tokens[i] !== "string" ? expandWord(tokens[i], sx, state) : null);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^(>|>>|&>|2>|2>>|<)$/.test(t) && target(i + 1) == null) return { out: "", err: [`${SCRIPT}: line ${ln}: syntax error near unexpected token \`${tokens[i + 1] || "newline"}'`], code: 2 };
      if (t === ">" || t === ">>" || t === "&>") { redirect = target(i + 1); append = t === ">>"; i++; continue; }
      if (t === "2>" || t === "2>>") { if (target(i + 1) === "/dev/null") quietErr = true; i++; continue; }
      if (t === "2>&1") { errToOut = true; continue; }
      if (t === "<") { stdin = (sx.ws || {})[target(i + 1).replace(/^\.\//, "")] || ""; i++; continue; }
      if (typeof t === "string") continue;
      words.push(expandWord(t, sx, state));
    }
    // FOO=bar cmd sets FOO for that command only.
    const env = {};
    while (words.length > 1 && /^[A-Za-z_]\w*=/.test(words[0])) { const [k, ...v] = words.shift().split("="); env[k] = v.join("="); }
    // A bare assignment returns the status of its command substitution, so set -e stops on it.
    if (words.length === 1 && /^[A-Za-z_]\w*=/.test(words[0])) { const [k, ...v] = words[0].split("="); sx.env[k] = v.join("="); return { out: "", err: sx.substErr, code: sx.substCode }; }
    if (!words.length) return { out: "", err: [], code: 0 };
    const saved = { ...sx.env };
    Object.assign(sx.env, env);
    let res;
    try { res = exec(words, sx, state, ln, stdin); if (res.hang) state.hang = true; } finally { if (Object.keys(env).length) sx.env = Object.assign(saved, Object.fromEntries(Object.entries(sx.env).filter(([k]) => !(k in env)))); }
    let out = res.out == null ? "" : res.out;
    let err = quietErr ? [] : [...sx.substErr, ...(res.err || [])];
    if (errToOut) { out = [...err, out].filter(Boolean).join("\n"); err = []; }
    if (redirect != null) {
      writeFile(sx, redirect, out, append);
      out = null;
    }
    return { out, err, code: res.code || 0 };
  }

  function writeFile(sx, path, text, append) {
    if (path === "/dev/null") return;
    const special = Object.entries(FILES).find(([, p]) => p === path);
    if (special) {
      const [kind] = special;
      if (kind === "output" || kind === "env") {
        const target = kind === "output" ? sx.stepOutputs : sx.newEnv;
        const rows = text.split("\n");
        for (let i = 0; i < rows.length; i++) {
          const m = /^([^=<]+)<<(\S+)$/.exec(rows[i]);
          if (m) { const body = []; i++; while (i < rows.length && rows[i] !== m[2]) body.push(rows[i++]); target[m[1]] = body.join("\n"); continue; }
          const kv = /^([^=]+)=(.*)$/.exec(rows[i]);
          if (kv) target[kv[1]] = kv[2];
        }
      }
      return;
    }
    sx.ws = sx.ws || {};
    const key = path.replace(new RegExp("^" + WORK.replace(/[/.]/g, "\\$&") + "/"), "").replace(/^\.\//, "");
    sx.ws[key] = (append && sx.ws[key] ? sx.ws[key] : "") + text + (text.endsWith("\n") || !text ? "" : "\n");
  }

  // Commands on the hosted Ubuntu image that the playground does not model in detail.
  const PREINSTALLED = ["node", "python3", "python", "go", "java", "javac", "mvn", "gradle", "cargo", "rustc", "terraform", "kubectl", "helm", "jq", "yq", "zip", "unzip", "tar",
    "gzip", "ssh", "scp", "rsync", "az", "gcloud", "dotnet", "ruby", "gem", "php", "composer", "yarn", "pnpm", "npx", "shellcheck", "openssl", "sha256sum", "md5sum", "find",
    "sed", "awk", "sort", "uniq", "cut", "tr", "xargs", "whoami", "uname", "hostname", "nproc", "free", "which", "file", "stat", "chmod", "chown", "ln", "basename", "dirname",
    "realpath", "readlink", "diff", "patch", "apt-get", "apt", "dpkg", "pip3", "pipx", "poetry", "ruff", "black", "flake8", "mypy", "eslint", "prettier", "tsc", "vitest", "jest"];

  function exec(words, sx, state, ln, stdin) {
    if (!words.length) return { out: "", err: [], code: 0 };
    const [cmd, ...args] = words;
    const out = (text, code = 0, secs = 0) => { state.secs += secs; return { out: text, err: [], code }; };
    const fail = (lines, code = 1, secs = 0) => { state.secs += secs; return { out: "", err: [].concat(lines), code }; };
    const ws = () => sx.ws || null;
    const file = (p) => { const k = p.replace(/^\.\//, "").replace(new RegExp("^" + WORK.replace(/[/.]/g, "\\$&") + "/"), ""); return ws() && k in ws() ? ws()[k] : null; };
    const notFound = () => fail(`${SCRIPT}: line ${ln}: ${cmd}: command not found`, 127);
    // Windows shells: pwsh aliases some Unix names to cmdlets with other options, and cmd knows none.
    if (sx.dialect === "pwsh" || sx.dialect === "powershell") {
      const flag = args.find((x) => /^-[a-z]{2,}$/.test(x));
      if ((cmd === "rm" || cmd === "cp" || cmd === "mv") && flag) return fail([`${{ rm: "Remove-Item", cp: "Copy-Item", mv: "Move-Item" }[cmd]}: A parameter cannot be found that matches parameter name '${flag.slice(1)}'.`]);
      if (["export", "test", "[", "source", "grep", "sed", "awk", "base64", "wc", "head", "tail", "touch", "df", "du", "sudo", "true", "false", "seq", "chmod", "printenv"].includes(cmd)) {
        return fail([`${cmd}: The term '${cmd}' is not recognized as a name of a cmdlet, function, script file, or executable program.`, "Check the spelling of the name, or if a path was included, verify that the path is correct and try again."]);
      }
    }
    if (sx.dialect === "cmd" && !["echo", "cd", "npm", "npx", "node", "git", "gh", "python", "pip", "set", "exit", "mkdir", "dir", "type", "copy", "del", "docker", "curl"].includes(cmd)) {
      return fail([`'${cmd}' is not recognized as an internal or external command,`, "operable program or batch file."]);
    }
    if (sx.dialect === "cmd" && cmd === "mkdir" && args.includes("-p")) return fail(["The syntax of the command is incorrect."]);
    const custom = sx.world.tools && Object.keys(sx.world.tools).sort((a, b) => b.length - a.length).find((k) => words.join(" ") === k || words.join(" ").startsWith(k + " "));
    if (custom) {
      const r = sx.world.tools[custom](words, sx, stdin) || {};
      state.secs += r.secs || 0;
      if (r.hang) { state.hang = true; return { out: r.out || "", err: [], code: 0 }; }
      return { out: r.out != null ? r.out : "", err: [].concat(r.err || []), code: r.code || 0 };
    }
    switch (cmd) {
      case "echo": {
        let a = args, nl = "\n", esc = false;
        while (a[0] && /^-[neE]+$/.test(a[0])) { if (a[0].includes("n")) nl = ""; if (a[0].includes("e")) esc = true; a = a.slice(1); }
        let s = a.join(" ");
        if (esc) s = s.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        return workflowCommand(sx, s) ?? out(s + nl);
      }
      case "printf": { const fmt = args[0] || ""; let k = 1; return out(fmt.replace(/%[sd]/g, () => args[k++] || "").replace(/\\n/g, "\n").replace(/\\t/g, "\t")); }
      case "seq": { const [a, b] = args.length > 1 ? [Number(args[0]), Number(args[1])] : [1, Number(args[0])]; if (!Number.isFinite(a) || !Number.isFinite(b)) return fail(`seq: invalid floating point argument: '${args[0] || ""}'`); const n = Math.max(0, Math.min(100000, b - a + 1)); return out(Array.from({ length: n }, (_, i) => a + i).join("\n") + (n ? "\n" : "")); }
      case "true": case ":": return out("");
      case "false": return out("", 1);
      case "exit": { state.exited = true; state.code = Number(args[0] || 0) || 0; return { out: "", err: [], code: state.code }; }
      case "set": {
        for (const a of args) { if (/^-\w*e/.test(a)) sx.errexit = true; if (/^\+\w*e/.test(a)) sx.errexit = false; if (a === "pipefail") sx.pipefail = !args.includes("+o"); if (/^-\w*o$/.test(a) && args.includes("pipefail")) sx.pipefail = true; }
        return out("");
      }
      case "export": { for (const a of args) { const [k, ...v] = a.split("="); if (v.length) sx.env[k] = v.join("="); } return out(""); }
      case "cd": return out("");
      case "pwd": return out(WORK + "\n");
      case "sleep": return out("", 0, Number(args[0]) || 0);
      case "sudo": return exec(args, sx, state, ln, stdin);
      case "bash": case "sh": {
        if (args[0] === "-c" && args[1]) { const r = runScript(args[1], sx, { errexit: false }); return { out: r.lines.filter((l) => l[1] !== "err").map((l) => l[0]).join("\n") + "\n", err: r.lines.filter((l) => l[1] === "err").map((l) => l[0]), code: r.code }; }
        const body = args[0] ? file(args[0]) : stdin;
        if (body == null) return fail(`${cmd}: ${args[0]}: No such file or directory`, 127);
        if (!args[0] && sx.remoteScript) sx.remoteScript(body);
        const r = runScript(body, sx, { errexit: false });
        return { out: r.lines.filter((l) => l[1] !== "err").map((l) => l[0]).join("\n") + (r.lines.length ? "\n" : ""), err: r.lines.filter((l) => l[1] === "err").map((l) => l[0]), code: r.code };
      }
      case "cat": {
        if (!args.length) return out(stdin || "");
        let text = "";
        for (const a of args) { const c = file(a); if (c == null) return fail(`cat: ${a}: No such file or directory`); text += c; }
        return out(text);
      }
      case "ls": {
        const dir = (args.filter((a) => !a.startsWith("-"))[0] || "").replace(/^\.\/?/, "").replace(/\/$/, "");
        const names = [...new Set(Object.keys(ws() || {}).filter((f) => !dir || f.startsWith(dir + "/")).map((f) => (dir ? f.slice(dir.length + 1) : f).split("/")[0]))].sort();
        if (dir && !names.length) return fail(`ls: cannot access '${dir}': No such file or directory`, 2);
        return out(names.join("\n") + (names.length ? "\n" : ""));
      }
      case "mkdir": case "touch": case "rm": case "cp": case "mv": case "chmod": {
        if (cmd === "touch") for (const a of args.filter((x) => !x.startsWith("-"))) writeFile(sx, a, "", true);
        if (cmd === "rm") {
          const freed = args.filter((a) => !a.startsWith("-")).reduce((n, a) => n + ((sx.world.bloat || {})[a] || 0), 0);
          sx.disk.free += freed;
          for (const a of args) for (const k of Object.keys(ws() || {})) if (k === a || k.startsWith(a.replace(/\/?$/, "/"))) delete sx.ws[k];
          return out("", 0, freed ? 25 : 0);
        }
        if (cmd === "cp" || cmd === "mv") { const [from, to] = args.filter((x) => !x.startsWith("-")); if (from && to && file(from) == null && !Object.keys(ws() || {}).some((k) => k.startsWith(from + "/"))) return fail(`${cmd}: cannot stat '${from}': No such file or directory`); if (from && to && file(from) != null) writeFile(sx, to, file(from)); }
        return out("");
      }
      case "test": case "[": {
        const a = cmd === "[" ? args.slice(0, -1) : args;
        const r = a.length === 2 && a[0] === "-z" ? !a[1] : a.length === 2 && a[0] === "-n" ? !!a[1] : a.length === 1 ? !!a[0]
          : a.length === 2 && (a[0] === "-f" || a[0] === "-e") ? file(a[1]) != null : a.length === 2 && a[0] === "-d" ? Object.keys(ws() || {}).some((k) => k.startsWith(a[1].replace(/^\.\//, "").replace(/\/?$/, "/")))
          : a.length === 3 && (a[1] === "=" || a[1] === "==") ? a[0] === a[2] : a.length === 3 && a[1] === "!=" ? a[0] !== a[2]
          : a.length === 3 && /^-(eq|ne|gt|lt|ge|le)$/.test(a[1]) ? { "-eq": (x, y) => x === y, "-ne": (x, y) => x !== y, "-gt": (x, y) => x > y, "-lt": (x, y) => x < y, "-ge": (x, y) => x >= y, "-le": (x, y) => x <= y }[a[1]](Number(a[0]), Number(a[2])) : false;
        return out("", r ? 0 : 1);
      }
      case "base64": {
        const input = stdin || "";
        if (args.includes("-d") || args.includes("--decode")) { try { return out(Buffer.from ? Buffer.from(input.trim(), "base64").toString() : atob(input.trim())); } catch { return fail("base64: invalid input"); } }
        for (const [name, v] of Object.entries(sx.secrets)) if (v && name !== "GITHUB_TOKEN" && input.includes(v)) sx.effects.leaks.push(name);
        const enc = typeof btoa === "function" ? btoa(unescape(encodeURIComponent(input))) : Buffer.from(input).toString("base64");
        return out(enc + "\n");
      }
      case "grep": {
        const flags = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join("");
        const rest = args.filter((a) => !/^-[a-zA-Z]+$/.test(a));
        const [pat, ...paths] = rest;
        if (pat == null) return fail("Usage: grep [OPTION]... PATTERNS [FILE]...", 2);
        let re;
        try { re = new RegExp(pat.replace(/\\\|/g, "|"), flags.includes("i") ? "i" : ""); } catch { return fail(`grep: Unmatched ( or \\(`, 2); }
        const sources = paths.length ? paths.map((p) => [p, file(p)]) : [["", stdin || ""]];
        for (const [p, c] of sources) if (c == null) return fail(`grep: ${p}: No such file or directory`, 2);
        const hits = sources.flatMap(([p, c]) => c.split("\n").filter((l, i, arr) => (i < arr.length - 1 || l) && re.test(l) !== flags.includes("v")).map((l) => (sources.length > 1 ? `${p}:${l}` : l)));
        if (flags.includes("q")) return out("", hits.length ? 0 : 1);
        if (flags.includes("c")) return out(hits.length + "\n", hits.length ? 0 : 1);
        return out(hits.join("\n") + (hits.length ? "\n" : ""), hits.length ? 0 : 1);
      }
      case "wc": { const text = args.length && !args[args.length - 1].startsWith("-") ? file(args[args.length - 1]) || "" : stdin || ""; return out(String(text.split("\n").length - (text.endsWith("\n") ? 1 : 0)) + "\n"); }
      case "head": case "tail": {
        const src = args.filter((x, i) => !x.startsWith("-") && args[i - 1] !== "-n");
        if (src.length && file(src[0]) == null) return fail(`${cmd}: cannot open '${src[0]}' for reading: No such file or directory`);
        const text = src.length ? file(src[0]) : stdin || ""; const n = Number((/^-(?:n\s*)?(\d+)$/.exec(args[0] || "") || [])[1] || (args[0] === "-n" ? args[1] : 10)); const rows = text.replace(/\n$/, "").split("\n"); return out((cmd === "head" ? rows.slice(0, n) : rows.slice(-n)).join("\n") + "\n"); }
      case "tee": { for (const a of args.filter((x) => !x.startsWith("-"))) writeFile(sx, a, stdin || "", args.includes("-a")); return out(stdin || ""); }
      case "env": case "printenv": return out(Object.entries(sx.env).map(([k, v]) => `${k}=${v}`).sort().join("\n") + "\n");
      case "date": return out("Fri Oct 30 09:14:07 UTC 2026\n");
      case "df": return out(`Filesystem      Size  Used Avail Use% Mounted on\n/dev/root        72G   ${Math.round(72 - sx.disk.free)}G   ${Math.max(0, Math.round(sx.disk.free))}G  ${Math.min(100, Math.round((72 - sx.disk.free) / 72 * 100))}% /\n`);
      case "du": return out("8.9G\t/usr/local/lib/android\n3.1G\t/usr/share/dotnet\n5.4G\t/opt/hostedtoolcache\n");
      case "npm": return npm(args, sx, out, fail, file);
      case "pip": case "pip3": return out(`Collecting ${args.filter((a) => !a.startsWith("-")).slice(1).join(" ") || "packages"}\nSuccessfully installed ${args.filter((a) => !a.startsWith("-")).slice(1).join(" ") || "packages"}\n`, 0, sx.pipCache ? 3 : 9);
      case "python": case "python3": {
        if (args[0] === "-m" && /^pip/.test(args[1] || "")) return exec(["pip", ...args.slice(2)], sx, state, ln, stdin);
        if (args[0] === "-m" && args[1] === "pytest") return exec(["pytest", ...args.slice(2)], sx, state, ln, stdin);
        return out("", 0, 1);
      }
      case "pytest": {
        if (!ws()) return fail(`ERROR: file or directory not found: ${args.find((a) => !a.startsWith("-")) || "tests"}`, 4);
        const app = sx.world.app || {};
        const secs = (app.pytestSecs && app.pytestSecs[sx.python]) || 20;
        if (app.testsFail || (app.failOn || []).includes(sx.python)) return fail([`FAILED src/test_cart.py::test_discount - assert 100 == 90`, `1 failed, 11 passed in ${secs}.41s`], 1, secs);
        return out(`============================= test session starts ==============================\n12 passed in ${secs}.38s\n`, 0, secs);
      }
      case "docker": return docker(args, sx, out, fail, file, stdin);
      case "gh": return gh(args, sx, out, fail);
      case "git": {
        if (args[0] === "tag" && args[1] && !args[1].startsWith("-")) { if (!sx.ws) return fail(["fatal: not a git repository (or any of the parent directories): .git"], 128); (sx.tags = sx.tags || []).push(args[1]); return out(""); }
        if (args[0] === "push") {
          if (!sx.ws) return fail(["fatal: not a git repository (or any of the parent directories): .git"], 128);
          if (sx.pushToken === "empty" || (!sx.persisted && !sx.env.GH_TOKEN)) return fail(["fatal: could not read Username for 'https://github.com': No such device or address"], 128);
          const tags = args.includes("--tags") ? sx.tags || [] : args.filter((a) => (sx.tags || []).includes(a));
          if (sx.pushToken === "other") {
            for (const t of tags) sx.effects.pushedTags.push({ tag: t, by: "other" });
            return out(`To https://github.com/${FULL}\n${tags.map((t) => ` * [new tag]         ${t} -> ${t}`).join("\n")}\n`, 0, 2);
          }
          if (!can(sx.perms, "contents", "write")) return fail([`remote: Permission to ${FULL}.git denied to github-actions[bot].`, `fatal: unable to access 'https://github.com/${FULL}/': The requested URL returned error: 403`], 128, 1);
          sx.effects.pushed = true;
          for (const t of tags) sx.effects.pushedTags.push({ tag: t, by: "github" });
          return out(`To https://github.com/${FULL}\n${tags.length ? tags.map((t) => ` * [new tag]         ${t} -> ${t}`).join("\n") : "   1a2b3c4..5d6e7f8  main -> main"}\n`, 0, 2);
        }
        if (args[0] === "describe") {
          if (!sx.ws) return fail(["fatal: not a git repository (or any of the parent directories): .git"], 128);
          if (sx.fetchDepth !== 0) return fail(["fatal: No names found, cannot describe anything."], 128);
          return out("v1.3.0-4-g5d6e7f8\n");
        }
        if (args[0] === "fetch" && args.includes("--tags")) { if (sx.ws) sx.fetchDepth = 0; return out("", 0, 2); }
        return out("", 0, 1);
      }
      case "curl": case "wget": {
        const url = args.find((a) => /^https?:\/\//.test(a)) || "";
        for (const [name, v] of Object.entries(sx.secrets)) if (v && name !== "GITHUB_TOKEN" && words.join(" ").includes(v) && !/api\.github\.com/.test(url)) sx.effects.sentOut.push(name);
        const remote = (sx.world.remote || {})[url];
        if (/attacker|evil/.test(url)) { sx.effects.remote.push(url); return out(remote || "", 0, 1); }
        if (remote != null) { sx.effects.remote.push(url); return out(remote, 0, 1); }
        if (!url) return fail(`${cmd}: no URL specified!`, 2);
        return out("", 0, 1);
      }
      case "aws": {
        if (!sx.aws) return fail(['Unable to locate credentials. You can configure credentials by running "aws configure".'], 253);
        if (args[0] === "sts") return out(JSON.stringify({ UserId: "AROA_PLAYGROUND:GitHubActions", Account: sx.aws.account, Arn: `arn:aws:sts::${sx.aws.account}:assumed-role/${sx.aws.role.split("/").pop()}/GitHubActions` }, null, 4) + "\n");
        if (args[0] === "s3" || args[0] === "ecs" || args[0] === "lambda") { sx.deploy("production", 20); return out(args[0] === "s3" ? "upload: dist/index.html to s3://shop-site/index.html\nupload: dist/app.js to s3://shop-site/app.js\n" : "{}\n", 0, 20); }
        return out("{}\n");
      }
      default: {
        if (/^(\.\/|scripts\/|bash\s)/.test(cmd) || cmd.endsWith(".sh")) {
          const body = file(cmd);
          if (body == null) return fail(`${SCRIPT}: line ${ln}: ${cmd}: No such file or directory`, 127);
          return script(cmd, args, sx, out, fail);
        }
        if (cmd === "make") {
          if (!ws() || !("Makefile" in ws())) return fail(["make: *** No targets specified and no makefile found.  Stop."], 2);
          return out(`make: '${args[0] || "all"}' is up to date.\n`, 0, 5);
        }
        if (PREINSTALLED.includes(cmd)) return out(args[0] === "--version" || args[0] === "-v" ? `${cmd} (version on the runner image)\n` : "", 0, 2);
        return notFound();
      }
    }
  }

  // ::error::, ::warning::, ::add-mask:: and friends.
  function workflowCommand(sx, s) {
    const m = /^::([a-z-]+)(?: ([^:]*))?::(.*)$/s.exec(s);
    if (!m) return null;
    const [, name, , msg] = m;
    if (name === "add-mask") { sx.secretValues.push(msg); return { out: "", err: [], code: 0 }; }
    if (name === "error" || name === "warning" || name === "notice") { sx.annotations.push([name, msg]); return { out: `${name === "error" ? "Error" : name === "warning" ? "Warning" : "Notice"}: ${msg}\n`, err: [], code: 0 }; }
    if (name === "set-output") { const n = /name=([^,]+)/.exec(m[2] || ""); if (n) sx.stepOutputs[n[1]] = msg; sx.annotations.push(["warning", "The `set-output` command is deprecated and will be disabled soon. Please upgrade to using Environment Files. For more information see: https://github.blog/changelog/2022-10-11-github-actions-deprecating-save-state-and-set-output-commands/"]); return { out: "", err: [], code: 0 }; }
    if (name === "group" || name === "endgroup") return { out: name === "group" ? msg + "\n" : "", err: [], code: 0 };
    return null;
  }

  function npm(args, sx, out, fail, file) {
    const app = sx.world.app || {};
    const sub = args[0] === "run" ? args[1] : args[0];
    if (!sx.ws || file("package.json") == null) {
      return fail(["npm error code ENOENT", "npm error syscall open", `npm error path ${WORK}/package.json`, "npm error errno -2",
        `npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${WORK}/package.json'`], 254, 1);
    }
    const pre = (s) => `\n> shop@1.4.0 ${s}\n> ${{ test: "jest", build: "vite build", lint: "eslint .", start: "node server.js", e2e: "playwright test" }[s] || s}\n\n`;
    if (sub === "ci" || sub === "install" || sub === "i") {
      if (sub === "ci" && file("package-lock.json") == null) return fail(["npm error code EUSAGE", "npm error", "npm error The `npm ci` command can only install with an existing package-lock.json or", "npm error npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or", "npm error later to generate a package-lock.json file, then try again."], 1, 2);
      const secs = sx.npmCache ? app.npmCachedSecs || 18 : app.npmSecs || 95;
      // An install runs the package's lifecycle scripts: from a fork's package.json, the fork's code.
      if (sx.untrusted) { sx.effects.pwned = true; sx.effects.untrustedRan = true; }
      sx.disk.free -= 1;
      sx.deps = true;
      return out(`\nadded 812 packages, and audited 813 packages in ${secs}s\n\n156 packages are looking for funding\n  run \`npm fund\` for details\n\nfound 0 vulnerabilities\n`, 0, secs);
    }
    if (!sx.deps && /^(test|build|lint|e2e|start)$/.test(sub)) return fail([pre(sub).trim(), `sh: 1: ${{ test: "jest", build: "vite", lint: "eslint", e2e: "playwright", start: "node" }[sub] || sub}: not found`], 127, 1);
    if (sub === "test" || sub === "t") {
      const shard = /--shard=(\d+)\/(\d+)/.exec(args.join(" "));
      const total = app.testSecs || 60;
      const secs = shard ? Math.ceil(total / Number(shard[2])) : total;
      if (shard) sx.effects.shards.push(`${shard[1]}/${shard[2]}`);
      else sx.effects.shards.push("1/1");
      if (app.testsFail) return fail([pre("test") + "FAIL src/cart.test.js", "  ● cart › applies the 10% discount", "", "    expect(received).toBe(expected) // Object.is equality", "", "    Expected: 90", "    Received: 100", "",
        "Tests:       1 failed, 47 passed, 48 total", "Test Suites: 1 failed, 11 passed, 12 total"], 1, secs);
      return out(pre("test") + `PASS src/cart.test.js\nPASS src/login.test.js\n\nTest Suites: ${shard ? 4 : 12} passed, ${shard ? 4 : 12} total\nTests:       ${shard ? 16 : 48} passed, ${shard ? 16 : 48} total\nTime:        ${secs} s\n`, 0, secs);
    }
    if (sub === "build") { sx.ws["dist/index.html"] = "<!doctype html>"; sx.ws["dist/app.js"] = "console.log('shop')"; return out(pre("build") + "vite v7.1.0 building for production...\n✓ 214 modules transformed.\ndist/index.html   0.46 kB\ndist/app.js     142.31 kB\n✓ built in 31.20s\n", 0, app.buildSecs || 35); }
    if (sub === "lint") return out(pre("lint"), 0, 12);
    if (sub === "test:integration") {
      const url = sx.env.DATABASE_URL || "";
      const host = (/@([^:/]+)/.exec(url) || [])[1] || "";
      const svc = isObj(sx.job.services) ? sx.job.services.postgres : null;
      const ports = isObj(svc) ? [].concat(svc.ports || []).map(toStr) : [];
      const inContainer = sx.job.container != null;
      if (!svc) return fail([pre("test:integration").trim(), `Error: connect ECONNREFUSED 127.0.0.1:5432`], 1, 3);
      if (host === "postgres" && !inContainer) return fail([pre("test:integration").trim(), "Error: getaddrinfo EAI_AGAIN postgres"], 1, 3);
      if (host === "localhost" && !inContainer && !ports.some((p) => /^(5432:)?5432$/.test(p) || p === "5432:5432")) return fail([pre("test:integration").trim(), "Error: connect ECONNREFUSED 127.0.0.1:5432"], 1, 3);
      if (!/^(localhost|postgres|127\.0\.0\.1)$/.test(host)) return fail([pre("test:integration").trim(), `Error: getaddrinfo ENOTFOUND ${host || "undefined"}`], 1, 3);
      return out(pre("test:integration") + "PASS test/orders.db.test.js\n\nTests:       14 passed, 14 total\n", 0, 40);
    }
    if (sub === "start") return { out: pre("start") + "shop listening on http://localhost:3000\n", hang: true };
    if (sub === "e2e") {
      if (!sx.server) return fail([pre("e2e").trim(), "Error: connect ECONNREFUSED 127.0.0.1:3000", "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16)"], 1, 3);
      return out(pre("e2e") + "Running 9 tests using 2 workers\n  9 passed (24.1s)\n", 0, 30);
    }
    if (sub === "publish") return sx.env.NODE_AUTH_TOKEN ? out("+ shop@1.4.0\n", 0, 4) : fail(["npm error code ENEEDAUTH", "npm error need auth This command requires you to be logged in to https://registry.npmjs.org/"], 1, 2);
    return out(pre(sub || "") , 0, 2);
  }

  function docker(args, sx, out, fail, file, stdin) {
    const app = sx.world.app || {};
    const image = "ghcr.io/" + FULL;
    if (args[0] === "build" || (args[0] === "buildx" && args[1] === "build")) {
      if (!sx.ws || file("Dockerfile") == null) return fail(["ERROR: failed to build: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory"], 1, 2);
      const need = app.imageGB || 2;
      sx.disk.free -= need;
      if (sx.disk.free < 0) {
        sx.annotations.push(["warning", "You are running out of disk space. The runner will stop working when the machine runs out of disk space. Free space left: 0 MB"]);
        return fail(["#9 [build 4/6] RUN npm ci && npm run build", "#9 ERROR: failed to copy files: copy file range failed: no space left on device",
          "ERROR: failed to build: failed to solve: failed to compute cache key: write /var/lib/docker/buildkit/content/ingest/3b1e/data: no space left on device"], 1, 240);
      }
      const tag = args[args.indexOf("-t") + 1] || "";
      sx.built = tag;
      return out(`#0 building with "default" instance using docker driver\n#1 [internal] load build definition from Dockerfile\n#9 [build 4/6] RUN npm ci && npm run build\n#12 exporting to image\n#12 naming to ${tag || "<none>"} done\n`, 0, app.buildSecs || 140);
    }
    if (args[0] === "login") {
      const reg = args.find((a) => /\./.test(a) && !a.startsWith("-")) || "docker.io";
      if (!args.includes("--password-stdin") && !args.includes("-p")) return fail(["Error: Cannot perform an interactive login from a non TTY device"]);
      const pw = args.includes("-p") ? args[args.indexOf("-p") + 1] : (stdin || "").trim();
      if (!pw) return fail(["Error: Cannot perform an interactive login from a non TTY device"]);
      sx.dockerLogin = { reg, token: pw === sx.secrets.GITHUB_TOKEN };
      return out("Login Succeeded\n", 0, 1);
    }
    if (args[0] === "push") {
      const ref = args[1] || "";
      if (ref.startsWith("ghcr.io/")) {
        if (!sx.dockerLogin) return fail([`The push refers to repository [${ref.split(":")[0]}]`, "unauthorized: unauthenticated: User cannot be authenticated with the token provided."], 1, 2);
        if (sx.dockerLogin.token && !can(sx.perms, "packages", "write")) return fail([`The push refers to repository [${ref.split(":")[0]}]`, "5f70bf18a086: Preparing", "denied: permission_denied: write_package"], 1, 4);
      }
      sx.effects.pushedImage = ref;
      return out(`The push refers to repository [${ref.split(":")[0] || image}]\n5f70bf18a086: Pushed\n${ref.split(":")[1] || "latest"}: digest: sha256:${hash(ref).slice(0, 40)}${hash(ref + "x").slice(0, 24)} size: 1789\n`, 0, 25);
    }
    if (args[0] === "system" && args[1] === "prune") { sx.disk.free += 4; return out("Total reclaimed space: 4.1GB\n", 0, 12); }
    if (args[0] === "image" && args[1] === "prune") { sx.disk.free += 3; return out("Total reclaimed space: 3.2GB\n", 0, 8); }
    return out("", 0, 2);
  }

  function gh(args, sx, out, fail) {
    if (!sx.env.GH_TOKEN && !sx.env.GITHUB_TOKEN) {
      return fail(["gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable. Example:", "  env:", "    GH_TOKEN: ${{ github.token }}"], 4);
    }
    const token = sx.env.GH_TOKEN || sx.env.GITHUB_TOKEN;
    const perms = token === sx.secrets.GITHUB_TOKEN ? sx.perms : { contents: "write", "pull-requests": "write", issues: "write", packages: "write" };
    const [a, b] = args;
    if (a === "pr" && b === "comment") {
      if (!can(perms, "pull-requests", "write") && !can(perms, "issues", "write")) return fail(["GraphQL: Resource not accessible by integration (addComment)"], 1, 1);
      sx.effects.commented = true;
      return out(`https://github.com/${FULL}/pull/${sx.ev.number || 42}#issuecomment-2417700123\n`, 0, 1);
    }
    if (a === "release" && b === "create") {
      if (!can(perms, "contents", "write")) return fail([`HTTP 403: Resource not accessible by integration (https://api.github.com/repos/${FULL}/releases)`], 1, 1);
      sx.effects.released = args[2] || true;
      if (args[2]) sx.effects.pushedTags.push({ tag: args[2], by: token === sx.secrets.GITHUB_TOKEN ? "github" : "other" });
      return out(`https://github.com/${FULL}/releases/tag/${args[2] || "v1.4.0"}\n`, 0, 2);
    }
    if (a === "workflow" && b === "run") {
      const file = args[2] || "";
      if (token === sx.secrets.GITHUB_TOKEN && !can(perms, "actions", "write")) return fail([`HTTP 403: Resource not accessible by integration (https://api.github.com/repos/${FULL}/actions/workflows/${file}/dispatches)`], 1, 1);
      const ref = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : args.includes("-r") ? args[args.indexOf("-r") + 1] : sx.world.repo.defaultBranch;
      const inputs = {};
      args.forEach((x, i) => { if ((x === "-f" || x === "-F") && args[i + 1]) { const [k, ...v] = args[i + 1].split("="); inputs[k] = v.join("="); } });
      sx.effects.dispatched.push({ file, ref, inputs });
      return out(`✓ Created workflow_dispatch event for ${file} at ${ref}\n`, 0, 1);
    }
    if (a === "api" || (a === "pr" && b === "list")) {
      // The GITHUB_TOKEN allows 1,000 REST requests an hour per repository.
      const app = sx.world.app || {};
      const total = app.prCount || 40;
      const paged = a === "pr" || args.includes("--paginate");
      const perPage = a === "pr" ? 100 : Number((/per_page=(\d+)/.exec(args.join(" ")) || [])[1]) || 30;
      const calls = paged ? Math.ceil(total / Math.min(100, perPage)) : 1;
      sx.apiCalls = (sx.apiCalls || 0) + calls;
      if (token === sx.secrets.GITHUB_TOKEN && sx.apiCalls > 1000) return fail([`HTTP 403: API rate limit exceeded for installation ID 41806354. (https://api.github.com/${(b || "").replace(/^\//, "")})`], 1, 0.3);
      const m = /pulls\/(\d+)/.exec(b || "");
      if (m) return out(`Pull request ${m[1]}\n`, 0, 0.3);
      if (paged) return out(Array.from({ length: total }, (_, i) => `Pull request ${i + 1}`).join("\n") + "\n", 0, calls * 0.4);
      return out("{}\n", 0, 0.3);
    }
    if (a === "pr" && (b === "edit" || b === "merge" || b === "review")) {
      if (!can(perms, "pull-requests", "write")) return fail([`GraphQL: Resource not accessible by integration (${b === "merge" ? "mergePullRequest" : "updatePullRequest"})`], 1, 1);
      return out("", 0, 1);
    }
    return out("", 0, 1);
  }

  // Scripts that live in the repository.
  function script(cmd, args, sx, out, fail) {
    const name = cmd.replace(/^\.\//, "");
    const app = sx.world.app || {};
    if (/deploy\.sh$/.test(name)) {
      const target = args[0];
      if (!target) return fail(["deploy: no environment given (usage: deploy.sh <staging|production>)"], 2);
      if (app.needsImage && !sx.env.IMAGE) return fail(["deploy: IMAGE is empty; nothing to deploy"], 1);
      if (app.needsDist && !(sx.ws && sx.ws["dist/index.html"] != null)) return fail(["deploy: dist/index.html not found; nothing to ship"], 1);
      if (!sx.env.DEPLOY_TOKEN) return fail([`deploy: DEPLOY_TOKEN is empty; cannot authenticate to ${target}`], 1, 1);
      if (sx.untrusted) sx.effects.pwned = true;
      const secs = (app.deploySecs && app.deploySecs[sx.version]) || app.deploySecsDefault || 40;
      sx.deploy(target, secs);
      return out(`deploy: shipping shop ${sx.version} to ${target}\ndeploy: ${target} is now serving ${sx.version}\n`, 0, secs);
    }
    if (/upload-coverage\.sh$/.test(name)) {
      if (!sx.env.COVERAGE_TOKEN) return fail(["upload-coverage: COVERAGE_TOKEN is empty; the coverage service rejected the upload (401)"], 1, 1);
      return out("upload-coverage: report uploaded (84.2% lines)\n", 0, 3);
    }
    // Anything else in the repository is run as written.
    const r = runScript(sx.ws[name], sx, { errexit: false });
    if (sx.untrusted) sx.effects.pwned = true;
    return { out: r.lines.filter((l) => l[1] !== "err").map((l) => l[0]).join("\n") + (r.lines.length ? "\n" : ""), err: r.lines.filter((l) => l[1] === "err").map((l) => l[0]), code: r.code };
  }

  // --- matrices ---------------------------------------------------------------------------

  function expandMatrix(m) {
    if (!isObj(m)) return { combos: [{}] };
    const base = Object.entries(m).filter(([k]) => k !== "include" && k !== "exclude");
    for (const [k, v] of base) if (Array.isArray(v) && !v.length) return { error: `Matrix vector '${k}' does not contain any values` };
    let combos = [{}];
    for (const [k, v] of base) combos = combos.flatMap((c) => [].concat(v).map((x) => ({ ...c, [k]: x })));
    if (!base.length) combos = [];
    const same = (a, b) => (isObj(a) || isObj(b) ? JSON.stringify(a) === JSON.stringify(b) : looseEq(a, b) && typeof a === typeof b) || toStr(a) === toStr(b);
    for (const ex of [].concat(m.exclude || [])) if (isObj(ex)) combos = combos.filter((c) => !Object.entries(ex).every(([k, v]) => same(c[k], v)));
    const orig = new Set(base.map(([k]) => k));
    for (const inc of [].concat(m.include || [])) {
      if (!isObj(inc)) continue;
      let used = false;
      for (const c of combos) {
        if (Object.entries(inc).every(([k, v]) => !orig.has(k) || same(c[k], v))) { Object.assign(c, inc); used = true; }
      }
      if (!used) combos.push({ ...inc });
    }
    if (!combos.length) combos = [{}];
    return { combos };
  }

  // --- running a workflow --------------------------------------------------------------

  function githubContext(world, ev, wf, run) {
    const sha = hash(`${ev.id}:${run.version}:${ev.ref}:${run.number}`);
    const payload = ev.name.startsWith("pull_request") ? {
      action: "opened", number: ev.number,
      pull_request: { number: ev.number, title: ev.title, body: ev.body || "", merged: false, user: { login: ev.fork ? "drive-by-contributor" : "sandeep" },
        head: { ref: ev.head, sha: hash("head:" + ev.id), repo: { full_name: ev.fork ? `drive-by-contributor/${REPO}` : FULL, fork: !!ev.fork } },
        base: { ref: world.repo.defaultBranch, sha: hash("base:" + ev.id), repo: { full_name: FULL } } },
      repository: { full_name: FULL, private: world.repo.visibility === "private" }
    } : ev.name === "merge_group" ? { action: "checks_requested", merge_group: { head_sha: hash("mq:" + ev.id), head_ref: ev.ref, base_ref: `refs/heads/${world.repo.defaultBranch}`, base_sha: hash("base:" + ev.id) } }
      : ev.name === "workflow_dispatch" ? { inputs: ev.inputs, ref: ev.ref } : ev.name === "schedule" ? { schedule: toStr((wf.on.schedule || [])[0] && wf.on.schedule[0].cron) }
      : { ref: ev.ref, before: hash("before"), after: sha, head_commit: { id: sha, message: ev.message || "" }, commits: [{ id: sha, message: ev.message || "" }], repository: { full_name: FULL, default_branch: world.repo.defaultBranch } };
    const prRef = ev.name === "pull_request";
    return {
      event_name: ev.name, event: payload, ref: ev.ref, sha: ev.name === "pull_request_target" ? hash("base:" + ev.id) : sha,
      ref_name: ev.tag || ev.branch || (prRef ? `${ev.number}/merge` : ""), ref_type: ev.tag ? "tag" : "branch",
      head_ref: ev.name.startsWith("pull_request") ? ev.head : "", base_ref: ev.name.startsWith("pull_request") ? world.repo.defaultBranch : "",
      repository: FULL, repository_owner: OWNER, actor: ev.dependabot ? "dependabot[bot]" : ev.fork ? "drive-by-contributor" : "sandeep", triggering_actor: ev.dependabot ? "dependabot[bot]" : ev.fork ? "drive-by-contributor" : "sandeep",
      workflow: toStr(wf.name) || run.file, run_id: String(run.id), run_number: String(run.number), run_attempt: "1", server_url: "https://github.com",
      api_url: "https://api.github.com", workspace: WORK, token: "***", retention_days: "90", action: "", job: ""
    };
  }

  // Run the workflow file for one event. opts: { inputs, approve, store (cache and artifacts across runs), version, start }.
  function runWorkflow(world, files, file, ev, opts) {
    const store = opts.store;
    const run = { base: store.time, id: 18000000000 + store.runs, number: 40 + store.runs, file, event: ev, version: opts.version || world.version || 42, jobs: [], errors: [], annotations: [],
      effects: { leaks: [], sentOut: [], remote: [], deployed: [], oidc: [], shards: [], pushedTags: [], dispatched: [], pwned: false }, cache: [], waiting: [], start: opts.start || 0 };
    store.runs++;
    const text = files[file];
    if (text == null) { run.status = "missing"; run.reason = `${file} does not exist.`; return run; }
    const parsed = parse(text);
    if (parsed.error) {
      run.status = "invalid";
      run.errors.push(`Invalid workflow file: ${file}#L${parsed.error.line}`, parsed.error.message);
      run.detail = parsed.error.detail;
      run.errorLine = parsed.error.line;
      return run;
    }
    const wf = parsed.value;
    const errs = validate(wf, file);
    if (errs.length) {
      run.status = "invalid";
      run.errors.push(`Invalid workflow file: ${file}`, ...errs);
      const m = /\(Line: (\d+)/.exec(errs[0]);
      run.errorLine = m ? Number(m[1]) : null;
      return run;
    }
    run.name = toStr(wf.name) || file;
    const why = notTriggered(wf, ev);
    if (why) { run.status = "not-triggered"; run.reason = why; return run; }
    // workflow_dispatch inputs: defaults, required, choice.
    const inputs = {};
    if (ev.name === "workflow_dispatch" && isObj(wf.on) && isObj(wf.on.workflow_dispatch) && isObj(wf.on.workflow_dispatch.inputs)) {
      for (const [k, spec] of Object.entries(wf.on.workflow_dispatch.inputs)) {
        const s = isObj(spec) ? spec : {};
        let v = k in ev.inputs ? ev.inputs[k] : s.default;
        if ((v == null || v === "") && s.required === true) { run.status = "invalid"; run.errors.push(`Required input '${k}' not provided`); return run; }
        if (s.type === "choice" && v != null && !(s.options || []).map(toStr).includes(toStr(v))) { run.status = "invalid"; run.errors.push(`Provided value '${toStr(v)}' for input '${k}' not in the list of allowed values`); return run; }
        if (s.type === "boolean") v = v === true || v === "true";
        else if (s.type === "number") v = Number(v);
        else v = v == null ? "" : toStr(v);
        inputs[k] = v;
      }
      ev.inputs = inputs;
    }
    run.title = runName(wf, ev, world, run, inputs);
    const github = githubContext(world, ev, wf, run);
    run.github = github;
    run.wf = wf;
    executeJobs(run, wf, world, files, ev, github, inputs, opts, null);
    const conclusions = run.jobs.map((j) => j.conclusion);
    run.status = run.jobs.some((j) => /^(waiting|queued|pending)$/.test(j.status)) ? "waiting" : "completed";
    run.conclusion = run.status !== "completed" ? null : conclusions.includes("failure") ? "failure" : conclusions.includes("cancelled") ? "cancelled" : "success";
    run.end = Math.max(run.start, ...run.jobs.map((j) => (Number.isFinite(j.end) ? j.end : 0)));
    run.duration = run.end - run.start;
    store.time += Number.isFinite(run.end) ? run.end + 60 : 3600;
    const node20 = [...new Set(run.jobs.flatMap((j) => j.node20 || []))];
    if (node20.length) run.annotations.push(["warning", NODE20_WARNING(node20)]);
    return run;
  }

  function runName(wf, ev, world, run, inputs) {
    if (wf["run-name"]) { try { return interpolate(toStr(wf["run-name"]), { data: { github: { event_name: ev.name, actor: "sandeep", ref_name: ev.branch || ev.tag || "" }, inputs, vars: world.vars || {} } }); } catch { /* fall back below */ } }
    return ev.name.startsWith("pull_request") ? ev.title : ev.name === "push" ? ev.message || run.file : toStr(wf.name) || run.file;
  }

  // Order jobs so each comes after its needs. Within a level, keep file order.
  function order(jobs) {
    const done = new Set(), out = [];
    const ids = Object.keys(jobs);
    while (out.length < ids.length) {
      const next = ids.find((id) => !done.has(id) && [].concat(jobs[id].needs == null ? [] : jobs[id].needs).map(toStr).every((n) => done.has(n) || !(n in jobs)));
      if (!next) break;
      done.add(next);
      out.push(next);
    }
    return out;
  }

  // Run the jobs of one workflow; for a reusable workflow, call is its caller.
  function executeJobs(run, wf, world, files, ev, github, inputs, opts, call) {
    const results = {};
    const jobs = wf.jobs;
    const prefix = call ? call.prefix : "";
    for (const id of order(jobs)) {
      const job = jobs[id];
      const needs = [].concat(job.needs == null ? [] : job.needs).map(toStr);
      const needed = needs.map((n) => results[n]).filter(Boolean);
      const startAt = Math.max(call ? call.start : run.start, ...needed.map((r) => r.end), (opts.notBefore || {})[prefix + id] || 0);
      const needsCtx = Object.fromEntries(needs.map((n) => [n, results[n] ? { result: results[n].result, outputs: results[n].outputs } : { result: "skipped", outputs: {} }]));
      const status = needed.some((r) => r.result === "cancelled") ? "cancelled" : needed.some((r) => r.result === "failure") ? "failure" : "success";
      const baseCtx = { github: { ...github, job: id }, needs: needsCtx, vars: world.vars || {}, inputs: call ? call.inputs : inputs, strategy: {}, matrix: {} };
      const record = (r) => { results[id] = r; };
      const display = (name) => (call ? `${call.name} / ${name}` : name);
      // A pending approval or a job that never starts holds everything after it.
      if (needed.some((r) => r.result === "waiting" || r.result === "queued")) {
        run.jobs.push({ key: prefix + id, id, name: display(toStr(job.name) || id), needs: needs.map((n) => prefix + n), status: "pending", conclusion: null, steps: [], start: startAt, end: startAt });
        record({ result: "waiting", end: Infinity, outputs: {} });
        continue;
      }
      let cond = "success()";
      if ("if" in job) cond = ifExpr(job.if);
      if (job.if === true) cond = "success()"; else if (job.if === false) cond = "false";
      let go;
      try { go = truthy(evaluate(hasStatusFn(cond) ? cond : `success() && (${cond})`, { data: baseCtx, status })); } catch (e) { go = false; run.annotations.push(["error", e.message]); }
      if (!go) {
        run.jobs.push({ key: prefix + id, id, name: display(toStr(job.name) || id), needs: needs.map((n) => prefix + n), status: "completed", conclusion: "skipped", steps: [], start: startAt, end: startAt,
          note: status !== "success" ? `Skipped because a job it needs ended with ${status}.` : `Skipped: \`if: ${cond}\` was false for this ${ev.name} event.` });
        record({ result: "skipped", end: startAt, outputs: {} });
        continue;
      }
      if (job.uses != null) {
        record(callReusable(run, job, id, world, files, ev, github, opts, baseCtx, startAt, needs, prefix));
        continue;
      }
      // The matrix.
      let combos = [{}], strategy = isObj(job.strategy) ? job.strategy : {};
      let matrixError = null;
      if ("matrix" in strategy) {
        try {
          const m = value(strategy.matrix, { data: baseCtx });
          const ex = expandMatrix(m);
          if (ex.error) matrixError = ex.error; else combos = ex.combos;
        } catch (e) { matrixError = e.message; }
      }
      if (matrixError || combos.length > 256) {
        run.jobs.push({ key: prefix + id, id, name: display(id), needs, status: "completed", conclusion: "failure", steps: [], start: startAt, end: startAt,
          note: matrixError ? `Error when evaluating 'strategy' for job '${id}'. ${matrixError}` : `This matrix makes ${combos.length} jobs; GitHub runs at most 256 jobs per matrix.` });
        record({ result: "failure", end: startAt, outputs: {} });
        continue;
      }
      const isMatrix = "matrix" in strategy;
      const failFast = strategy["fail-fast"] !== false && toStr(strategy["fail-fast"]) !== "false";
      const maxPar = Math.min(CONCURRENT_JOBS, Number(strategy["max-parallel"]) || CONCURRENT_JOBS);
      const slots = Array(Math.min(maxPar, combos.length)).fill(startAt);
      const instances = [];
      combos.forEach((combo, index) => {
        const slot = slots.indexOf(Math.min(...slots));
        const ctx = { ...baseCtx, matrix: combo, strategy: { "fail-fast": failFast, "job-index": index, "job-total": combos.length, "max-parallel": maxPar } };
        let name = toStr(job.name) || id;
        try { if (job.name) name = interpolate(toStr(job.name), { data: ctx }); } catch { /* keep the raw name */ }
        if (isMatrix && !(typeof job.name === "string" && job.name.includes("${{"))) name = `${name} (${Object.values(combo).map((v) => (isObj(v) || Array.isArray(v) ? JSON.stringify(v) : toStr(v))).join(", ")})`;
        const j = runJob(run, job, id, display(name), ctx, world, files, ev, slots[slot], { ...opts, wf, call, needs: needs.map((n) => prefix + n), key: prefix + id + (isMatrix ? `#${index}` : "") });
        slots[slot] = Number.isFinite(j.end) ? j.end : Infinity;
        instances.push(j);
      });
      // fail-fast: the first failure cancels the matrix jobs still running or queued.
      if (isMatrix && failFast) {
        const firstFail = Math.min(...instances.filter((j) => j.conclusion === "failure").map((j) => j.end));
        if (Number.isFinite(firstFail)) {
          for (const j of instances) {
            if (j.conclusion !== "failure" && j.end > firstFail && j.status === "completed") {
              j.conclusion = "cancelled";
              j.end = Math.max(j.start, firstFail);
              const live = j.steps.find((s) => s.start + s.secs > firstFail - j.start) || j.steps[j.steps.length - 1];
              if (live) { live.conclusion = "cancelled"; live.lines.push(["Error: The operation was canceled.", "err"]); j.steps = j.steps.slice(0, j.steps.indexOf(live) + 1); }
              j.note = `Canceled by fail-fast: another job in this matrix failed first.`;
            }
          }
        }
      }
      run.jobs.push(...instances);
      const result = instances.some((j) => j.status === "waiting") ? "waiting" : instances.some((j) => j.status === "queued") ? "queued"
        : instances.some((j) => j.conclusion === "failure") ? "failure" : instances.some((j) => j.conclusion === "cancelled") ? "cancelled" : "success";
      record({ result, end: Math.max(...instances.map((j) => j.end)), outputs: Object.assign({}, ...instances.map((j) => j.outputs || {})) });
    }
    return results;
  }

  function callReusable(run, job, id, world, files, ev, github, opts, ctx, startAt, needs, prefix) {
    const uses = toStr(job.uses);
    const fail = (msg) => {
      run.jobs.push({ key: prefix + id, id, name: toStr(job.name) || id, needs, status: "completed", conclusion: "failure", steps: [], start: startAt, end: startAt, note: msg });
      run.errors.push(msg);
      return { result: "failure", end: startAt, outputs: {} };
    };
    const local = /^\.\/(\.github\/workflows\/[^@]+\.ya?ml)$/.exec(uses);
    if (!local) return fail(`The playground runs reusable workflows from this repository only (uses: ./.github/workflows/<file>.yml).`);
    const path = local[1];
    const ref = `error parsing called workflow "${run.file}" -> "${FULL}/${path}@${run.event.ref}"`;
    if (files[path] == null) return fail(`${ref} : failed to fetch workflow: workflow was not found.`);
    const parsed = parse(files[path]);
    if (parsed.error) return fail(`${ref} : ${parsed.error.message}`);
    const callee = parsed.value;
    const errs = validate(callee, path);
    if (errs.length) return fail(errs[0]);
    const wc = isObj(callee.on) ? callee.on.workflow_call : callee.on === "workflow_call" || (Array.isArray(callee.on) && callee.on.includes("workflow_call")) ? {} : undefined;
    if (wc === undefined) return fail(`${ref} : workflow is not reusable as it is missing a \`on.workflow_call\` trigger`);
    const spec = isObj(wc) ? wc : {};
    const inputs = {};
    const given = isObj(job.with) ? job.with : {};
    for (const k of keys(given)) if (!isObj(spec.inputs) || !(k in spec.inputs)) return fail(`Invalid input, ${k} is not defined in the referenced workflow.`);
    for (const [k, s] of Object.entries(isObj(spec.inputs) ? spec.inputs : {})) {
      const raw = k in given ? value(given[k], { data: ctx }) : isObj(s) ? s.default : undefined;
      if (raw === undefined && isObj(s) && s.required === true) return fail(`Input ${k} is required, but not provided while calling.`);
      inputs[k] = raw === undefined ? (isObj(s) && s.type === "boolean" ? false : isObj(s) && s.type === "number" ? 0 : "") : raw;
    }
    // Secrets: none, inherit, or an explicit map of declared names.
    let secrets = {};
    const callerSecrets = jobSecrets(world, ev, null);
    if (job.secrets === "inherit") secrets = callerSecrets;
    else if (isObj(job.secrets)) {
      for (const [k, v] of Object.entries(job.secrets)) {
        if (!isObj(spec.secrets) || !(k in spec.secrets)) return fail(`Invalid secret, ${k} is not defined in the referenced workflow.`);
        secrets[k] = toStr(value(v, { data: { ...ctx, secrets: callerSecrets } }));
      }
    }
    for (const [k, s] of Object.entries(isObj(spec.secrets) ? spec.secrets : {})) {
      if (isObj(s) && s.required === true && !secrets[k] && job.secrets !== "inherit") return fail(`Secret ${k} is required, but not provided while calling.`);
    }
    const cap = tokenPermissions(world, run.wf.permissions, job.permissions, ev);
    const calleeWf = { ...callee, permissions: callee.permissions !== undefined ? callee.permissions : job.permissions !== undefined ? job.permissions : run.wf.permissions };
    const results = executeJobs(run, calleeWf, { ...world, callerSecrets: secrets }, files, ev, github, inputs, opts, { prefix: prefix + id + "/", name: toStr(job.name) || id, inputs, start: startAt, cap });
    const all = Object.values(results);
    const result = all.some((r) => r.result === "waiting") ? "waiting" : all.some((r) => r.result === "failure") ? "failure" : all.some((r) => r.result === "cancelled") ? "cancelled" : "success";
    return { result, end: Math.max(startAt, ...all.map((r) => r.end)), outputs: {} };
  }

  // Which secrets a job can read. A reusable workflow sees only what it was passed.
  function jobSecrets(world, ev, envName) {
    if (world.callerSecrets) return { ...world.callerSecrets };
    if (ev.fork && ev.name === "pull_request") return {};
    // Dependabot's pull requests get Dependabot secrets, not Actions secrets.
    if (ev.dependabot) return { ...(world.dependabotSecrets || {}) };
    const env = envName && world.environments && world.environments[Object.keys(world.environments).find((k) => k.toLowerCase() === envName.toLowerCase())];
    return { ...(world.secrets || {}), ...(env && env.secrets ? env.secrets : {}) };
  }

  function runJob(run, job, id, name, ctx, world, files, ev, startAt, opts) {
    const j = { key: opts.key, id, name, needs: opts.needs, status: "completed", conclusion: "success", steps: [], start: startAt, end: startAt, outputs: {}, node20: [] };
    const fail = (note) => { j.conclusion = "failure"; j.note = note; return j; };
    let runsOn;
    try { runsOn = value(job["runs-on"], { data: ctx }); } catch (e) { if (!(e instanceof ExprError)) throw e; return fail(e.message); }
    const labels = [].concat(isObj(runsOn) ? runsOn.labels || [] : runsOn).map(toStr);
    j.runsOn = labels.join(", ");
    const hosted = ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04", "ubuntu-24.04-arm", "ubuntu-22.04-arm", "windows-latest", "windows-2025", "windows-2022", "macos-latest", "macos-15", "macos-14", "macos-26"];
    const selfLabels = (world.runners && world.runners.selfHosted) || [];
    const hostedOk = labels.length === 1 && hosted.includes(labels[0]);
    const selfOk = labels.includes("self-hosted") && labels.every((l) => l === "self-hosted" || selfLabels.includes(l));
    if (!hostedOk && !selfOk) {
      j.status = "queued";
      j.conclusion = null;
      j.end = Infinity;
      j.steps.push({ name: "Waiting for a runner", conclusion: null, lines: [[`Requested labels: ${labels.join(", ")}`, ""], [`Job defined at: ${FULL}/${run.file}@${ev.ref}`, ""], ["Waiting for a runner to pick up this job...", ""]], secs: 0, start: 0 });
      j.note = "No runner has these labels, so the job waits. After 24 hours GitHub cancels it.";
      return j;
    }
    if (labels.includes("self-hosted")) run.effects.selfHosted = true;
    j.os = /windows/.test(labels[0]) ? "Windows" : /macos/.test(labels[0]) ? "macOS" : "Linux";
    // Environment protection.
    let envName = null;
    try { envName = job.environment == null ? null : toStr(isObj(job.environment) ? value(job.environment.name, { data: ctx }) : value(job.environment, { data: ctx })) || null; } catch (e) { if (!(e instanceof ExprError)) throw e; return fail(e.message); }
    const envKey = envName && world.environments ? Object.keys(world.environments).find((k) => k.toLowerCase() === envName.toLowerCase()) : null;
    const envSpec = envKey ? world.environments[envKey] : null;
    if (envKey) envName = envKey;
    j.environment = envName;
    if (envSpec && envSpec.branches) {
      const ok = ev.tag ? (envSpec.tags || []).some((p) => filterMatch([p], ev.tag)) : ev.branch && envSpec.branches.some((p) => filterMatch([p], ev.branch));
      if (!ok) return fail(`${ev.tag ? `Tag "${ev.tag}"` : `Branch "${ev.branch || ev.head}"`} is not allowed to deploy to ${envName} due to environment protection rules.`);
    }
    if (envSpec && envSpec.reviewers && envSpec.reviewers.length) {
      run.effects.approvals = (run.effects.approvals || []).concat(envName);
      if (!opts.approve) {
        j.status = "waiting";
        j.conclusion = null;
        j.end = Infinity;
        j.note = `Waiting for review: ${envSpec.reviewers.join(", ")} must approve deploying to ${envName}.`;
        run.waiting.push(envName);
        return j;
      }
      j.approvedBy = envSpec.reviewers[0];
    }
    // The token and the secrets this job gets.
    const perms = tokenPermissions(world, opts.wf.permissions, job.permissions, ev);
    // A called workflow can keep or lower the caller's permissions, never raise them.
    if (opts.call) for (const k of Object.keys(perms)) if (perms[k] !== opts.call.cap[k] && opts.call.cap[k] !== "write") { if (opts.call.cap[k]) perms[k] = opts.call.cap[k]; else delete perms[k]; }
    j.perms = perms;
    const secrets = { ...jobSecrets(world, ev, envName), GITHUB_TOKEN: `ghs_quest${hash(run.id + id).slice(0, 28)}` };
    j.secretsAvailable = Object.keys(secrets).filter((k) => k !== "GITHUB_TOKEN");
    ctx = { ...ctx, github: { ...ctx.github, token: secrets.GITHUB_TOKEN } };
    const sx = {
      world, ev, run, files, job, github: ctx.github, perms, secrets, secretValues: Object.values(secrets).filter((v) => v && String(v).length > 2).map(String),
      ws: null, env: {}, newEnv: {}, stepOutputs: {}, artifacts: opts.store.artifacts[run.id] = opts.store.artifacts[run.id] || {},
      post: [], effects: run.effects, annotations: run.annotations, disk: { free: world.diskGB != null ? world.diskGB : 20 }, version: run.version,
      pipefail: false, untrusted: false, oidc: run.effects.oidc,
      cacheGet: (key, restore) => {
        // A cache is visible once saved, on its own branch and on the default branch.
        const branchOk = (k) => { const c = opts.store.cache[k]; return c && c.at <= run.base + j.start + elapsed && (c.branch === world.repo.defaultBranch || c.branch === (ev.branch || ev.head)); };
        if (branchOk(key)) { run.cache.push({ key, hit: true }); return key; }
        const r = restore.map((p) => Object.keys(opts.store.cache).find((k) => k.startsWith(p) && branchOk(k))).find(Boolean);
        run.cache.push({ key, hit: false, restored: r || null });
        return r || null;
      },
      cacheHas: (key) => !!opts.store.cache[key],
      cacheSet: (key) => { opts.store.cache[key] = { branch: ev.branch || ev.head || world.repo.defaultBranch, at: run.base + j.start + elapsed }; },
      oidcSub: () => (envName ? `repo:${FULL}:environment:${envName}` : ev.name === "pull_request" ? `repo:${FULL}:pull_request` : `repo:${FULL}:ref:${ev.ref}`),
      deploy: (target, secs) => run.effects.deployed.push({ env: target, version: run.version, from: j.start + elapsed, at: j.start + elapsed + secs, run: run.id, job: id })
    };
    sx.remoteScript = (body) => { if (/curl|wget/.test(body) && Object.keys(secrets).length > 1) sx.effects.pwned = sx.effects.pwned || /attacker|evil/.test(body); };
    let elapsed = 0;
    const limit = Number(value(job["timeout-minutes"], { data: ctx })) || DEFAULT_TIMEOUT;
    j.timeout = limit;
    const wfEnv = {}, jobEnv = {};
    try {
      for (const [k, v] of Object.entries(isObj(opts.wf.env) ? opts.wf.env : {})) wfEnv[k] = toStr(value(v, { data: { ...ctx, secrets, env: {} } }));
      for (const [k, v] of Object.entries(isObj(job.env) ? job.env : {})) jobEnv[k] = toStr(value(v, { data: { ...ctx, secrets, env: wfEnv } }));
    } catch (e) { if (!(e instanceof ExprError)) throw e; return fail(e.message); }
    let userEnv = { ...wfEnv, ...jobEnv };

    // Set up job: runner, token, actions.
    const setup = [["Current runner version: '2.329.0'", ""], ["Runner Image Provisioner", "dim"], [`Runner Image: ${labels[0] === "ubuntu-22.04" ? "ubuntu-22.04" : j.os === "Linux" ? "ubuntu-24.04" : labels[0]}`, ""], ["GITHUB_TOKEN Permissions", "grp"],
      ...Object.entries(perms).sort().map(([k, v]) => [`  ${PERM_LABEL(k)}: ${v}`, ""]), [`Secret source: ${ev.dependabot ? "Dependabot" : j.secretsAvailable.length || !ev.fork ? "Actions" : "None"}`, ""], ["Prepare workflow directory", ""], ["Prepare all required actions", ""]];
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const resolved = [];
    for (const step of steps) {
      if (!isObj(step) || step.uses == null || /^(\.\/|docker:\/\/)/.test(toStr(step.uses))) { resolved.push(null); continue; }
      const a = resolveAction(toStr(step.uses), world);
      if (a.error) { setup.push([`Error: ${a.error}`, "err"]); j.steps.push({ name: "Set up job", conclusion: "failure", lines: setup, secs: 1, start: 0 }); j.end = startAt + 1; return fail(a.error); }
      if ((a.name === "actions/upload-artifact" || a.name === "actions/download-artifact") && a.major === 3) {
        const msg = ARTIFACT_V3(a.name);
        setup.push(["Getting action download info", ""], [`Error: ${msg}`, "err"]);
        j.steps.push({ name: "Set up job", conclusion: "failure", lines: setup, secs: 1, start: 0 });
        j.end = startAt + 1;
        return fail(msg);
      }
      resolved.push(a);
    }
    const downloads = [...new Map(resolved.filter(Boolean).map((a) => [`${a.repo}@${a.ref}`, a])).values()];
    if (downloads.length) setup.push(["Getting action download info", ""], ...downloads.map((a) => [`Download action repository '${a.repo}@${a.ref}' (SHA:${a.sha})`, ""]));
    j.node20 = [...new Set(resolved.filter((a) => a && a.runtime === "node20").map((a) => `${a.name}@${a.ref}`))];
    setup.push([`Complete job name: ${name}`, ""]);
    j.steps.push({ name: "Set up job", conclusion: "success", lines: setup, secs: 1, start: 0 });
    elapsed = 1;

    const stepsCtx = {};
    let jobStatus = "success";
    const runSteps = (list, inputsCtx, resolvedList) => {
      list.forEach((step, si) => {
        if (!isObj(step)) return;
        const a = resolvedList ? resolvedList[si] : null;
        const sctx = () => ({ data: { ...ctx, secrets, env: { ...userEnv }, steps: stepsCtx, job: { status: jobStatus }, runner: { os: j.os, arch: "X64", name: "GitHub Actions 3", temp: "/home/runner/work/_temp", tool_cache: "/opt/hostedtoolcache" },
          inputs: inputsCtx || ctx.inputs }, status: jobStatus, hashFiles: (p) => hashFilesIn(sx.ws, p) });
        let label = step.name != null ? toStr(step.name) : step.uses != null ? `Run ${toStr(step.uses)}` : `Run ${toStr(step.run).split("\n")[0]}`;
        try { if (step.name != null) label = interpolate(toStr(step.name), sctx()); } catch { /* keep the raw name */ }
        const rec = { name: label, conclusion: "success", lines: [], secs: 0, start: elapsed, id: step.id != null ? toStr(step.id) : null };
        let cond = "success()";
        if ("if" in step) cond = step.if === true ? "success()" : step.if === false ? "false" : ifExpr(step.if);
        let go;
        try { go = truthy(evaluate(hasStatusFn(cond) ? cond : `success() && (${cond})`, sctx())); } catch (e) { rec.lines.push([`Error: ${e.message}`, "err"]); go = false; jobStatus = "failure"; rec.conclusion = "failure"; }
        if (!go) {
          if (rec.conclusion !== "failure") rec.conclusion = "skipped";
          if (rec.id) stepsCtx[rec.id] = { outputs: {}, outcome: "skipped", conclusion: "skipped" };
          j.steps.push(rec);
          return;
        }
        if (elapsed >= limit * 60) return;
        let stepEnv = {};
        let outcome = "success";
        sx.stepOutputs = {};
        sx.newEnv = {};
        try {
          for (const [k, v] of Object.entries(isObj(step.env) ? step.env : {})) stepEnv[k] = toStr(value(v, sctx()));
          const header = [];
          if (step.run != null) {
            const scriptText = interpolate(toStr(step.run), sctx());
            // Windows runners default to pwsh; Linux and macOS to bash -e.
            const shell = toStr(step.shell || (isObj(job.defaults) && isObj(job.defaults.run) && job.defaults.run.shell) || (isObj(opts.wf.defaults) && isObj(opts.wf.defaults.run) && opts.wf.defaults.run.shell) || (j.os === "Windows" ? "pwsh" : ""));
            header.push(...scriptText.replace(/\n$/, "").split("\n").map((l) => ["  " + l, "cmd"]));
            const win = j.os === "Windows";
            const shellLine = !shell ? "/usr/bin/bash -e {0}" : shell === "bash" ? (win ? "C:\\Program Files\\Git\\bin\\bash.EXE" : "/usr/bin/bash") + " --noprofile --norc -e -o pipefail {0}"
              : shell === "sh" ? "/usr/bin/sh -e {0}" : shell === "pwsh" ? (win ? "C:\\Program Files\\PowerShell\\7\\pwsh.EXE" : "/usr/bin/pwsh") + " -command \". '{0}'\""
                : shell === "powershell" ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE -command \". '{0}'\"" : shell === "cmd" ? "C:\\Windows\\system32\\cmd.EXE /D /E:ON /V:OFF /S /C \"CALL \"{0}\"\"" : shell;
            header.push([`  shell: ${shellLine}`, "dim"]);
            const allEnv = { ...userEnv, ...stepEnv };
            if (Object.keys(allEnv).length) header.push(["  env:", "dim"], ...Object.entries(allEnv).map(([k, v]) => [`    ${k}: ${v}`, "dim"]));
            sx.env = { CI: "true", GITHUB_ACTIONS: "true", HOME: "/home/runner", RUNNER_OS: j.os, RUNNER_TEMP: "/home/runner/work/_temp", GITHUB_WORKSPACE: WORK,
              GITHUB_REPOSITORY: FULL, GITHUB_REF: ev.ref, GITHUB_REF_NAME: ctx.github.ref_name, GITHUB_SHA: ctx.github.sha, GITHUB_EVENT_NAME: ev.name, GITHUB_RUN_ID: ctx.github.run_id,
              GITHUB_ACTOR: ctx.github.actor, GITHUB_OUTPUT: FILES.output, GITHUB_ENV: FILES.env, GITHUB_STEP_SUMMARY: FILES.summary, GITHUB_PATH: FILES.path, ...allEnv };
            if (sx.aws) Object.assign(sx.env, { AWS_ACCESS_KEY_ID: "ASIA_PLAYGROUND_ONLY", AWS_REGION: "eu-west-1" });
            sx.pipefail = shell === "bash";
            sx.errexit = shell !== "cmd";
            sx.dialect = /^(pwsh|powershell|cmd)$/.test(shell) ? shell : null;
            if (!/^(bash|sh|pwsh|powershell|cmd|)$/.test(shell)) {
              rec.lines.push(...header, [`(the playground runs bash scripts; this ${shell} script is shown but not run)`, "dim"]);
            } else {
              const r = runScript(scriptText, sx, { errexit: true });
              rec.lines.push(...header, ...r.lines);
              rec.secs = r.secs;
              if (r.hang) { rec.secs = Infinity; outcome = "hang"; }
              else if (r.code !== 0) { rec.lines.push([`Error: Process completed with exit code ${r.code}.`, "err"]); outcome = "failure"; }
            }
          } else if (step.uses != null) {
            const uses = toStr(step.uses);
            const w = {};
            for (const [k, v] of Object.entries(isObj(step.with) ? step.with : {})) w[k] = value(v, sctx());
            if (Object.keys(w).length) header.push(["  with:", "dim"], ...Object.entries(w).map(([k, v]) => [`    ${k}: ${toStr(v)}`, "dim"]));
            rec.lines.push(...header);
            sx.stepUses = uses;
            if (uses.startsWith("./")) {
              const dir = uses.slice(2).replace(/\/$/, "");
              const manifest = sx.ws && (sx.ws[dir + "/action.yml"] != null ? dir + "/action.yml" : sx.ws[dir + "/action.yaml"] != null ? dir + "/action.yaml" : null);
              if (!manifest) throw new StepError(`Can't find 'action.yml', 'action.yaml' or 'Dockerfile' under '${WORK}/${dir}'. Did you forget to run actions/checkout before running your local action?`);
              const text = files[manifest] != null ? files[manifest] : sx.ws[manifest];
              const p = parse(text);
              if (p.error) throw new StepError(`${WORK}/./${manifest}: ${p.error.message}`);
              const act = p.value;
              if (!isObj(act) || !isObj(act.runs)) throw new StepError(`${WORK}/./${manifest} (Line: 1, Col: 1): Required property is missing: runs`);
              if (toStr(act.runs.using) !== "composite") { rec.lines.push([`(the playground runs composite actions; this one uses ${toStr(act.runs.using)})`, "dim"]); }
              else {
                const actInputs = {};
                for (const [k, s] of Object.entries(isObj(act.inputs) ? act.inputs : {})) actInputs[k] = k in w ? w[k] : isObj(s) && s.default != null ? s.default : "";
                const inner = Array.isArray(act.runs.steps) ? act.runs.steps : [];
                // The manifest is checked before any of its steps run.
                const noShell = inner.find((st) => isObj(st) && st.run != null && st.shell == null);
                if (noShell) { const p = at(noShell, "run"); throw new StepError(`${WORK}/./${manifest} (Line: ${p ? p.line : 1}, Col: ${p ? p.col : 1}): Required property is missing: shell`); }
                const before = j.steps.length;
                runSteps(inner, actInputs, inner.map(() => null));
                const sub = j.steps.splice(before);
                for (const s of sub) { rec.lines.push([`▸ ${s.name}`, "grp"], ...s.lines); rec.secs += s.secs; if (s.conclusion === "failure") outcome = "failure"; }
              }
            } else if (uses.startsWith("docker://")) {
              rec.lines.push([`/usr/bin/docker run --rm ${uses.slice(9)}`, "cmd"]);
              rec.secs = 15;
            } else {
              const res = a || resolveAction(uses, world);
              const impl = res.custom ? res.custom.run : ACTIONS[res.name];
              const r = impl ? impl(sx, w, res) : { lines: [[`(the playground does not model ${res.name}; it is treated as succeeding)`, "dim"]], secs: 3 };
              rec.lines.push(...(r.lines || []).map((l) => (Array.isArray(l) ? l : [l, ""])));
              rec.secs = r.secs || 0;
              if (r.outputs) Object.assign(sx.stepOutputs, r.outputs);
              if (r.warn) sx.annotations.push(["warning", r.warn]);
              if (r.fail) { rec.lines.push(...r.fail.map((l, i) => [i === 0 ? `Error: ${l}` : l, "err"])); outcome = "failure"; }
            }
          }
        } catch (e) {
          if (!(e instanceof ExprError || e instanceof StepError)) throw e;
          rec.lines.push([`Error: ${e.message}`, "err"]);
          outcome = "failure";
        }
        // A step may not run longer than the job's time left, or its own timeout.
        const stepLimit = Number(value(step["timeout-minutes"], sctx())) || Infinity;
        const left = limit * 60 - elapsed;
        if (rec.secs > Math.min(left, stepLimit * 60)) {
          if (stepLimit * 60 < left) {
            rec.secs = stepLimit * 60;
            rec.lines.push([`Error: The action '${label}' has timed out after ${stepLimit} minutes.`, "err"]);
            outcome = "failure";
          } else {
            rec.secs = left;
            rec.lines.push(["Error: The operation was canceled.", "err"]);
            outcome = "cancelled";
            j.timedOut = true;
            run.annotations.push(["error", `The job running on runner GitHub Actions 3 has exceeded the maximum execution time of ${limit} minutes.`]);
          }
        }
        // Mask secrets; a transformed secret (base64) is not recognised.
        rec.lines = rec.lines.map(([t, c]) => [sx.secretValues.reduce((s, v) => (v ? s.split(v).join("***") : s), t), c]);
        elapsed += rec.secs;
        const coe = step["continue-on-error"] === true || toStr(step["continue-on-error"]) === "true";
        rec.outcome = outcome === "hang" ? "cancelled" : outcome;
        rec.conclusion = outcome === "failure" && coe ? "success" : rec.outcome;
        if (outcome === "failure" && coe) rec.continued = true;
        if (rec.conclusion === "failure") jobStatus = "failure";
        if (rec.conclusion === "cancelled") jobStatus = "cancelled";
        Object.assign(userEnv, sx.newEnv);
        if (rec.id) stepsCtx[rec.id] = { outputs: { ...sx.stepOutputs }, outcome: rec.outcome, conclusion: rec.conclusion };
        j.steps.push(rec);
      });
    };
    runSteps(steps, null, resolved);
    // Post steps run in reverse, and save caches only when the job succeeded.
    for (const p of sx.post.reverse()) {
      const lines = jobStatus === "success" ? p.run() : [["Skipping because the job did not succeed.", "dim"]];
      j.steps.push({ name: p.name, conclusion: "success", lines: lines.map((l) => (Array.isArray(l) ? l : [l, ""])), secs: 1, start: elapsed });
      elapsed += 1;
    }
    j.steps.push({ name: "Complete job", conclusion: "success", lines: [["Cleaning up orphan processes", ""]], secs: 0, start: elapsed });
    const coeJob = job["continue-on-error"] === true || toStr(job["continue-on-error"]) === "true";
    j.conclusion = jobStatus === "failure" ? (coeJob ? "success" : "failure") : jobStatus;
    j.end = startAt + elapsed;
    j.duration = elapsed;
    try { for (const [k, v] of Object.entries(isObj(job.outputs) ? job.outputs : {})) j.outputs[k] = toStr(value(v, { data: { ...ctx, secrets, steps: stepsCtx, env: userEnv } })); } catch { /* outputs that fail to evaluate are empty */ }
    // Outputs that contain a secret are not passed on.
    for (const [k, v] of Object.entries(j.outputs)) if (sx.secretValues.some((s) => s && v.includes(s))) { j.outputs[k] = ""; run.annotations.push(["warning", `Skip output '${k}' since it may contain secret.`]); }
    if (sx.untrusted) run.effects.untrusted = true;
    run.effects.persisted = run.effects.persisted || (sx.persisted && sx.untrusted);
    return j;
  }

  // --- triggering, with concurrency across two runs --------------------------------------

  // A run's concurrency group, evaluated with that run's own github context.
  function concurrencyOf(wf, run, world) {
    const c = wf && wf.concurrency;
    if (c == null || !run.github) return null;
    try {
      const ctx = { data: { github: run.github, inputs: run.event.inputs, vars: world.vars || {} } };
      if (typeof c === "string") return { group: interpolate(c, ctx), cancel: false };
      if (isObj(c)) return { group: interpolate(toStr(c.group), ctx), cancel: truthy(value(c["cancel-in-progress"], ctx)) };
    } catch { return null; }
    return null;
  }
  const jobConcurrency = (job, run, world) => (isObj(job) && job.concurrency != null ? concurrencyOf({ concurrency: job.concurrency }, run, world) : null);
  const sameGroup = (x, y) => x && y && x.group && x.group === y.group;

  // Send an event: returns the runs it started (two for "push-twice").
  function trigger(world, files, eventId, opts = {}) {
    const store = opts.store || newStore();
    const file = world.workflow || Object.keys(files).find((f) => /^\.github\/workflows\//.test(f));
    const ev = eventFor(world, eventId, opts.inputs);
    if (!ev.twice) return withChecks(world, ev, followUps(world, files, file, [runWorkflow(world, files, file, ev, { ...opts, store })], { ...opts, store }));
    // Two pushes 30 seconds apart: the newer one is version 43.
    const a = runWorkflow(world, files, file, { ...ev }, { ...opts, store, version: 42, start: 0 });
    let b = runWorkflow(world, files, file, { ...ev }, { ...opts, store, version: 43, start: 30 });
    if (a.status !== "completed" && a.status !== "waiting") return withChecks(world, ev, [a, b]);
    const wf = a.wf;
    const wfc = concurrencyOf(wf, a, world);
    if (sameGroup(wfc, concurrencyOf(wf, b, world))) {
      if (wfc.cancel) cancelAfter(a, 30, wfc.group);
      else b = runWorkflow(world, files, file, { ...ev }, { ...opts, store, version: 43, start: a.end });
      b.queuedBehind = wfc.cancel ? null : wfc.group;
    } else {
      // Job-level groups: the newer run's job waits for, or cancels, the older one.
      const notBefore = {};
      let changed = false;
      for (const [id, job] of Object.entries(wf.jobs)) {
        const jc = jobConcurrency(job, a, world);
        if (!sameGroup(jc, jobConcurrency(job, b, world))) continue;
        const ja = a.jobs.find((j) => j.key === id), jb = b.jobs.find((j) => j.key === id);
        if (!ja || !jb || !(jb.start < ja.end)) continue;
        if (jc.cancel) cancelJob(a, ja, jb.start, jc.group);
        else { notBefore[id] = ja.end; changed = true; }
      }
      if (changed) b = runWorkflow(world, files, file, { ...ev }, { ...opts, store, version: 43, start: 30, notBefore });
    }
    return withChecks(world, ev, [a, b]);
  }

  // Events a run caused start other workflows, except events caused by the GITHUB_TOKEN
  // (workflow_dispatch is the exception), so a workflow cannot start itself in a loop.
  function followUps(world, files, main, runs, opts) {
    const others = Object.keys(files).filter((f) => f !== main && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
    const out = [...runs];
    for (const r of runs) {
      for (const t of r.effects.pushedTags.filter((x) => x.by !== "github")) {
        for (const f of others) {
          const ev = { ...eventFor(world, "push-tag"), ref: `refs/tags/${t.tag}`, tag: t.tag, branch: null, message: `Tag ${t.tag}`, label: `Tag ${t.tag} pushed by the workflow` };
          const next = runWorkflow(world, files, f, ev, opts);
          if (next.status !== "not-triggered") out.push(next);
        }
      }
      for (const d of r.effects.dispatched) {
        const f = others.find((x) => x.endsWith("/" + d.file));
        if (!f) continue;
        const ref = /^refs\//.test(d.ref) ? d.ref : (world.tags || []).includes(d.ref) || /^v\d/.test(d.ref) ? `refs/tags/${d.ref}` : `refs/heads/${d.ref}`;
        const ev = { ...eventFor(world, "dispatch", d.inputs), ref, label: `${d.file} started by gh workflow run` };
        ev.branch = ref.startsWith("refs/heads/") ? ref.slice(11) : null;
        ev.tag = ref.startsWith("refs/tags/") ? ref.slice(10) : null;
        out.push(runWorkflow(world, files, f, ev, opts));
      }
    }
    return out;
  }

  // Required status checks, as the pull request's merge box shows them.
  function withChecks(world, ev, runs) {
    if (!world.requiredChecks || !(ev.name === "pull_request" || ev.name === "merge_group")) return runs;
    const jobs = runs.flatMap((r) => r.jobs || []);
    runs[0].required = world.requiredChecks.map((name) => {
      const js = jobs.filter((j) => j.name === name);
      const state = !js.length ? "expected" : js.some((j) => !j.conclusion) ? "pending" : js.every((j) => j.conclusion === "success" || j.conclusion === "skipped") ? "success" : "failure";
      return { name, state };
    });
    return runs;
  }

  function cancelAfter(run, t, group) {
    for (const j of run.jobs) if (j.end > t && j.status === "completed" && j.conclusion !== "skipped") cancelJob(run, j, t, group);
    run.conclusion = "cancelled";
  }
  function cancelJob(run, j, t, group) {
    j.conclusion = "cancelled";
    j.end = Math.max(j.start, t);
    j.note = `Canceling since a higher priority waiting request for '${group}' exists`;
    run.annotations.push(["error", `Canceling since a higher priority waiting request for '${group}' exists`]);
    run.effects.deployed = run.effects.deployed.filter((d) => !(d.job === j.id && d.at > t));
    if (run.jobs.every((x) => x.conclusion !== "failure")) run.conclusion = "cancelled";
  }

  const newStore = () => ({ cache: {}, artifacts: {}, runs: 0, time: 0 });

  root.AQEngine = { trigger, newStore, validate, evaluate, interpolate, parseExpr, expandMatrix, filterMatch, notTriggered, resolveAction, trustAllows, hashFilesIn,
    runScript, shellTokens, EVENT_TYPES, NODE20_WARNING, fmtSecs, toStr, FULL, WORK, SHAS, RUNTIMES, ExprError };
})(typeof window !== "undefined" ? window : globalThis);
