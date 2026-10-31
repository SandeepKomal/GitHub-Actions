// Checks the site's data: levels, quiz questions, the Troubleshoot reference,
// the cheat sheet's Try and Lab rows, the X-ray's copies of this repository's
// workflows, the generated problems page, and the page's meta description.
// Run with: node tests/check_site_data.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
const { build, OUT } = require(path.join(root, "tools/build-problems.js"));
const problems = build(); // loads data.js and the simulator into a fresh window
require(path.join(root, "site/quiz-bank.js"));
const Q = window.TRACK;
const bank = window.TRACK_QUIZ_BANK;
const { SCENARIOS, gh, LAB, worldOf } = window.AQScenarios;
const E = window.AQEngine;
const { parse } = window.AQYaml;
const ids = new Set(SCENARIOS.map((s) => s.id));

// Levels and quiz.
assert.deepStrictEqual(Q.levels.map((l) => l.id), Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")));
let total = 0;
for (const lv of Q.levels) {
  for (const f of lv.files) assert.ok(fs.existsSync(path.join(root, f)), `level ${lv.id}: ${f} exists`);
  assert.ok(lv.learn.length && lv.lab.length, `level ${lv.id}: learn and lab`);
  const items = bank[lv.id] || [];
  assert.ok(items.length >= 6, `level ${lv.id} needs at least 6 questions, has ${items.length}`);
  const seen = new Set();
  for (const item of items) {
    total++;
    const where = `level ${lv.id}: "${item.q}"`;
    assert.ok(!seen.has(item.q), `${where}: duplicate`);
    seen.add(item.q);
    assert.strictEqual(item.options.length, 4, `${where}: 4 options`);
    assert.strictEqual(new Set(item.options).size, 4, `${where}: options differ`);
    assert.ok(Number.isInteger(item.answer) && item.answer >= 0 && item.answer < 4, `${where}: answer`);
    assert.ok(item.why.length > 20, `${where}: explanation`);
    for (const t of [item.q, item.why, ...item.options]) assert.strictEqual((t.match(/`/g) || []).length % 2, 0, `${where}: backticks`);
  }
}
for (const s of SCENARIOS) assert.ok(Q.levels.some((l) => l.id === s.level), `${s.id}: level ${s.level} exists`);

// Troubleshoot: reference answers with stable ids, one group each, real links.
const docIds = Q.doctor.map((d) => d.id);
assert.strictEqual(new Set(docIds).size, docIds.length, "doctor ids are unique");
assert.deepStrictEqual(Q.doctorGroups.flatMap(([, list]) => list).sort(), [...docIds].sort(), "every answer is in exactly one group");
for (const d of Q.doctor) {
  for (const k of ["title", "error", "symptom", "cause", "fix", "prevent"]) assert.ok(d[k] && d[k].length > 5, `${d.id}: ${k}`);
  assert.ok(/^[a-z0-9-]+$/.test(d.id) && d.confirm.length, `${d.id}: id and confirm`);
  assert.ok(Q.levels.some((l) => l.id === d.level), `${d.id}: level`);
  for (const id of d.scenarios) assert.ok(ids.has(id), `${d.id}: unknown scenario ${id}`);
}
for (const c of Q.architecture.components) for (const id of c.practise) assert.ok(ids.has(id), `architecture ${c.id}: unknown scenario ${id}`);

// Every scenario's error appears in some answer's error text or its scenarios list.
const practised = new Set(Q.doctor.flatMap((d) => d.scenarios));
assert.ok(SCENARIOS.filter((s) => practised.has(s.id)).length >= SCENARIOS.length * 0.8, "most scenarios are linked from Troubleshoot");

// Cheat sheet: Try rows run in their scenario; Lab rows cannot run in the playground.
const session = (id) => {
  const s = SCENARIOS.find((x) => x.id === id);
  const ses = { files: { ...s.files }, world: worldOf(s), store: E.newStore(), runs: [] };
  ses.runs.push(...E.trigger(ses.world, ses.files, s.events[0], { store: ses.store }));
  return ses;
};
for (const [cmd, what, group, where] of Q.cheats) {
  assert.ok(what && group, `cheat "${cmd}": what and group`);
  if (where) {
    assert.ok(ids.has(where), `cheat "${cmd}": unknown scenario ${where}`);
    if (cmd.startsWith("gh ")) {
      const out = gh(session(where), cmd).lines;
      assert.ok(!out.some(([t, c]) => c === "err" || t === LAB), `cheat "${cmd}" should run in ${where}: ${JSON.stringify(out)}`);
    } else {
      assert.ok(!parse(cmd).error, `cheat snippet parses as YAML: ${cmd}`);
    }
  } else {
    const out = gh(session(SCENARIOS[0].id), cmd).lines;
    assert.ok(out.some(([t, c]) => t === LAB || c === "err" || /This console runs gh commands/.test(t)), `cheat "${cmd}" runs in the playground now; give it a Try`);
  }
}

// The X-ray's copies of this repository's workflows match the files.
for (const f of Q.xrayFiles) assert.strictEqual(f.text, fs.readFileSync(path.join(root, f.path), "utf8"), `${f.path}: site/data.js copy is out of date`);
assert.deepStrictEqual(Q.xrayFiles.map((f) => f.path).sort(), [...fs.readdirSync(path.join(root, ".github/workflows")).filter((f) => !/^(pages)\.yml$/.test(f)).map((f) => ".github/workflows/" + f),
  ...fs.readdirSync(path.join(root, "examples")).map((f) => "examples/" + f)].sort(), "every workflow and example is in the X-ray");

// The static problems page is current, and the page's counts are true.
assert.strictEqual(fs.readFileSync(OUT, "utf8"), problems, "site/problems.html is out of date: run node tools/build-problems.js");
const html = fs.readFileSync(path.join(root, "site/index.html"), "utf8");
assert.match(html, new RegExp(`with ${SCENARIOS.length} real incidents`), "meta description counts the scenarios");
assert.match(html, /GitHub® and GitHub Actions are trademarks of GitHub, Inc\. This project is independent and not affiliated with GitHub\./);
for (const page of [html, problems]) {
  assert.ok(!/\sstyle="|\son[a-z]+="|<script>/.test(page), "no inline styles, handlers or scripts");
  assert.match(page, /default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'/);
}
assert.match(fs.readFileSync(path.join(root, "site/sitemap.xml"), "utf8"), new RegExp(Q.site.replace(/[./]/g, "\\$&") + "problems\\.html"));
assert.match(fs.readFileSync(path.join(root, "site/robots.txt"), "utf8"), /Sitemap: https:\/\/sandeepkomal\.github\.io\/GitHub-Actions\/sitemap\.xml/);
// Nothing in the site reaches another origin or writes HTML from strings.
for (const f of fs.readdirSync(path.join(root, "site")).filter((x) => /\.js$/.test(x))) {
  const src = fs.readFileSync(path.join(root, "site", f), "utf8");
  assert.ok(!/\.innerHTML|\.outerHTML|insertAdjacentHTML\(|document\.write\(|\bfetch\(|XMLHttpRequest|\beval\(/.test(src), `${f}: no innerHTML, network or eval`);
}

console.log(`site data ok: ${Q.levels.length} levels, ${total} quiz questions, ${Q.doctor.length} answers, ${Q.cheats.length} cheat sheet rows, problems page current`);
