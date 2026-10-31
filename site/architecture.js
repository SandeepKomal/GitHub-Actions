// The Architecture tab: how a run flows from an event to a deploy. Every part
// can be pointed at, tapped or reached with Tab to read what it does and how it fails.
"use strict";

(function () {
  const { h } = window.AQUI;
  const rich = window.AQUI.rich;
  const parts = Object.fromEntries(window.TRACK.architecture.components.map((c) => [c.id, c]));
  const NS = "http://www.w3.org/2000/svg";
  const s = (tag, attrs, ...kids) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v); el.append(...kids); return el; };
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Grid positions [column, row] for each layout.
  const LAYOUTS = {
    wide: { cols: 5, cell: [208, 116], box: [176, 60], font: [13, 11],
      at: { event: [0, 0], workflow: [1, 0], job: [2, 0], runner: [3, 0], checks: [4, 0], contexts: [1, 1], step: [2, 1], action: [3, 1], reusable: [4, 1],
        secrets: [0, 2], environment: [1, 2], token: [2, 2], storage: [3, 2], oidc: [2, 3], cloud: [3, 3] },
      bands: [["Triggers and the run", 0, 1], ["Settings and identity", 2, 3]] },
    narrow: { cols: 2, cell: [176, 92], box: [156, 54], font: [12, 10],
      at: { event: [0, 0], workflow: [1, 0], job: [0, 1], runner: [1, 1], step: [0, 2], action: [1, 2], contexts: [0, 3], reusable: [1, 3],
        secrets: [0, 4], environment: [1, 4], token: [0, 5], storage: [1, 5], oidc: [0, 6], cloud: [1, 6], checks: [0, 7] },
      bands: [["Triggers and the run", 0, 3], ["Settings and identity", 4, 7]] }
  };
  const EDGES = [["event", "workflow"], ["workflow", "job"], ["job", "runner"], ["runner", "checks"], ["job", "step"], ["step", "action"], ["reusable", "job"], ["contexts", "step"],
    ["secrets", "contexts"], ["environment", "job"], ["token", "step"], ["step", "storage"], ["token", "oidc"], ["oidc", "cloud"]];
  const TOUR = [
    [["event", "workflow"], "A push arrives. GitHub reads every workflow in .github/workflows/ at that commit and matches `on:` and its filters."],
    [["workflow", "job"], "The workflow is valid, so its jobs are queued. Those with no `needs:` start together."],
    [["environment", "job"], "A job that names an environment waits for its rules: reviewers, allowed branches."],
    [["job", "runner"], "Each job gets a fresh runner whose labels match `runs-on`. Set up job downloads its actions."],
    [["job", "step"], "Steps run in order. Each run step is a new bash -e shell."],
    [["secrets", "contexts"], "Expressions are filled in first: contexts, inputs, and the secrets this event may see."],
    [["token", "step"], "The job's GITHUB_TOKEN carries exactly the permissions the workflow granted."],
    [["step", "storage"], "Caches restore by key; artifacts carry files to later jobs."],
    [["token", "oidc"], "With id-token: write, the job asks GitHub's OIDC provider for a signed token."],
    [["oidc", "cloud"], "The cloud checks the token's sub against the role's trust policy and returns short-lived credentials."],
    [["runner", "checks"], "Each job reports a check on the commit. Required checks gate the merge."]
  ];

  const root = document.getElementById("arch");
  const figure = h("div.arch-figure");
  const tip = h("div.arch-tip", { "aria-hidden": "true" });
  const detail = h("div.arch-detail", { hidden: true, "aria-live": "polite" });
  const play = h("button.pill.small-pill", { type: "button", onclick: () => (touring ? stopTour() : tour()) }, "Follow a push");
  const caption = h("p.arch-caption", { "aria-live": "polite" }, "Point at any part to see what it does and what it talks to.");
  let svg = null, dot = null, pinned = null, touring = 0, L = null;

  const rect = (id) => { const [c, r] = L.at[id]; return [c * L.cell[0] + 16, r * L.cell[1] + 40 + (r >= L.bands[1][1] ? 24 : 0), L.box[0], L.box[1]]; };
  // The sides an edge leaves and enters by: the ones facing each other.
  const sides = (a, b) => {
    const [ax, ay] = rect(a), [bx, by] = rect(b);
    if (Math.abs(ay - by) < 2) return ax < bx ? ["right", "left"] : ["left", "right"];
    return ay < by ? ["bottom", "top"] : ["top", "bottom"];
  };
  // Edges sharing a side of a box get their own anchor points along it.
  function anchors() {
    const groups = {};
    EDGES.forEach(([a, b], i) => { const [sa, sb] = sides(a, b); (groups[a + ":" + sa] = groups[a + ":" + sa] || []).push([i, 0]); (groups[b + ":" + sb] = groups[b + ":" + sb] || []).push([i, 1]); });
    const off = EDGES.map(() => [0, 0]);
    for (const list of Object.values(groups)) list.forEach(([i, end], k) => { off[i][end] = (k - (list.length - 1) / 2) * 18; });
    return off;
  }
  // An edge leaves the side that faces the other box.
  function route(a, b, [oa, ob]) {
    const [ax, ay, aw, ah] = rect(a), [bx, by, bw, bh] = rect(b);
    if (Math.abs(ay - by) < 2) return ax < bx ? [[ax + aw, ay + ah / 2 + oa], [bx, by + bh / 2 + ob]] : [[ax, ay + ah / 2 + oa], [bx + bw, by + bh / 2 + ob]];
    const down = ay < by;
    const x1 = ax + aw / 2 + oa, y1 = down ? ay + ah : ay, x2 = bx + bw / 2 + ob, y2 = down ? by : by + bh;
    const mid = (y1 + y2) / 2;
    return x1 === x2 ? [[x1, y1], [x2, y2]] : [[x1, y1], [x1, mid], [x2, mid], [x2, y2]];
  }

  function draw() {
    L = LAYOUTS[matchMedia("(max-width: 720px)").matches ? "narrow" : "wide"];
    const rows = Math.max(...Object.values(L.at).map(([, r]) => r)) + 1;
    const [w, ht] = [L.cols * L.cell[0] + 16, rows * L.cell[1] + 64];
    const marker = (id) => s("marker", { id, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, s("path", { d: "M0 0 8 4 0 8z" }));
    svg = s("svg", { viewBox: `0 0 ${w} ${ht}`, class: "arch-svg", role: "group", "aria-label": "How a workflow run works" }, s("defs", null, marker("arch-arrow"), marker("arch-arrow-on")));
    for (const [label, r0, r1] of L.bands) {
      const y = r0 * L.cell[1] + 12 + (r0 >= L.bands[1][1] ? 24 : 0);
      svg.append(s("rect", { x: 4, y, width: w - 8, height: (r1 - r0 + 1) * L.cell[1] + 8, rx: 16, class: "arch-panel" }), s("text", { x: 18, y: y + 20, class: "arch-panel-label" }, label));
    }
    const off = anchors();
    EDGES.forEach(([a, b], i) => svg.append(s("polyline", { points: route(a, b, off[i]).join(" "), class: "arch-edge", "data-from": a, "data-to": b, "marker-end": "url(#arch-arrow)" })));
    for (const id of Object.keys(L.at)) {
      const c = parts[id];
      const [x, y, bw, bh] = rect(id);
      const g = s("g", { class: "arch-box", "data-id": id, tabindex: "0", role: "button", "aria-label": `${c.name}: ${c.short}` },
        s("rect", { x, y, width: bw, height: bh, rx: 10 }),
        s("text", { x: x + bw / 2, y: y + bh / 2 - 2, class: "arch-name", "font-size": L.font[0] }, c.name),
        s("text", { x: x + bw / 2, y: y + bh / 2 + L.font[1] + 3, class: "arch-short", "font-size": L.font[1] }, c.short));
      g.addEventListener("mouseenter", () => touring || select(id));
      g.addEventListener("focus", () => touring || select(id));
      g.addEventListener("click", () => { stopTour(); pinned = id; select(id); open(id); });
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); g.dispatchEvent(new Event("click")); } });
      svg.append(g);
    }
    dot = s("circle", { r: 6, class: "arch-dot" });
    svg.append(dot);
    svg.addEventListener("mouseleave", () => touring || select(pinned));
    figure.replaceChildren(svg, tip, h("div.arch-tour", null, play, caption));
    stopTour();
    select(pinned);
  }

  function light(ids, edges) {
    svg.classList.toggle("has-focus", ids.length > 0);
    const near = new Set(ids);
    svg.querySelectorAll(".arch-edge").forEach((e) => {
      const ends = [e.dataset.from, e.dataset.to];
      const on = edges ? edges.includes(e) : ends.some((x) => ids.includes(x));
      if (on) ends.forEach((x) => near.add(x));
      e.classList.toggle("is-on", on);
      e.setAttribute("marker-end", `url(#arch-arrow${on ? "-on" : ""})`);
    });
    svg.querySelectorAll(".arch-box").forEach((g) => {
      g.classList.toggle("is-on", ids.includes(g.dataset.id));
      g.classList.toggle("is-near", !ids.includes(g.dataset.id) && near.has(g.dataset.id));
    });
  }
  function select(id) { light(id ? [id] : []); place(id); }

  const body = (c) => [h("p.arch-where", null, c.where), h("h3", null, c.name), h("p", null, ...rich(c.role)),
    h("h4", null, "What it does"), h("ul", null, c.does.map((d) => h("li", null, ...rich(d)))),
    h("h4", null, "When it breaks"), h("p", null, ...rich(c.breaks)),
    h("h4", null, "Look at it"), h("pre", null, h("code", null, c.look.join("\n"))),
    h("div.doctor-practise", null, h("span.muted.small", null, "Practise:"),
      c.practise.map((id) => { const sc = window.AQPlayground.scenarios.find((x) => x.id === id); return sc ? h("a.chip", { href: "#play/" + id }, sc.title) : null; }))];
  function open(id) {
    detail.replaceChildren(h("div.card", null, ...body(parts[id])));
    detail.hidden = false;
    detail.scrollIntoView({ block: "nearest", behavior: still() ? "auto" : "smooth" });
  }
  function place(id) {
    const showTip = id && figure.offsetParent && !matchMedia("(max-width: 720px), (hover: none)").matches;
    tip.classList.toggle("is-shown", Boolean(showTip));
    if (!showTip) return;
    const c = parts[id];
    tip.replaceChildren(h("p.arch-where", null, c.where), h("h3", null, c.name), h("p", null, ...rich(c.role)), h("p", null, h("strong", null, "When it breaks: "), ...rich(c.breaks)), h("p.muted.small", null, "Click for commands and practice"));
    const box = svg.querySelector(`[data-id="${id}"] rect`).getBoundingClientRect();
    const frame = figure.getBoundingClientRect();
    const right = box.right - frame.left + 12;
    tip.style.left = `${right + tip.offsetWidth <= frame.width ? right : Math.max(0, box.left - frame.left - tip.offsetWidth - 12)}px`;
    tip.style.top = `${Math.min(Math.max(0, box.top - frame.top - 8), Math.max(0, frame.height - tip.offsetHeight - 60))}px`;
  }

  // Move the dot along an edge.
  function travel(edge, run) {
    const pts = edge.getAttribute("points").split(" ").map((p) => p.split(",").map(Number));
    const segs = pts.slice(1).map((p, i) => [pts[i], p, Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1])]);
    const total = segs.reduce((n, sg) => n + sg[2], 0);
    const at = (d) => { for (const [a, b, len] of segs) { if (d <= len) return [a[0] + (b[0] - a[0]) * d / len, a[1] + (b[1] - a[1]) * d / len]; d -= len; } return pts[pts.length - 1]; };
    dot.classList.add("is-on");
    return new Promise((resolve) => {
      if (still()) { [dot.cx.baseVal.value, dot.cy.baseVal.value] = pts[pts.length - 1]; return resolve(); }
      const ms = Math.max(500, total * 2.4), start = performance.now();
      const frame = (now) => {
        if (run !== touring) return resolve();
        const t = Math.min(1, (now - start) / ms), e = t < .5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
        [dot.cx.baseVal.value, dot.cy.baseVal.value] = at(total * e);
        if (t < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
  }
  async function tour() {
    const run = ++touring;
    pinned = null;
    place(null);
    play.textContent = "Stop";
    for (const [n, [[a, b], text]] of TOUR.entries()) {
      caption.replaceChildren(h("span.arch-step", null, `${n + 1} of ${TOUR.length}`), ...rich(text));
      const edge = svg.querySelector(`.arch-edge[data-from="${a}"][data-to="${b}"]`);
      light([a, b], [edge]);
      await travel(edge, run);
      if (run !== touring) return;
      await new Promise((r) => setTimeout(r, still() ? 3000 : 1400));
      if (run !== touring) return;
    }
    stopTour("Played. Point at any part to read more, or play it again.");
  }
  function stopTour(text) {
    touring = 0;
    if (dot) dot.classList.remove("is-on");
    play.textContent = "Follow a push";
    if (text) caption.textContent = text;
    if (svg) light([]);
  }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (pinned || touring)) { pinned = null; stopTour(); select(null); } });
  matchMedia("(max-width: 720px)").addEventListener("change", draw);
  window.addEventListener("hashchange", () => { if (location.hash !== "#arch") stopTour(); });
  window.addEventListener("DOMContentLoaded", () => { draw(); root.replaceChildren(figure, detail); });
})();
