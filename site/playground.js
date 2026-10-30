// The playground page: an editor for the scenario's files, events to send,
// the run drawn job by job, the live checks, and a small gh console.
// All the work happens in engine.js and scenarios.js; this file only draws.
"use strict";

(function () {
  const { h, store, copyLink } = window.AQUI;
  const E = window.AQEngine;
  const { SCENARIOS, GROUPS, verify, status, worldOf, gh } = window.AQScenarios;
  const $ = (id) => document.getElementById(id);
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  let sc = SCENARIOS[0];
  let session; // { files, world, store, runs, open: current file, hint: hints shown, solved }
  let shown = []; // runs from the last event
  let selected = null; // key of the job whose steps are shown
  let checkTimer = null, animTimer = null;

  const solvedIds = () => new Set(store.get("solved", []));
  const savedFiles = (id) => store.get("files:" + id, null);

  // --- picker -----------------------------------------------------------------
  function renderPicker() {
    const done = solvedIds();
    $("pg-scenarios").replaceChildren(...GROUPS.map(([group, ids]) => h("div.pg-group", null,
      h("span.pg-group-name", null, group, h("span.pg-group-count" + (ids.every((i) => done.has(i)) ? ".done" : ""), null, `${ids.filter((i) => done.has(i)).length}/${ids.length}`)),
      h("div.pg-group-items", null, ids.map((id) => {
        const s = SCENARIOS.find((x) => x.id === id);
        return h("button.pg-scn", { type: "button", "aria-pressed": String(s === sc), title: s.title, onclick: () => load(id, true) },
          done.has(id) ? h("span.pg-scn-done", { "aria-hidden": "true" }, "✓") : null, s.title);
      })))));
    const cur = $("pg-scenarios").querySelector('[aria-pressed="true"]');
    if (cur && $("pg-scenarios").scrollWidth > $("pg-scenarios").clientWidth) $("pg-scenarios").scrollLeft = cur.offsetLeft - 40;
  }

  // --- brief: story, goal, live checks, hints --------------------------------
  function renderBrief() {
    const level = window.QUEST.levels.find((l) => l.id === sc.level);
    $("pg-brief").replaceChildren(
      h("div.pg-brief-top", null,
        h("div", null, h("p.tag", null, `${sc.group} · Level ${sc.level}${level ? " · " + level.title : ""}`), h("h3", null, sc.title)),
        h("div.pg-brief-actions", null,
          h("button.chip", { type: "button", onclick: hint }, "Hint"),
          h("button.chip", { type: "button", onclick: reset }, "Reset files"),
          h("button.chip", { type: "button", onclick: (e) => copyLink("play/" + sc.id, e.currentTarget) }, "Copy link"))),
      h("p.pg-story", null, sc.story),
      h("p.pg-goal" + (session.solved ? ".done" : ""), { id: "pg-goal" }, session.solved ? "Fixed. " + sc.lesson : "Goal: " + sc.goal),
      h("ul.pg-checks", { id: "pg-checks", "aria-label": "Checks" }),
      h("div.pg-hints", { id: "pg-hints", "aria-live": "polite" }, sc.hints.slice(0, session.hint).map((t, i) => h("p", null, h("strong", null, `Hint ${i + 1}. `), ...window.AQUI.rich(t)))));
    renderChecks();
  }
  function hint() {
    session.hint = Math.min(sc.hints.length, session.hint + 1);
    $("pg-hints").replaceChildren(...sc.hints.slice(0, session.hint).map((t, i) => h("p", null, h("strong", null, `Hint ${i + 1}. `), ...window.AQUI.rich(t))));
  }

  // The checks run the scenario's events on the current files.
  let lastStatus = [];
  function renderChecks() {
    try { lastStatus = status(sc, verify(sc, session.files, session.world)); } catch { lastStatus = sc.checks.map(([l]) => [l, false]); }
    $("pg-checks").replaceChildren(...lastStatus.map(([label, pass]) => h("li" + (pass ? ".ok" : ""), null,
      h("span.pg-check", { "aria-hidden": "true" }, pass ? "✓" : "○"), label, h("span.sr", null, pass ? " (passing)" : " (not yet)"))));
    return lastStatus.every(([, p]) => p);
  }
  const checkSoon = () => { clearTimeout(checkTimer); checkTimer = setTimeout(renderChecks, 300); };

  // --- editor -------------------------------------------------------------------
  function renderFiles() {
    $("pg-files").replaceChildren(...Object.keys(sc.files).map((f) => h("button", {
      type: "button", role: "tab", "aria-selected": String(f === session.open), onclick: () => { session.open = f; renderFiles(); }
    }, f.replace(/^\.github\/workflows\//, ""))));
    const ta = $("pg-code");
    ta.value = session.files[session.open];
    ta.setAttribute("aria-label", "Edit " + session.open);
    gutter();
  }
  function gutter() {
    const text = $("pg-code").value;
    const p = /\.ya?ml$/.test(session.open) ? window.AQYaml.parse(text) : null;
    const bad = p && p.error ? p.error.line : null;
    const n = text.split("\n").length;
    $("pg-gutter").replaceChildren(...Array.from({ length: n }, (_, i) => h("span" + (i + 1 === bad ? ".bad" : ""), null, String(i + 1))));
    $("pg-gutter").scrollTop = $("pg-code").scrollTop;
    $("pg-yaml-error").textContent = bad ? `Line ${bad}: ${p.error.detail}` : "";
  }
  function onEdit() {
    session.files[session.open] = $("pg-code").value;
    store.set("files:" + sc.id, session.files);
    gutter();
    checkSoon();
  }

  // --- events --------------------------------------------------------------------
  function renderEvents() {
    const sel = $("pg-event");
    const evs = sc.events;
    sel.replaceChildren(...evs.map((id) => h("option", { value: id }, ((session.world.events || {})[id] || {}).label || E.EVENT_TYPES[id].label)));
    renderInputs();
  }
  // workflow_dispatch: a field for each input the workflow declares.
  function renderInputs() {
    const box = $("pg-inputs");
    box.replaceChildren();
    if ($("pg-event").value !== "dispatch") return;
    const p = window.AQYaml.parse(session.files[Object.keys(session.files)[0]] || "");
    const on = p.value && p.value.on;
    const inputs = on && typeof on === "object" && on.workflow_dispatch && typeof on.workflow_dispatch === "object" ? on.workflow_dispatch.inputs || {} : {};
    for (const [name, spec] of Object.entries(inputs || {})) {
      const s = spec && typeof spec === "object" ? spec : {};
      const field = Array.isArray(s.options)
        ? h("select", { "data-input": name }, s.options.map((o) => h("option", { value: E.toStr(o), selected: E.toStr(o) === E.toStr(s.default) }, E.toStr(o))))
        : h("input", { type: "text", "data-input": name, value: E.toStr(s.default), spellcheck: "false" });
      box.append(h("label.pg-input", null, name, field));
    }
  }
  const inputsNow = () => Object.fromEntries([...$("pg-inputs").querySelectorAll("[data-input]")].map((el) => [el.dataset.input, el.value]));

  function send(id, inputs, approve) {
    shown = E.trigger(session.world, session.files, id, { store: session.store, inputs, approve });
    session.runs.push(...shown);
    session.lastEvent = { id, inputs };
    selected = null;
    renderRuns(true);
    const won = renderChecks();
    if (won && !session.solved) solve();
  }

  function solve() {
    session.solved = true;
    store.set("solved", [...solvedIds(), sc.id]);
    renderPicker();
    const b = $("pg-scenarios").querySelector('[aria-pressed="true"]');
    if (b) b.classList.add("just-solved");
    const goal = $("pg-goal");
    goal.className = "pg-goal done";
    const next = SCENARIOS.find((s) => !solvedIds().has(s.id));
    goal.replaceChildren(h("strong", null, "Fixed. "), sc.lesson, " ", next ? h("button.linkish", { type: "button", onclick: () => load(next.id, true) }, `Next: ${next.title}`) : "You solved every scenario.");
  }

  // --- the run -------------------------------------------------------------------
  const ICON = { success: "✓", failure: "✕", cancelled: "⊘", skipped: "–", waiting: "◷", queued: "◷", pending: "…" };
  const stateOf = (j) => j.conclusion || j.status;

  function renderRuns(animate) {
    clearTimeout(animTimer);
    const outEl = $("pg-output");
    if (!shown.length) { outEl.replaceChildren(h("p.muted.pg-empty", null, "Choose an event and select Run. The run appears here, job by job.")); return; }
    outEl.replaceChildren(...shown.map((r, i) => runCard(r, i, animate)));
  }

  function runCard(r, i, animate) {
    const head = (state, title, extra) => h("div.run-head", null, h("span.run-icon." + state, { "aria-hidden": "true" }, ICON[state] || "•"),
      h("div", null, h("strong", null, title), h("span.muted", null, extra)));
    const ev = `${r.event.label}${shown.length > 1 ? ` · run ${i + 1} of ${shown.length}` : ""}`;
    if (r.status === "invalid" || r.status === "missing") {
      return h("div.run.card", null, head("failure", r.errors[0] || r.reason, ev),
        h("pre.run-errors", null, r.errors.slice(1).join("\n") || r.reason),
        r.detail ? h("p.note", null, "Why: ", r.detail) : null,
        r.errorLine ? h("button.linkish", { type: "button", onclick: () => jumpTo(r.errorLine) }, `Go to line ${r.errorLine}`) : null);
    }
    if (r.status === "not-triggered") return h("div.run.card", null, head("skipped", "No run started", ev), h("p", null, r.reason), mergeBox(r));
    const state = r.status === "waiting" ? "waiting" : r.conclusion;
    const card = h("div.run.card", null,
      head(state, r.title || r.name, `${ev} · #${r.number} · ${r.status === "waiting" ? "waiting" : E.fmtSecs(r.duration)}`),
      facts(r), graph(r, animate), mergeBox(r));
    if (r.waiting.length) {
      card.append(h("div.run-wait", null, h("p", null, h("strong", null, "Review required. "), `This run is waiting for approval to deploy to ${r.waiting.join(", ")}.`),
        h("button.pill.primary.small-pill", { type: "button", onclick: () => send(session.lastEvent.id, session.lastEvent.inputs, true) }, "Approve and deploy")));
    }
    if (r.annotations.length) card.append(h("ul.run-notes", null, r.annotations.map(([lvl, t]) => h("li." + lvl, null, h("strong", null, lvl === "error" ? "Error" : lvl === "warning" ? "Warning" : "Notice"), " ", t))));
    const job = r.jobs.find((j) => j.key === selected) || r.jobs.find((j) => j.conclusion === "failure") || r.jobs[0];
    if (job && i === shown.length - 1) card.append(stepsOf(r, job));
    return card;
  }

  // Required checks, as the pull request's merge box shows them.
  function mergeBox(r) {
    if (!r.required) return null;
    const label = { expected: "Expected — Waiting for status to be reported", pending: "In progress", success: "Successful", failure: "Failing" };
    const blocked = r.required.some((c) => c.state !== "success");
    return h("div.merge-box" + (blocked ? ".blocked" : ""), null,
      h("p", null, h("strong", null, blocked ? "Merging is blocked." : "All required checks have passed."), " Required checks:"),
      h("ul", null, r.required.map((c) => h("li." + c.state, null, h("code", null, c.name), " ", label[c.state]))));
  }

  // Token, secrets, caches and artifacts, as the run used them.
  function facts(r) {
    const items = [];
    const perms = new Map();
    for (const j of r.jobs) if (j.perms) perms.set(Object.entries(j.perms).filter(([k]) => k !== "metadata").map(([k, v]) => `${k}: ${v}`).join(", ") || "metadata: read", 1);
    if (perms.size) items.push(["GITHUB_TOKEN", [...perms.keys()].join(" | ")]);
    const secretJobs = r.jobs.filter((j) => j.secretsAvailable);
    if (secretJobs.length) items.push(["Secrets", r.event.fork && r.event.name === "pull_request" ? "none (fork pull request)" : r.event.dependabot ? "Dependabot secrets only" : [...new Set(secretJobs.flatMap((j) => j.secretsAvailable))].join(", ") || "none set"]);
    if (r.cache.length) items.push(["Cache", r.cache.map((c) => (c.hit ? "hit" : c.restored ? "partial" : "miss")).join(", ")]);
    const envs = [...new Set(r.jobs.map((j) => j.environment).filter(Boolean))];
    if (envs.length) items.push(["Environment", envs.join(", ")]);
    if (r.effects.deployed.length) items.push(["Deployed", r.effects.deployed.map((d) => `${d.env} ← ${d.version}`).join(", ")]);
    return h("dl.run-facts", null, items.map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v))));
  }

  // Jobs in columns by their needs; each lights up in the order it ran.
  function graph(r, animate) {
    const depth = {};
    const d = (j) => depth[j.key] ?? (depth[j.key] = Math.max(0, ...(j.needs || []).flatMap((n) => r.jobs.filter((x) => x.key === n || x.key.startsWith(n + "#") || x.key.startsWith(n + "/")).map((x) => d(x) + 1))));
    r.jobs.forEach((j) => d(j));
    const cols = [];
    for (const j of r.jobs) (cols[depth[j.key]] = cols[depth[j.key]] || []).push(j);
    const order = [...r.jobs].sort((a, b) => a.start - b.start);
    const g = h("div.run-graph", { role: "list" }, cols.filter(Boolean).map((list) => h("div.run-col", null, list.slice(0, 24).map((j) => {
      const st = stateOf(j);
      const b = h("button.job." + st, { type: "button", role: "listitem", "aria-pressed": String(j.key === selected), "data-key": j.key, onclick: () => { selected = j.key; renderRuns(false); } },
        h("span.job-icon", { "aria-hidden": "true" }, ICON[st] || "•"), h("span.job-name", null, j.name),
        h("span.job-time", null, st === "skipped" ? "skipped" : st === "queued" ? "queued" : st === "waiting" ? "waiting" : st === "pending" ? "pending" : E.fmtSecs((j.end - j.start) || 0)));
      return b;
    }), list.length > 24 ? h("p.muted.small", null, `and ${list.length - 24} more`) : null)));
    if (animate && !still()) {
      const btns = order.map((j) => g.querySelector(`[data-key="${CSS.escape(j.key)}"]`)).filter(Boolean);
      btns.forEach((b) => b.classList.add("is-queued"));
      let k = 0;
      const tick = () => {
        if (k > 0) btns[k - 1].classList.remove("is-running");
        if (k >= btns.length) return;
        btns[k].classList.remove("is-queued");
        btns[k].classList.add("is-running");
        k++;
        animTimer = setTimeout(tick, btns.length > 12 ? 60 : 380);
      };
      tick();
    }
    return g;
  }

  function stepsOf(r, j) {
    return h("div.run-steps", null,
      h("h4", null, j.name, j.runsOn ? h("span.muted", null, ` · ${j.runsOn}`) : null),
      j.note ? h("p.run-job-note", null, j.note) : null,
      j.steps.map((st) => h("details.step." + (st.conclusion || "pending"), { open: st.conclusion === "failure" || (st.lines.some((l) => l[1] === "err")) },
        h("summary", null, h("span.step-icon", { "aria-hidden": "true" }, ICON[st.conclusion] || "•"), h("span", null, st.name),
          st.continued ? h("span.step-tag", null, "failed, continue-on-error") : null, h("span.step-time", null, st.conclusion === "skipped" ? "" : E.fmtSecs(st.secs))),
        h("pre.step-log", null, st.lines.map(([t, c]) => h("span" + (c ? "." + c : ""), null, t + "\n"))))));
  }

  function jumpTo(line) {
    const ta = $("pg-code");
    session.open = Object.keys(sc.files)[0];
    renderFiles();
    const lines = ta.value.split("\n");
    const start = lines.slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
    ta.focus();
    ta.setSelectionRange(start, start + (lines[line - 1] || "").length);
    ta.scrollTop = Math.max(0, (line - 4) * 20);
  }

  // --- gh console -----------------------------------------------------------------
  function consoleRun(line) {
    const out = $("pg-console-out");
    const print = (t, c) => out.append(h("div.pg-line" + (c ? "." + c : ""), null, t));
    print("$ " + line, "cmd");
    if (!line.trim()) return;
    if (line.trim() === "clear") { out.replaceChildren(); return; }
    const res = gh(session, line);
    for (const [t, c] of res.lines) print(t, c);
    if (res.run) send(res.run.id, res.run.inputs);
    out.scrollTop = out.scrollHeight;
  }

  // --- loading ---------------------------------------------------------------------
  function load(id, reveal) {
    sc = SCENARIOS.find((s) => s.id === id) || SCENARIOS[0];
    const saved = savedFiles(sc.id);
    const files = { ...sc.files };
    if (saved && typeof saved === "object") for (const k of Object.keys(files)) if (typeof saved[k] === "string") files[k] = saved[k];
    session = { files, world: worldOf(sc), store: E.newStore(), runs: [], open: Object.keys(sc.files)[0], hint: 0, solved: false };
    shown = [];
    selected = null;
    $("pg-console-out").replaceChildren(h("div.pg-line.dim", null, "gh console for this scenario. Try: gh run list, gh run view --log-failed, gh secret list"));
    renderPicker();
    renderBrief();
    renderFiles();
    renderEvents();
    renderRuns(false);
    if (reveal) $("playground").scrollIntoView({ block: "start", behavior: still() ? "auto" : "smooth" });
  }
  function reset() {
    store.set("files:" + sc.id, null);
    load(sc.id);
  }

  $("pg-code").addEventListener("input", onEdit);
  $("pg-code").addEventListener("scroll", () => { $("pg-gutter").scrollTop = $("pg-code").scrollTop; });
  // Tab indents with two spaces, as YAML wants; Escape leaves the editor.
  $("pg-code").addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const ta = e.currentTarget, s = ta.selectionStart;
      ta.setRangeText("  ", s, ta.selectionEnd, "end");
      onEdit();
    } else if (e.key === "Escape") e.currentTarget.blur();
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("pg-run-btn").click(); }
  });
  $("pg-event").addEventListener("change", renderInputs);
  $("pg-run-btn").addEventListener("click", () => send($("pg-event").value, inputsNow(), false));
  $("pg-console").addEventListener("submit", (e) => { e.preventDefault(); const v = $("pg-console-input").value; $("pg-console-input").value = ""; consoleRun(v); });

  window.AQPlayground = {
    scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, group: s.group })),
    load: (id) => load(id, true),
    // From the cheat sheet: open the scenario; gh commands run in its console, snippets are shown to paste.
    prefill: (text, where) => {
      if (where && where !== "any" && where !== sc.id) load(where);
      $("playground").scrollIntoView({ block: "start" });
      // gh run commands need a run to look at: send the scenario's first event.
      if (/^gh run /.test(text) && !session.runs.length) send(sc.events[0], {}, false);
      if (/^gh /.test(text)) { consoleRun(text); $("pg-console-input").focus({ preventScroll: true }); }
      else {
        $("pg-snippet").hidden = false;
        $("pg-snippet").replaceChildren(h("p", null, h("strong", null, "From the cheat sheet. "), "Paste this where it belongs in the file, then run the workflow."),
          h("pre", null, h("code", null, text)), h("button.chip", { type: "button", onclick: () => { $("pg-snippet").hidden = true; } }, "Close"));
      }
    }
  };
  load(SCENARIOS[0].id);
})();
