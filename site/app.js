// Actions Quest site. No dependencies, no network requests.
"use strict";

(function () {
  const Q = window.QUEST;
  const $ = (sel) => document.querySelector(sel);
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollToEl = (el) => el.scrollIntoView({ block: "start", behavior: still() ? "auto" : "smooth" });

  // h("tag.class", {attr: value}, ...children): build DOM without innerHTML.
  function h(spec, attrs, ...kids) {
    const [tag, ...classes] = spec.split(".");
    const el = document.createElement(tag);
    if (classes.length) el.className = classes.join(" ");
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  // Text with `code` spans.
  const rich = (text) => String(text).split(/(`[^`]+`)/).map((p) => (p.startsWith("`") && p.length > 1 ? h("code", null, p.slice(1, -1)) : p));

  const PREFIX = "dq-actions:";
  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(PREFIX + key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { if (value == null) localStorage.removeItem(PREFIX + key); else localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* storage blocked */ } }
  };
  function forgetEverything() {
    if (!confirm("Clear your progress, quiz scores and playground edits from this browser?")) return;
    try { for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k); } catch { /* storage blocked */ }
    location.reload();
  }
  // Copy a deep link to this page, such as #play/cache-key or #fix/cache-miss.
  async function copyLink(hash, button) {
    const url = location.href.split("#")[0] + "#" + hash;
    try { await navigator.clipboard.writeText(url); button.textContent = "Link copied"; } catch { prompt("Copy this link:", url); }
    setTimeout(() => { button.textContent = "Copy link"; }, 1400);
  }
  const practise = (id) => { location.hash = "play/" + id; };
  window.AQUI = { h, rich, store, copyLink, practise };

  document.querySelectorAll("[data-repo]").forEach((a) => { a.href = Q.repo + a.dataset.repo; });

  // --- tabs and deep links ---------------------------------------------------------
  const tabs = ["path", "quiz", "xray", "doctor", "cheats", "arch"];
  let current = null;
  function show() {
    const [want, sub] = location.hash.slice(1).split("/");
    const tab = want === "play" ? "path" : want === "fix" ? "doctor" : tabs.includes(want) ? want : "path";
    if (tab !== current) {
      const page = $("#tab-" + tab);
      page.classList.remove("tab-in");
      void page.offsetWidth; // restart the fade
      page.classList.add("tab-in");
    }
    current = tab;
    for (const t of tabs) $("#tab-" + t).hidden = t !== tab;
    document.querySelectorAll(".top nav a").forEach((a) => (a.dataset.tab === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    if (want === "play" && sub && window.AQPlayground) window.AQPlayground.load(sub);
    if (want === "fix" && sub) { const i = Q.doctor.findIndex((d) => d.id === sub); if (i >= 0) renderDoctor(i, true); }
    return { want, sub };
  }
  window.addEventListener("hashchange", () => {
    const before = current;
    const { want } = show();
    if (current !== before && want !== "play" && want !== "fix") window.scrollTo(0, 0);
  });

  // --- hero: the pipeline that runs job by job, with a cache toggle ---------------------
  function signature() {
    const jobs = [["lint", 18], ["test", 64], ["build", 142], ["deploy", 31]];
    const cards = jobs.map(([n]) => h("div.job-card", null, h("b", null, n), h("span.t", null, "queued"), h("div.jbar", null, h("i"))));
    const time = h("b", null, "—");
    const saved = h("span.dim", null, "");
    let cache = false;
    let running = false;
    const toggle = (label, onClick) => {
      const b = h("button.toggle", { type: "button", "aria-pressed": "false" }, label);
      b.addEventListener("click", () => onClick(b));
      return b;
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, still() ? 0 : ms));
    const cacheBtn = toggle("Cache dependencies", (b) => { cache = !cache; b.setAttribute("aria-pressed", String(cache)); });
    const runBtn = toggle("Run workflow", async (b) => {
      if (running) return;
      running = true;
      b.disabled = true;
      cards.forEach((c) => { c.className = "job-card"; c.querySelector("i").style.width = "0"; c.querySelector(".t").textContent = "queued"; });
      let total = 0;
      for (const [i, [, secs]] of jobs.entries()) {
        const s = cache && (i === 1 || i === 2) ? Math.round(secs / 4) : secs;
        const c = cards[i];
        c.className = "job-card run";
        c.querySelector(".t").textContent = cache && (i === 1 || i === 2) ? "running · cache hit" : "running";
        const bar = c.querySelector("i");
        bar.style.transition = still() ? "none" : `width ${s * 8}ms linear`;
        bar.style.width = "100%";
        await wait(s * 8);
        c.className = "job-card done";
        c.querySelector(".t").textContent = `${s}s`;
        total += s;
      }
      time.textContent = `${Math.floor(total / 60)}m ${total % 60}s`;
      saved.textContent = cache ? "  with the npm cache restored" : "  every dependency downloaded";
      b.disabled = false;
      running = false;
    });
    const stage = $("#stage");
    stage.append(h("div.stage-bar", null, h("div", null, h("strong", null, "ci.yml on push"), h("div", null, "Workflow runs, job by job.")), h("div.stage-controls", null, cacheBtn, runBtn)),
      h("div.pipe", { role: "list", "aria-label": "Jobs" }, cards.map((c) => (c.setAttribute("role", "listitem"), c))),
      h("div.meter", null, h("span.dim", null, "Total"), h("span", null, time, saved)));
  }

  function heroStats() {
    const quiz = Object.values(window.QUEST_QUIZ_BANK).flat().length;
    const n = window.AQScenarios.SCENARIOS.length;
    $("#stats").replaceChildren(...[[n, "incidents to fix in the playground"], [Q.levels.length, "levels, basics to production"], [Q.doctor.length, "error messages explained"], [quiz, "quiz questions with reasons"]]
      .map(([v, l]) => h("div", null, h("b", null, String(v)), h("span", null, l))));
    $("#pg-count").textContent = `${n} real incidents, from a missing runs-on to OIDC trust policies. No install, no account.`;
  }

  // --- path ---------------------------------------------------------------------------
  function renderPath() {
    const done = new Set(store.get("done", []));
    const scores = store.get("quiz", {});
    const box = $("#levels");
    box.replaceChildren();
    let stage = "", list;
    for (const lv of Q.levels) {
      if (lv.stage !== stage) {
        stage = lv.stage;
        list = h("ol.levels");
        box.append(h("h3.stage-title", { id: "stage-" + stage.toLowerCase() }, stage), list);
      }
      const isDone = done.has(lv.id);
      const scn = window.AQScenarios.SCENARIOS.filter((s) => s.level === lv.id);
      list.append(h("li.level" + (isDone ? ".done" : ""), null,
        h("input", { type: "checkbox", checked: isDone, "aria-label": `Mark level ${lv.id} complete`, onchange: (e) => {
          if (e.target.checked) done.add(lv.id); else done.delete(lv.id);
          store.set("done", [...done]);
          renderPath();
        } }),
        h("span.num", null, lv.id),
        h("details.what", null,
          h("summary", null, h("strong", null, lv.title), h("span.topic", null, lv.topic)),
          h("div.level-body", null,
            h("h4", null, "What you learn"), h("ul", null, lv.learn.map((t) => h("li", null, ...rich(t)))),
            h("h4", null, "Lab, in your fork"), h("ol", null, lv.lab.map((t) => h("li", null, ...rich(t)))),
            h("p.note", null, "Files: ", ...lv.files.flatMap((f, i) => [i ? ", " : "", h("a", { href: `${Q.repo}/blob/main/${f}` }, f)])),
            scn.length ? h("div.doctor-practise", null, h("span.muted.small", null, "Practise:"), scn.map((s) => h("a.chip", { href: "#play/" + s.id }, s.title))) : null)),
        h("span.actions", null, h("a.small", { href: "#quiz", onclick: () => { $("#quiz-level").value = lv.id; renderQuiz(); } }, lv.id in scores ? `Quiz ${scores[lv.id]}%` : "Quiz"))));
    }
    const n = done.size;
    $("#bar-fill").style.width = (n / Q.levels.length * 100) + "%";
    $("#bar").setAttribute("aria-valuenow", String(n));
    $("#bar-text").textContent = `${n} of ${Q.levels.length} levels complete`;
  }

  // --- quiz ---------------------------------------------------------------------------
  const EXAM_SIZE = 20;
  const questionsFor = (id) => (window.QUEST_QUIZ_BANK[id] || []).map((x) => ({ ...x, level: id }));
  function shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function renderQuiz() {
    const mode = $("#quiz-level").value;
    const exam = mode === "exam";
    const items = exam ? shuffle(Q.levels.flatMap((l) => questionsFor(l.id))).slice(0, EXAM_SIZE) : questionsFor(mode);
    const out = $("#quiz-list");
    out.replaceChildren();
    let answered = 0, correct = 0;
    const score = h("div.score", { "aria-live": "polite" });
    const fill = h("span.fill");
    const update = () => {
      score.replaceChildren(h("span", null, h("strong", null, String(correct)), ` correct of ${answered} answered · ${items.length} questions`),
        h("span.meter", { role: "progressbar", "aria-label": "Answered", "aria-valuemin": "0", "aria-valuemax": String(items.length), "aria-valuenow": String(answered) }, fill));
      fill.style.width = (answered / items.length * 100) + "%";
      if (answered === items.length) {
        const pct = Math.round(correct / items.length * 100);
        if (!exam) { const all = store.get("quiz", {}); all[mode] = Math.max(all[mode] || 0, pct); store.set("quiz", all); renderPath(); }
        score.append(h("p.result", null, h("strong", null, `${pct}%. `), pct === 100 ? "Perfect score." : pct >= 75 ? "Strong. Review the explanations you missed." : "Read the explanations, practise the level, and try again.",
          " ", h("button.linkish", { type: "button", onclick: renderQuiz }, exam ? "New exam" : "Try again")));
      }
    };
    items.forEach((item, qi) => {
      const fb = h("p.feedback", { "aria-live": "polite" });
      const opts = h("div.options", { role: "group", "aria-label": `Question ${qi + 1}` });
      shuffle(item.options.map((text, index) => ({ text, index }))).forEach((opt) => opts.append(h("button.opt", {
        type: "button", "data-right": opt.index === item.answer ? "1" : null,
        onclick: (e) => {
          const right = opt.index === item.answer;
          opts.querySelectorAll("button").forEach((b) => { b.disabled = true; if (b.dataset.right) b.classList.add("right"); });
          if (!right) e.currentTarget.classList.add("wrong");
          fb.replaceChildren(h("strong", null, right ? "Correct. " : "Not quite. "), ...rich(item.why));
          fb.className = "feedback " + (right ? "ok" : "bad");
          answered++;
          if (right) correct++;
          update();
        }
      }, ...rich(opt.text))));
      const from = exam ? Q.levels.find((l) => l.id === item.level) : null;
      out.append(h("div.card.question", null, from ? h("p.tag", null, `Level ${from.id} · ${from.topic}`) : null, h("h3", null, `${qi + 1}. `, ...rich(item.q)), opts, fb));
    });
    out.prepend(score);
    update();
  }

  // --- Workflow X-ray -------------------------------------------------------------------
  const narrow = () => matchMedia("(max-width: 860px)").matches;
  function placeNote(li) {
    const note = $("#xray-note");
    if (li && narrow()) {
      let slot = $("#xray-lines .note-slot");
      if (!slot) slot = h("li.note-slot");
      li.after(slot);
      slot.append(note);
    } else if (note.parentElement !== $("#xray-view")) {
      $("#xray-view").append(note);
      const slot = $("#xray-lines .note-slot");
      if (slot) slot.remove();
    }
  }
  function renderLines(rows) {
    const lines = $("#xray-lines");
    placeNote(null);
    lines.replaceChildren();
    rows.forEach(({ line, note, level, warns }, i) => {
      if (!note) { lines.append(h("li", null, h("span.line.blank", null, line || " "))); return; }
      const flag = warns.length ? ".warn" : level === "unknown" ? ".unknown" : "";
      lines.append(h("li", null, h("button.line" + flag, {
        type: "button",
        onclick: (e) => {
          lines.querySelectorAll(".line").forEach((b) => b.classList.remove("on"));
          e.currentTarget.classList.add("on");
          placeNote(e.currentTarget.parentElement);
          $("#xray-note").replaceChildren(h("pre", null, h("code", null, line.trim())), h("p", null, ...rich(note)),
            ...warns.map((w) => h("p.xray-warn", null, ...rich(w))), h("p.muted", null, `Line ${i + 1} of ${rows.length}`));
        }
      }, line)));
    });
    $("#xray-note").replaceChildren(h("p.muted", null, "Select any line to see what it does."));
  }
  function showXray(res) {
    $("#xray-edit").hidden = true;
    $("#xray-result").hidden = false;
    $("#xray-view").hidden = false;
    renderLines(res.lines);
    const warned = res.lines.filter((r) => r.warns.length).length;
    const unknown = res.lines.filter((r) => r.level === "unknown").length;
    $("#xray-summary").textContent = [`${res.lines.filter((r) => r.note).length} lines explained`, warned ? `${warned} worth a second look` : null, unknown ? `${unknown} not in the dictionary` : null].filter(Boolean).join(" · ");
    $("#xray-review").replaceChildren(...(res.review.length ? [h("details.xray-missing", { open: true }, h("summary", null, `${res.review.length} missing setting${res.review.length === 1 ? "" : "s"} worth a look`),
      h("ul.xray-review", null, res.review.map((n) => h("li", null, ...rich(n)))))] : []));
    const first = $("#xray-lines .line.warn") || $("#xray-lines button.line");
    if (first && !narrow()) first.click();
  }
  function explainText(text) {
    const err = $("#xray-error");
    if (!text.trim()) { err.textContent = "Paste a workflow first, or choose Load an example."; err.hidden = false; return; }
    const res = window.AQXray.explain(text);
    if (res.error) { err.textContent = res.error; err.hidden = false; return; }
    err.hidden = true;
    showXray(res);
  }
  function editXray() {
    $("#xray-edit").hidden = false;
    $("#xray-result").hidden = true;
    $("#xray-view").hidden = true;
    selectXrayTab(-1);
  }
  function selectXrayTab(i) {
    document.querySelectorAll("#xray-pick button").forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.index) === i)));
  }

  // --- Troubleshoot: search over symptoms and pasted error text ------------------------
  const words = (s) => s.toLowerCase().replace(/[^a-z0-9.@/_-]+/g, " ").split(" ").filter((w) => w.length > 2);
  function buildDoctorList() {
    const index = new Map(Q.doctor.map((d, i) => [d.id, i]));
    $("#doctor-list").replaceChildren(...Q.doctorGroups.map(([name, ids]) => h("div.doctor-group", null,
      h("div.doctor-group-name", null, name, h("span.doctor-group-count", null, String(ids.length))),
      h("div.doctor-group-items", null, ids.map((id) => h("button.chip", { type: "button", "data-index": index.get(id), "aria-pressed": "false", onclick: () => { location.hash = "fix/" + id; } }, Q.doctor[index.get(id)].title))))));
  }
  // A pasted error line matches on its words; symptoms and tool names too. Best matches first.
  function scoreDoctor(d, q) {
    const hay = [d.title, d.error, d.symptom, d.cause, ...d.confirm, d.fix].join(" ").toLowerCase();
    if (q.length > 12 && hay.includes(q.toLowerCase().trim())) return 100;
    const w = words(q);
    if (!w.length) return 1;
    return w.filter((x) => hay.includes(x)).length / w.length;
  }
  function renderDoctorList() {
    const q = $("#doctor-q").value;
    let shown = 0;
    const best = [];
    for (const group of document.querySelectorAll(".doctor-group")) {
      let n = 0;
      for (const b of group.querySelectorAll("button")) {
        const s = scoreDoctor(Q.doctor[b.dataset.index], q);
        b.hidden = q.trim() ? s < 0.6 : false;
        if (!b.hidden) { n++; best.push([s, Number(b.dataset.index)]); }
      }
      group.hidden = !n;
      group.querySelector(".doctor-group-count").textContent = String(n);
      shown += n;
    }
    $("#doctor-none").hidden = shown > 0;
    best.sort((a, b) => b[0] - a[0]);
    if (q.trim().length > 12 && best.length && best[0][0] >= 0.6) renderDoctor(best[0][1], true);
  }
  function renderDoctor(index, quiet) {
    const d = Q.doctor[index];
    document.querySelectorAll("#doctor-list button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.index) === index)));
    const titles = Object.fromEntries((window.AQPlayground ? window.AQPlayground.scenarios : []).map((x) => [x.id, x.title]));
    const lv = Q.levels.find((l) => l.id === d.level);
    $("#doctor-out").replaceChildren(h("article.card.answer", { id: "fix-" + d.id },
      h("div.answer-head", null, h("h3", null, d.title), h("button.chip", { type: "button", onclick: (e) => copyLink("fix/" + d.id, e.currentTarget) }, "Copy link")),
      h("h4", null, "Error"), h("pre.err", null, h("code", null, d.error)),
      h("h4", null, "Symptom"), h("p", null, ...rich(d.symptom)),
      h("h4", null, "Cause"), h("p", null, ...rich(d.cause)),
      h("h4", null, "Confirm"), h("pre", null, h("code", null, d.confirm.join("\n"))),
      h("h4", null, "Fix"), h("p", null, ...rich(d.fix)),
      h("h4", null, "Prevent"), h("p", null, ...rich(d.prevent)),
      d.scenarios.length ? h("div.doctor-practise", null, h("span.muted.small", null, "Practise it:"), d.scenarios.filter((id) => titles[id]).map((id) => h("a.chip", { href: "#play/" + id }, titles[id]))) : null,
      lv ? h("p.note", null, "Learn it: ", h("a", { href: "#path", onclick: () => setTimeout(() => scrollToEl($("#levels")), 0) }, `Level ${lv.id} · ${lv.title}`)) : null));
    if (!quiet || location.hash.startsWith("#fix/")) setTimeout(() => scrollToEl($("#doctor-out")), 0);
  }

  // --- cheat sheet ---------------------------------------------------------------------
  function copyButton(text) {
    return h("button.copy", { type: "button", "aria-label": "Copy", onclick: async (e) => {
      const b = e.currentTarget;
      try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; } catch { b.textContent = "Select it"; }
      setTimeout(() => { b.textContent = "Copy"; }, 1200);
    } }, "Copy");
  }
  function renderCheats() {
    const q = $("#cheat-q").value.trim().toLowerCase();
    const groups = new Map();
    for (const [cmd, what, group, where] of Q.cheats) {
      if (q && !(cmd + " " + what + " " + group).toLowerCase().includes(q)) continue;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push([cmd, what, where]);
    }
    const out = $("#cheat-out");
    out.replaceChildren();
    if (!groups.size) { out.append(h("p.muted", null, "No match. Try cache, secret, matrix or concurrency.")); return; }
    const titles = Object.fromEntries((window.AQPlayground ? window.AQPlayground.scenarios : []).map((x) => [x.id, x.title]));
    for (const [group, rows] of groups) {
      out.append(h("h3.group", null, group), h("ul.cheats", null, rows.map(([cmd, what, where]) => h("li", null,
        h("div", null, cmd.includes("\n") ? h("pre.snippet", null, h("code", null, cmd)) : h("code", null, cmd), h("span.muted", null, what)),
        h("div.cheat-actions", null,
          where ? h("button.copy", { type: "button", title: `Try it in the playground scenario "${titles[where] || where}"`, onclick: () => { location.hash = "path"; window.AQPlayground.prefill(cmd, where); } }, "Try")
            : h("a.copy.lab", { href: Q.repo + "#quick-start", title: "Needs a real repository: try it in your fork" }, "Lab"),
          copyButton(cmd))))));
    }
  }

  // --- page guides ----------------------------------------------------------------------
  function renderGuides() {
    const state = store.get("guides", {});
    document.querySelectorAll(".guide-slot").forEach((slot) => {
      const key = slot.dataset.guide, g = Q.guides[key];
      if (!g) return;
      const box = h("details.guide", { open: state[key] ?? false },
        h("summary", null, "How to use this"),
        h("div.guide-body", null, h("p", null, ...rich(g.what)),
          h("div.guide-cols", null,
            h("div", null, h("h3", null, "How to use it"), h("ol", null, g.steps.map((t) => h("li", null, ...rich(t))))),
            h("div", null, h("h3", null, "What it is for"), h("ul", null, g.uses.map((t) => h("li", null, ...rich(t)))),
              h("h3", null, "Tips"), h("ul", null, g.tips.map((t) => h("li", null, ...rich(t))))))));
      let open = box.open;
      box.addEventListener("toggle", () => { if (box.open === open) return; open = box.open; store.set("guides", { ...store.get("guides", {}), [key]: open }); });
      slot.replaceChildren(box);
    });
  }

  // --- command palette (Ctrl+K, Cmd+K or /) ----------------------------------------------
  const palette = $("#palette"), pInput = $("#palette-input"), pList = $("#palette-list");
  let pItems = [], pActive = 0;
  const go = (hash, then) => { location.hash = hash; show(); if (then) setTimeout(then, 0); };
  function actions() {
    return [
      { label: "Playground", kind: "Section", run: () => go("path", () => scrollToEl($("#playground"))) },
      { label: "Your path", kind: "Section", run: () => go("path", () => scrollToEl($("#path-title"))) },
      { label: "Exam: random questions from every level", kind: "Quiz", run: () => go("quiz", () => { $("#quiz-level").value = "exam"; renderQuiz(); }) },
      { label: "Workflow X-ray", kind: "Section", run: () => go("xray") },
      { label: "Troubleshoot: search an error", kind: "Section", run: () => go("doctor", () => $("#doctor-q").focus()) },
      { label: "Cheat sheet", kind: "Section", run: () => go("cheats", () => $("#cheat-q").focus()) },
      { label: "Actions architecture", kind: "Section", run: () => go("arch") },
      ...Q.levels.map((lv) => ({ label: `Quiz: ${lv.id} · ${lv.topic}`, kind: "Quiz", run: () => go("quiz", () => { $("#quiz-level").value = lv.id; renderQuiz(); }) })),
      ...Q.doctor.map((d) => ({ label: `Troubleshoot: ${d.title}`, hint: d.error, kind: "Reference", run: () => go("fix/" + d.id) })),
      ...(window.AQPlayground ? window.AQPlayground.scenarios : []).map((s) => ({ label: `Playground: ${s.title}`, hint: s.group, kind: "Practice", run: () => go("play/" + s.id) }))
    ];
  }
  function renderPalette() {
    const w = pInput.value.toLowerCase().split(/\s+/).filter(Boolean);
    pItems = actions().filter((a) => w.every((x) => `${a.label} ${a.hint || ""} ${a.kind}`.toLowerCase().includes(x))).slice(0, 8);
    pActive = Math.min(pActive, Math.max(0, pItems.length - 1));
    pList.replaceChildren(...pItems.map((a, i) => h("li", { role: "option", id: "pal-" + i, "aria-selected": String(i === pActive), onclick: () => choose(i) },
      h("span.pal-label", null, a.label), h("span.pal-kind", null, a.kind))));
    if (!pItems.length) pList.append(h("li.pal-empty", null, "Nothing matches. Try cache, OIDC or matrix."));
    pInput.setAttribute("aria-activedescendant", pItems.length ? "pal-" + pActive : "");
  }
  function openPalette() { if (palette.open) return; pInput.value = ""; pActive = 0; renderPalette(); palette.showModal(); pInput.focus(); }
  function choose(i) { const a = pItems[i]; if (!a) return; palette.close(); a.run(); }
  pInput.addEventListener("input", () => { pActive = 0; renderPalette(); });
  pInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = pItems.length;
      if (n) pActive = (pActive + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderPalette();
    } else if (e.key === "Enter") { e.preventDefault(); choose(pActive); }
  });
  palette.addEventListener("click", (e) => { if (e.target === palette) palette.close(); });
  $("#palette-open").addEventListener("click", openPalette);
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $("#palette-key").textContent = "⌘K";
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPalette(); }
    else if (e.key === "/" && !typing) { e.preventDefault(); openPalette(); }
  });

  // --- init -------------------------------------------------------------------------------
  $("#quiz-level").append(h("option", { value: "exam" }, `Exam: ${EXAM_SIZE} random questions from every level`));
  for (const lv of Q.levels) $("#quiz-level").append(h("option", { value: lv.id }, `${lv.id} · ${lv.topic} (${questionsFor(lv.id).length} questions)`));
  $("#quiz-level").value = "01";
  $("#quiz-level").addEventListener("change", renderQuiz);
  $("#quiz-again").addEventListener("click", renderQuiz);
  $("#xray-pick").append(h("button", { type: "button", role: "tab", "data-index": "-1", "aria-selected": "true", onclick: editXray }, "Paste your workflow"),
    ...Q.xrayFiles.map((f, i) => h("button", { type: "button", role: "tab", "data-index": String(i), "aria-selected": "false",
      onclick: () => { selectXrayTab(i); showXray(window.AQXray.explain(f.text)); $("#xray-summary").prepend(f.path + " · "); } }, f.path.split("/").pop())));
  $("#xray-go").addEventListener("click", () => explainText($("#xray-input").value));
  $("#xray-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) explainText($("#xray-input").value); });
  $("#xray-example").addEventListener("click", () => { $("#xray-input").value = Q.xrayExample; explainText(Q.xrayExample); });
  $("#xray-clear").addEventListener("click", () => { $("#xray-input").value = ""; $("#xray-error").hidden = true; $("#xray-input").focus(); });
  $("#xray-edit-btn").addEventListener("click", () => { editXray(); $("#xray-input").focus(); });
  buildDoctorList();
  $("#doctor-q").addEventListener("input", renderDoctorList);
  $("#cheat-q").addEventListener("input", renderCheats);
  $("#forget").addEventListener("click", forgetEverything);
  signature();
  renderGuides();
  renderPath();
  renderQuiz();
  window.addEventListener("DOMContentLoaded", () => {
    heroStats();
    renderPath();
    renderCheats();
    show();
  });
})();
