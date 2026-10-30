// A small YAML reader for workflow files: block mappings and sequences, flow
// [lists] and {maps}, quoted and plain scalars, block scalars (| and >) and
// comments. It keeps the line and column of every key and item, so errors can
// point where GitHub would, and records each line's key path for the X-ray.
// Anchors, aliases and tags are not supported. No DOM, so tests run it in Node.
"use strict";

(function (root) {
  const MAX_LINES = 600;

  class YamlError extends Error {
    constructor(line, detail) { super(`You have an error in your yaml syntax on line ${line}`); this.line = line; this.detail = detail; }
  }

  // Where each key or item was written: positions.get(container)[key] = {line, col}.
  const positions = new WeakMap();
  const place = (obj, key, line, col) => {
    if (!positions.has(obj)) positions.set(obj, Object.create(null));
    positions.get(obj)[key] = { line, col };
  };
  const at = (obj, key) => (obj && typeof obj === "object" && positions.has(obj) && positions.get(obj)[key]) || null;

  // Remove a trailing comment: a # at the start or after a space, outside quotes.
  function stripComment(s) {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === q && !(q === '"' && s[i - 1] === "\\")) q = null; }
      else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:-]/.test(s[i - 1]))) q = c;
      else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
    }
    return s.trimEnd();
  }

  function scalar(text, line) {
    const s = text.trim();
    if (s === "" || s === "~" || /^(null|Null|NULL)$/.test(s)) return null;
    if (/^(true|True|TRUE)$/.test(s)) return true;
    if (/^(false|False|FALSE)$/.test(s)) return false;
    if (/^[-+]?\d+$/.test(s)) return Number(s);
    if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
    if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
    if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) || /^[-+]?\d+[eE][-+]?\d+$/.test(s)) return Number(s);
    if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
    if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
    if (/^[&*!@`%]/.test(s)) throw new YamlError(line, /^[&*!]/.test(s) ? "Anchors, aliases and tags are not supported here." : `A plain value cannot start with ${s[0]}.`);
    if (/^["']/.test(s)) return quoted(s, line);
    if (/:(\s|$)/.test(s)) throw new YamlError(line, "A second colon on this line: quote the value, or move the key to its own line.");
    return s;
  }

  function quoted(s, line) {
    const q = s[0];
    let out = "";
    let i = 1;
    for (; i < s.length; i++) {
      const c = s[i];
      if (q === "'" && c === "'") { if (s[i + 1] === "'") { out += "'"; i++; continue; } break; }
      if (q === '"' && c === "\\") {
        const n = s[++i];
        const map = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", "0": "\0", " ": " " };
        if (n in map) out += map[n];
        else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 4; }
        else throw new YamlError(line, "Unknown escape in a double-quoted string.");
        continue;
      }
      if (q === '"' && c === '"') break;
      out += c;
    }
    if (i >= s.length) throw new YamlError(line, "The quoted value is not closed on this line.");
    if (s.slice(i + 1).trim()) throw new YamlError(line, "Text after the closing quote.");
    return out;
  }

  // [a, "b", {c: d}] on one line.
  function flow(s, line) {
    let i = 0;
    const ws = () => { while (/\s/.test(s[i] || "")) i++; };
    const value = (stop) => {
      ws();
      if (s[i] === "[") {
        i++; const arr = [];
        ws();
        if (s[i] === "]") { i++; return arr; }
        for (;;) {
          arr.push(value(",]"));
          ws();
          if (s[i] === ",") { i++; ws(); if (s[i] === "]") { i++; return arr; } continue; }
          if (s[i] === "]") { i++; return arr; }
          throw new YamlError(line, "Expected , or ] in the list.");
        }
      }
      if (s[i] === "{") {
        i++; const obj = Object.create(null);
        ws();
        if (s[i] === "}") { i++; return obj; }
        for (;;) {
          ws();
          const k = token(":,}");
          if (s[i] !== ":") throw new YamlError(line, "Expected key: value in the map.");
          i++;
          obj[k == null ? "" : String(k)] = value(",}");
          ws();
          if (s[i] === ",") { i++; continue; }
          if (s[i] === "}") { i++; return obj; }
          throw new YamlError(line, "Expected , or } in the map.");
        }
      }
      return token(stop);
    };
    const token = (stop) => {
      ws();
      if (s[i] === '"' || s[i] === "'") {
        const q = s[i];
        let j = i + 1;
        while (j < s.length && !(s[j] === q && !(q === '"' && s[j - 1] === "\\"))) j++;
        if (j >= s.length) throw new YamlError(line, "The quoted value is not closed.");
        const v = quoted(s.slice(i, j + 1), line);
        i = j + 1;
        return v;
      }
      let j = i;
      while (j < s.length && !stop.includes(s[j]) && !"[]{}".includes(s[j])) j++;
      const raw = s.slice(i, j).trim();
      i = j;
      return scalar(raw, line);
    };
    const v = value("");
    ws();
    if (i < s.length) throw new YamlError(line, "Text after the end of the [list] or {map}.");
    return v;
  }

  const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\-?:,[\]{}&*!|>%@`][^#]*?|-[^\s#][^#]*?|\?[^\s][^#]*?)\s*:(?:\s+(.*)|$)/;

  function parse(text) {
    const raw = String(text).replace(/\r\n?/g, "\n").split("\n");
    if (raw.length > MAX_LINES) return { error: { line: MAX_LINES, message: `Keep it to ${MAX_LINES} lines.`, detail: "" }, lines: [] };
    const meta = raw.map((t) => ({ text: t, path: null, kind: "blank" }));
    const L = raw.map((t, n) => {
      const lead = /^[ \t]*/.exec(t)[0];
      const content = stripComment(t.slice(lead.length));
      if (/^\s*#/.test(t)) meta[n].kind = "comment";
      return { n: n + 1, indent: lead.length, tab: lead.includes("\t"), content };
    });
    let i = 0;
    // An opening "---" is allowed; a second document is not.
    const start = L.find((l) => l.content);
    if (start && start.indent === 0 && /^---(\s|$)/.test(start.content)) { start.content = ""; meta[start.n - 1].kind = "comment"; }

    const skip = () => { while (i < L.length && !L[i].content) i++; };
    const peek = () => { skip(); return L[i]; };
    const check = (l) => {
      if (l.tab) throw new YamlError(l.n, "Tabs cannot indent YAML. Use spaces.");
      if (l.indent === 0 && /^(---|\.\.\.)(\s|$)/.test(l.content)) throw new YamlError(l.n, "Only one YAML document per workflow file.");
    };
    const note = (l, path, kind) => { meta[l.n - 1].path = path; meta[l.n - 1].kind = kind; };

    function node(min, path) {
      const l = peek();
      if (!l || l.indent < min) return null;
      check(l);
      if (/^-(\s|$)/.test(l.content)) return seq(l.indent, path, false);
      if (KEY.test(l.content)) return map(l.indent, path);
      // A value on its own line, for example a plain scalar after "key:".
      i++;
      note(l, path, "value");
      return inline(l.content, l, l.indent - 1, path);
    }

    function map(ind, path) {
      const obj = Object.create(null);
      for (;;) {
        const l = peek();
        if (!l || l.indent < ind) break;
        check(l);
        if (l.indent > ind) throw new YamlError(l.n, "This line is indented more than the keys above it.");
        if (/^-(\s|$)/.test(l.content)) throw new YamlError(l.n, "A list item where a key was expected. Check the indentation.");
        const m = KEY.exec(l.content);
        if (!m) throw new YamlError(l.n, "Expected key: value. Check the indentation and the colon.");
        const key = /^["']/.test(m[1]) ? quoted(m[1], l.n) : m[1].trim();
        if (key in obj) throw new YamlError(l.n, `The key '${key}' appears twice in the same map.`);
        const p = [...path, key];
        note(l, p, "key");
        place(obj, key, l.n, l.indent + 1);
        i++;
        obj[key] = after(m[2] || "", l, ind, p);
      }
      return obj;
    }

    // The value after "key:" or "- ": inline, a block scalar, or a nested node.
    function after(rest, l, ind, path) {
      rest = rest.trim();
      if (!rest) {
        const next = peek();
        if (!next) return null;
        if (next.indent > ind) return node(ind + 1, path);
        if (next.indent === ind && /^-(\s|$)/.test(next.content) && meta[l.n - 1].kind === "key") return seq(ind, path, true);
        return null;
      }
      return inline(rest, l, ind, path);
    }

    function inline(rest, l, ind, path) {
      if (/^[|>][-+]?\d?$/.test(rest)) return block(rest, ind, path);
      if (/^[[{]/.test(rest)) return flow(rest, l.n);
      if (/^["']/.test(rest)) return quoted(rest, l.n);
      // A plain scalar may continue on more-indented lines; they fold into one.
      let text = rest;
      while (i < L.length && L[i].content && L[i].indent > ind && !/^-\s/.test(L[i].content)) {
        if (KEY.test(L[i].content)) throw new YamlError(L[i].n, "A key cannot follow a value on the line above. Check the indentation.");
        check(L[i]);
        note(L[i], path, "cont");
        text += " " + L[i].content;
        i++;
      }
      return scalar(text, l.n);
    }

    function block(style, ind, path) {
      const lines = [];
      let inner = -1;
      while (i < L.length) {
        const t = raw[i];
        const indent = /^ */.exec(t)[0].length;
        if (t.trim() && indent <= ind) break;
        if (t.trim() && inner < 0) inner = indent;
        if (t.trim() && indent < inner) throw new YamlError(i + 1, "This line of the block is indented less than its first line.");
        note(L[i], path, "cont");
        lines.push(t.trim() ? t.slice(inner) : "");
        i++;
      }
      while (lines.length && !lines[lines.length - 1] && style[1] !== "+") lines.pop();
      let out = style[0] === "|" ? lines.join("\n")
        : lines.reduce((acc, ln, k) => acc + (k === 0 ? ln : !ln ? "\n" : lines[k - 1] && !/^\s/.test(ln) ? " " + ln : "\n" + ln), "");
      if (style[1] !== "-" && out) out += "\n";
      return out;
    }

    // loose: the list sits at its parent key's indent, so a key there ends it.
    function seq(ind, path, loose) {
      const arr = [];
      for (;;) {
        const l = peek();
        if (!l || l.indent < ind) break;
        check(l);
        if (l.indent > ind) throw new YamlError(l.n, "This line is indented more than the list items above it.");
        if (!/^-(\s|$)/.test(l.content)) {
          if (loose) break;
          throw new YamlError(l.n, "Expected a list item starting with '- '.");
        }
        const p = [...path, arr.length];
        const rest = l.content.slice(1).replace(/^\s+/, "");
        const offset = l.content.length - rest.length;
        place(arr, arr.length, l.n, l.indent + 1);
        note(l, p, "item");
        if (rest && (KEY.test(rest) || /^-(\s|$)/.test(rest))) {
          // "- key: value" starts a map whose keys line up with "key".
          L[l.n - 1] = { ...l, indent: l.indent + offset, content: rest };
          arr.push(KEY.test(rest) ? map(l.indent + offset, p) : seq(l.indent + offset, p, false));
          if (meta[l.n - 1].kind === "key") meta[l.n - 1].kind = "itemkey";
        } else {
          i++;
          arr.push(after(rest, l, ind, p));
        }
      }
      return arr;
    }

    try {
      const value = node(0, []);
      const left = peek();
      if (left) throw new YamlError(left.n, "This line does not belong to anything above it. Check the indentation.");
      return { value, lines: meta };
    } catch (e) {
      if (!(e instanceof YamlError)) throw e;
      return { error: { line: e.line, message: e.message, detail: e.detail }, lines: meta };
    }
  }

  root.AQYaml = { parse, at, stripComment };
})(typeof window !== "undefined" ? window : globalThis);
