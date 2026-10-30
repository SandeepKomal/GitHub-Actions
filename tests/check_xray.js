// Checks the Workflow X-ray: every risky pattern is flagged, essentials that are
// missing are listed, and this repository's own workflows are fully explained.
// Run with: node tests/check_xray.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

for (const f of ["yaml", "xray"]) require(path.resolve(__dirname, `../site/${f}.js`));
const { explain } = globalThis.AQXray;
const root = path.resolve(__dirname, "..");
global.window = {};
require(path.join(root, "site/data.js"));

const r = explain(window.QUEST.xrayExample);
const at = (text) => r.lines.find((l) => l.line.includes(text));
const warn = (text) => (at(text) || { warns: [] }).warns.join(" ");
assert.match(warn("pull_request_target:"), /runs with secrets on fork pull requests/);
assert.match(warn("ref: ${{ github.event.pull_request.head.sha }}"), /pwn request/);
assert.match(warn('run: echo "Building ${{ github.event.pull_request.title }}"'), /Script injection/);
assert.match(warn("permissions: write-all"), /write-all/);
assert.match(warn("uses: acme/changed-files@v45"), /Third-party action not pinned to a full commit SHA/);
assert.match(warn("uses: actions/checkout@v4"), /full commit SHA/);
assert.match(warn('run: echo "$DEPLOY_TOKEN"'), /Prints a secret/);
assert.match(warn("runs-on: self-hosted"), /Self-hosted runner/);
assert.match(warn("curl -sSL"), /curl \| bash/);
assert.match(warn("continue-on-error: true"), /Hides failures/);
assert.match(warn("key: npm-${{ github.sha }}"), /without hashFiles/);
assert.ok(r.review.some((n) => /Job build has no timeout-minutes/.test(n)), "review: timeout");
assert.ok(r.review.some((n) => /Job deploy deploys without a concurrency group/.test(n)), "review: concurrency on deploy");
const noPerms = explain("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: echo hi\n");
assert.ok(noPerms.review.some((n) => /No permissions block/.test(n)));
const contents = explain("on: push\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n");
assert.match(contents.lines.find((l) => /contents: write/.test(l.line)).warns.join(), /no step pushes/);
const pushes = explain("on: push\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: git push\n");
assert.ok(!pushes.lines.find((l) => /contents: write/.test(l.line)).warns.length, "contents: write is fine when a step pushes");
const pinned = explain("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0\n");
assert.ok(!pinned.lines.some((l) => l.warns.length), "a pinned action is not flagged");
const safe = explain("on: pull_request\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo \"$TITLE\"\n        env:\n          TITLE: ${{ github.event.pull_request.title }}\n");
assert.ok(!safe.lines.some((l) => /Script injection/.test(l.warns.join())), "env: is the safe way");
assert.match(explain("a:\n\tb: 1").error, /You have an error in your yaml syntax on line 2/);
assert.match(explain("x\n".repeat(500)).error, /up to 400 lines/);
assert.match(explain("on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v6\n        with:\n          fetch-depth: 0\n").lines[7].note, /all history and tags/);

// This repository's workflows and examples: every line has a note, nearly all known.
let files = 0, total = 0, unknown = 0;
for (const f of window.QUEST.xrayFiles) {
  const res = explain(f.text);
  assert.ok(!res.error, `${f.path}: ${res.error}`);
  files++;
  for (const l of res.lines) {
    if (l.level === "blank") continue;
    assert.ok(l.note, `${f.path}: no note for "${l.line}"`);
    total++;
    if (l.level === "unknown") unknown++;
  }
}
const known = 1 - unknown / total;
assert.ok(known > 0.97, `only ${(known * 100).toFixed(1)}% of lines are explained`);
assert.match(explain(fs.readFileSync(path.join(root, "examples/deploy-java-with-maven-sonar-k8s.yml"), "utf8")).lines.find((l) => /checkout@v2/.test(l.line)).warns.join(), /full commit SHA/);
console.log(`xray ok: ${files} workflows, ${total} lines, ${(known * 100).toFixed(1)}% explained`);
