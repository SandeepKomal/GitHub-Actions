// Drives the playground without a browser: every scenario starts broken, the
// tempting wrong edits leave it broken, and the intended fix solves it. Also
// checks the engine's parser, expressions, filters and real error messages.
// Run with: node tests/check_playground.js
"use strict";
const path = require("path");
const assert = require("assert");

for (const f of ["yaml", "engine", "scenarios"]) require(path.resolve(__dirname, `../site/${f}.js`));
const { parse } = globalThis.AQYaml;
const E = globalThis.AQEngine;
const { SCENARIOS, GROUPS, verify, status, CI } = globalThis.AQScenarios;

const S = (id) => { const s = SCENARIOS.find((x) => x.id === id); assert.ok(s, `no scenario ${id}`); return s; };
// Apply [from, to, file] edits to a scenario's files; each "from" must exist.
function filesOf(id, edits) {
  const f = { ...S(id).files };
  for (const [from, to, file = CI] of edits) {
    assert.ok(f[file].includes(from), `${id}: edit target not found in ${file}: ${JSON.stringify(from)}`);
    f[file] = f[file].replace(from, to);
  }
  return f;
}
const solved = (id, edits = []) => S(id).won(verify(S(id), filesOf(id, edits)));
const runOf = (id, edits = [], i = 0) => verify(S(id), filesOf(id, edits)).run(i);
const log = (run) => run.jobs.flatMap((j) => j.steps.flatMap((s) => s.lines.map((l) => l[0]))).join("\n");
const tested = new Set();
// The fix solves it; every wrong move does not.
function scenario(id, fix, wrong = []) {
  tested.add(id);
  for (const w of wrong) assert.ok(!solved(id, w), `${id}: this wrong move must not solve it: ${JSON.stringify(w)}`);
  assert.ok(solved(id, fix), `${id}: the fix must solve it: ${JSON.stringify(status(S(id), verify(S(id), filesOf(id, fix))))}`);
}

// --- the YAML reader ----------------------------------------------------------------
{
  const r = parse("a: [3.10, '3.11', {x: 1}]\nb: |\n  one\n  two\nc: >-\n  x\n  y\nd:\n- 1\n- k: v\n  j: w\non: push\n");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.value)), { a: [3.1, "3.11", { x: 1 }], b: "one\ntwo\n", c: "x y", d: [1, { k: "v", j: "w" }], on: "push" });
  assert.match(parse("steps:\n  - uses: x\n  with:\n    a: 1\n").error.message, /^You have an error in your yaml syntax on line 3$/);
  assert.match(parse("a:\n\tb: 1\n").error.detail, /Tabs/);
  assert.match(parse("a: b: c\n").error.message, /line 1/);
  assert.strictEqual(parse("run: echo \"a # b\" # note\n").value.run, 'echo "a # b"');
  assert.strictEqual(parse("x: 'it''s'\n").value.x, "it's");
  assert.strictEqual(parse("---\nname: x\n").value.name, "x");
  assert.ok(parse("a: 1\n---\nb: 2\n").error, "a second document is an error");
}

// --- expressions -------------------------------------------------------------------
{
  const ctx = { data: { github: { event_name: "push", ref: "refs/heads/main", event: { commits: [{ message: "a" }, { message: "b" }] } }, matrix: { "python-version": "3.12" } }, status: "success" };
  const ev = (e) => E.evaluate(e, ctx);
  assert.strictEqual(ev("github.event_name == 'PUSH'"), true, "string comparison ignores case");
  assert.strictEqual(ev("startsWith(github.ref, 'refs/heads/')"), true);
  assert.deepStrictEqual([...ev("github.event.commits.*.message")], ["a", "b"]);
  assert.strictEqual(ev("matrix['python-version']"), "3.12");
  assert.strictEqual(ev("github.nope.deeper"), null);
  assert.strictEqual(ev("format('{0}-{1}', 'a', 1)"), "a-1");
  assert.strictEqual(ev("contains(fromJSON('[\"a\",\"b\"]'), 'B')"), true);
  assert.strictEqual(ev("1 == '1'"), true);
  assert.strictEqual(ev("github.event_name == 'push' && 'yes' || 'no'"), "yes");
  assert.throws(() => ev("nope()"), /Unrecognized function: 'nope'. Located at position 1 within expression: nope\(\)/);
  assert.throws(() => ev("a ==="), /Unexpected symbol/);
}

// --- filters and triggers ----------------------------------------------------------
assert.ok(E.filterMatch(["main", "release/**"], "release/2.0/hotfix"));
assert.ok(!E.filterMatch(["release/*"], "release/2.0/hotfix"));
assert.ok(!E.filterMatch(["**", "!docs/**"], "docs/setup.md"));
assert.ok(E.filterMatch(["v*"], "v1.4.0"));

// --- validation messages ----------------------------------------------------------
{
  const v = (text) => E.validate(parse(text).value, CI);
  assert.deepStrictEqual(v("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    needs: b\n    steps:\n      - run: echo\n"),
    ["The workflow is not valid. .github/workflows/ci.yml (Line: 5, Col: 5): Job 'a' depends on unknown job 'b'."]);
  assert.match(v("on: push\njobs:\n  a:\n    if: secrets.X != ''\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n")[0], /\(Line: 4, Col: 5\): Unrecognized named-value: 'secrets'. Located at position 1 within expression: secrets.X != ''/);
  assert.match(v("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    stepz: []\n")[0], /Unexpected value 'stepz'/);
  assert.match(v("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout\n")[0], /Expected format \{org\}\/\{repo\}\[\/path\]@ref. Actual 'actions\/checkout'/);
  assert.match(v("on: push\npermissions:\n  content: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n")[0], /Unexpected value 'content'/);
  assert.match(v("on: pushh\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n")[0], /Unexpected value 'pushh'/);
  assert.match(v("jobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n")[0], /No event triggers defined in `on`/);
  assert.match(v("on: push\njobs:\n  a:\n    needs: b\n    runs-on: x\n    steps: [{run: echo}]\n  b:\n    needs: a\n    runs-on: x\n    steps: [{run: echo}]\n")[0], /creates a cycle in the dependency graph/);
  assert.match(v("on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - name: nothing\n")[0], /There.s not enough info to determine what you meant\. Add one of these properties: run, uses/);
}

// --- the shell -----------------------------------------------------------------------
{
  const sx = { env: { A: "1" }, world: {}, secrets: {}, effects: { leaks: [] }, annotations: [], ws: { "f.txt": "a\nb\n" }, disk: { free: 10 }, stepOutputs: {}, newEnv: {} };
  const sh = (s) => E.runScript(s, sx, { errexit: true });
  assert.strictEqual(sh("false\necho after").code, 1, "bash -e stops at the first failure");
  assert.strictEqual(sh("false || true\necho after").lines.map((l) => l[0]).join(), "after");
  assert.strictEqual(sh("grep -c z f.txt").code, 1, "grep exits 1 when nothing matches");
  assert.strictEqual(sh('echo "x=$A" >> "$GITHUB_OUTPUT"').code, 0);
  assert.strictEqual(sh("nosuchtool --help").lines[0][0], "/home/runner/work/_temp/0f3c9b2e.sh: line 1: nosuchtool: command not found");
  assert.strictEqual(sh('if [ -n "$A" ]; then echo yes; else echo no; fi').lines.map((l) => l[0]).join(), "yes");
}

// --- every scenario: starts broken, three hints, real data ---------------------------
const ids = new Set();
for (const s of SCENARIOS) {
  assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
  ids.add(s.id);
  assert.ok(/^[a-z0-9-]+$/.test(s.id), `${s.id}: id is a lowercase slug`);
  assert.strictEqual(s.hints.length, 3, `${s.id}: three hints`);
  for (const k of ["title", "story", "goal", "lesson", "group", "level"]) assert.ok(s[k], `${s.id}: ${k}`);
  assert.ok(s.checks.length >= 1 && s.events.length >= 1 && s.verify.length >= 1, `${s.id}: checks, events and verify`);
  assert.ok(!s.won(verify(s, s.files)), `${s.id}: must start broken`);
  for (const e of s.events) assert.ok(E.EVENT_TYPES[e], `${s.id}: unknown event ${e}`);
}
assert.ok(SCENARIOS.length >= 55, "at least 55 scenarios");
assert.deepStrictEqual(GROUPS.map(([g]) => g), ["Basics", "Triggers and conditions", "Jobs and matrices", "Secrets and permissions", "Caching and artifacts", "Deployments and environments", "Reuse", "Security"]);

// --- Basics ----------------------------------------------------------------------------
assert.match(runOf("runs-on").errors[1], /^The workflow is not valid\. \.github\/workflows\/ci\.yml \(Line: 4, Col: 3\): Required property is missing: runs-on$/);
scenario("runs-on", [["  test:\n", "  test:\n    runs-on: ubuntu-latest\n"]], [
  [["  test:\n", "  test:\n    runs-on: ubuntu\n"]],
  [["  test:\n", "  test:\n    runs-on: self-hosted\n"]],
  [["  test:\n", "  test:\n  runs-on: ubuntu-latest\n"]]
]);
assert.match(runOf("runs-on", [["  test:\n", "  test:\n    runs-on: ubuntu\n"]]).jobs[0].steps[0].lines.map((l) => l[0]).join("\n"), /Waiting for a runner to pick up this job\.\.\./);

assert.deepStrictEqual(runOf("indent").errors, ["Invalid workflow file: .github/workflows/ci.yml#L9", "You have an error in your yaml syntax on line 9"]);
scenario("indent", [["      with:\n        node-version: 22\n", "        with:\n          node-version: 22\n"]], [
  [["      with:\n        node-version: 22\n", ""]],
  [["      with:\n        node-version: 22\n", "        with:\n        node-version: 22\n"]]
]);

assert.match(log(runOf("action-typo")), /Error: Unable to resolve action `actions\/chekout@v6`, repository not found/);
scenario("action-typo", [["actions/chekout@v6", "actions/checkout@v6"]], [
  [["actions/chekout@v6", "actions/checkout@v9"]],
  [["      - uses: actions/chekout@v6\n", ""]]
]);
assert.match(log(runOf("action-typo", [["actions/chekout@v6", "actions/checkout@v9"]])), /Unable to resolve action `actions\/checkout@v9`, unable to find version `v9`/);

assert.match(log(runOf("exit-code")), /^0\nError: Process completed with exit code 1\.$/m);
scenario("exit-code", [["grep -c TODO src/cart.js", "grep -c TODO src/cart.js || true"]], [
  [["        run: grep -c TODO src/cart.js\n", "        run: grep -c TODO src/cart.js\n        continue-on-error: true\n"]],
  [["      - name: TODO report\n        run: grep -c TODO src/cart.js\n", ""]],
  [["grep -c TODO src/cart.js", "grep -c TODO src/cart.js > /dev/null || true"]]
]);

scenario("hidden-failure", [["        continue-on-error: true\n", ""]], [
  [["      - name: Run tests\n        run: npm test\n        continue-on-error: true\n", ""]],
  [["    needs: test\n", "    needs: test\n    if: success()\n"]]
]);

assert.match(log(runOf("env-steps")), /^Tag: $/m);
scenario("env-steps", [['run: export IMAGE_TAG="1.4.${{ github.run_number }}"', 'run: echo "IMAGE_TAG=1.4.${{ github.run_number }}" >> "$GITHUB_ENV"']], [
  [['run: export IMAGE_TAG="1.4.${{ github.run_number }}"', 'run: echo "IMAGE_TAG=1.4.${{ github.run_number }}" >> "$GITHUB_OUTPUT"']],
  [['run: export IMAGE_TAG="1.4.${{ github.run_number }}"', 'run: IMAGE_TAG="1.4.${{ github.run_number }}"']]
]);

assert.match(log(runOf("fetch-depth")), /fatal: No names found, cannot describe anything\.\nError: Process completed with exit code 128\./);
scenario("fetch-depth", [[`      - uses: actions/checkout@v6\n`, `      - uses: actions/checkout@v6\n        with:\n          fetch-depth: 0\n`]], [
  [[`      - uses: actions/checkout@v6\n`, `      - uses: actions/checkout@v6\n        with:\n          fetch-depth: 1\n`]],
  [["version=$(git describe --tags)", "version=$(git describe --tags || true)"]]
]);

assert.ok(runOf("set-output").annotations.some((a) => /^The `set-output` command is deprecated/.test(a[1])));
scenario("set-output", [['echo "::set-output name=value::1.4.0"', 'echo "value=1.4.0" >> "$GITHUB_OUTPUT"']], [
  [['echo "::set-output name=value::1.4.0"', 'echo "value=1.4.0" >> "$GITHUB_ENV"']],
  [['echo "::set-output name=value::1.4.0"', 'echo "value=1.4.0"']]
]);

assert.match(runOf("node20").annotations.find((a) => /Node\.js 20/.test(a[1]))[1], /^Node\.js 20 actions are deprecated\. The following actions are running on Node\.js 20 and may not work as expected: actions\/checkout@v4, actions\/setup-node@v4, actions\/upload-artifact@v4\./);
scenario("node20", [["checkout@v4", "checkout@v6"], ["setup-node@v4", "setup-node@v6"], ["upload-artifact@v4", "upload-artifact@v6"]], [
  [["checkout@v4", "checkout@v6"], ["setup-node@v4", "setup-node@v6"]],
  [["checkout@v4", "checkout@v6"], ["setup-node@v4", "setup-node@v6"], ["upload-artifact@v4", "upload-artifact@v5"]],
  [["name: CI\n", "name: CI\nenv:\n  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true\n"]]
]);

// --- Triggers and conditions -----------------------------------------------------------
scenario("branch-filter", [["branches: [master]", "branches: [main]"]], [
  [["branches: [master]", "branches: ['**']"]],
  [["    branches: [master]\n", ""]],
  [["branches: [master]", "branches-ignore: [master]"]]
]);
scenario("path-filter", [['"src/**"', '"app/**"']], [
  [['      - "src/**"\n      - package-lock.json\n', '      - "**"\n']],
  [["    paths:\n", "    paths-ignore:\n"]]
]);
scenario("wrong-event", [["    needs: test\n", "    needs: test\n    if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n"]], [
  [["    needs: test\n", "    needs: test\n    if: github.ref == 'main'\n"]],
  [["    needs: test\n", "    needs: test\n    if: ${{ github.event_name }} == 'push'\n"]],
  [["    needs: test\n", "    needs: test\n    if: github.event_name == 'pull_request'\n"]]
]);
assert.match(runOf("schedule").jobs[0].note, /Skipped: `if: github\.ref == 'refs\/heads\/develop'` was false/);
scenario("schedule", [["    if: github.ref == 'refs/heads/develop'\n", ""]], [
  [['"30 2 * * *"', '"*/5 * * * *"']],
  [["github.ref == 'refs/heads/develop'", "github.event_name == 'workflow_dispatch'"]]
]);
assert.match(log(runOf("dispatch-input")), /deploy: no environment given/);
scenario("dispatch-input", [["inputs.enviroment", "inputs.environment"]], [
  [["inputs.enviroment", "github.event.inputs.enviroment"]],
  [["${{ inputs.enviroment }}", "staging"]],
  [["${{ inputs.enviroment }}", "production"]]
]);
scenario("tag-release", [["    branches: [main]\n", "    branches: [main]\n    tags: ['v*']\n"]], [
  [["branches: [main]", "branches: [main, 'v*']"]],
  [["    if: startsWith(github.ref, 'refs/tags/v')\n", ""]]
]);

// --- Jobs and matrices --------------------------------------------------------------------
scenario("needs-order", [["    needs: build\n", "    needs: [test, build]\n"]], [
  [["    needs: build\n", "    needs: tests\n"]],
  [["    needs: build\n", "    needs: [test, build]\n    if: always()\n"]],
  [["    needs: build\n", "    needs: test\n"]]
]);
assert.match(runOf("needs-order", [["    needs: build\n", "    needs: tests\n"]]).errors[1], /Job 'deploy' depends on unknown job 'tests'\./);
scenario("job-outputs", [["  build:\n    runs-on: ubuntu-latest\n", "  build:\n    runs-on: ubuntu-latest\n    outputs:\n      image: ${{ steps.meta.outputs.image }}\n"]], [
  [["  build:\n    runs-on: ubuntu-latest\n", "  build:\n    runs-on: ubuntu-latest\n    outputs:\n      image: ${{ steps.meta.outputs.tag }}\n"]],
  [["needs.build.outputs.image }}\"\n", "steps.meta.outputs.image }}\"\n"]]
]);
const smallMatrix = "        os: [ubuntu-latest]\n        node: [18, 20, 22, 24]\n        include:\n          - os: windows-latest\n            node: 24\n          - os: macos-latest\n            node: 24\n";
const bigMatrix = "        os: [ubuntu-latest, windows-latest, macos-latest]\n        node: [18, 20, 22, 24]\n        tz: [UTC, America/New_York, Asia/Kolkata, Europe/Berlin, Australia/Sydney]\n";
assert.strictEqual(runOf("matrix-size").jobs.length, 60);
scenario("matrix-size", [[bigMatrix, smallMatrix]], [
  [["      matrix:\n", "      max-parallel: 4\n      matrix:\n"]],
  [["        tz: [UTC, America/New_York, Asia/Kolkata, Europe/Berlin, Australia/Sydney]\n", ""]],
  [[bigMatrix, "        os: [ubuntu-latest]\n        node: [18, 20, 22, 24]\n"]]
]);
assert.match(log(runOf("fail-fast")), /Error: The operation was canceled\./);
scenario("fail-fast", [["      matrix:\n", "      fail-fast: false\n      matrix:\n"]], [
  [["      matrix:\n", "      max-parallel: 1\n      matrix:\n"]],
  [["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    continue-on-error: true\n"]]
]);
assert.match(log(runOf("float-version")), /Error: The version '3\.1' with architecture 'x64' was not found for Ubuntu 24\.04\.\nThe list of all available versions can be found here: https:\/\/raw\.githubusercontent\.com\/actions\/python-versions\/main\/versions-manifest\.json/);
scenario("float-version", [["[3.9, 3.10, 3.11]", '["3.9", "3.10", "3.11"]']], [
  [["[3.9, 3.10, 3.11]", "[3.9, 3.11]"]],
  [["[3.9, 3.10, 3.11]", '[3.9, "3.1", 3.11]']]
]);
scenario("runner-label", [["ubuntu-lastest", "ubuntu-latest"]], [[["ubuntu-lastest", "[self-hosted, linux]"]], [["ubuntu-lastest", "ubuntu"]]]);
assert.ok(runOf("hang").annotations.some((a) => a[1] === "The job running on runner GitHub Actions 3 has exceeded the maximum execution time of 360 minutes."));
scenario("hang", [["run: npm start\n", "run: npm start &\n"], ["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    timeout-minutes: 15\n"]], [
  [["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    timeout-minutes: 15\n"]],
  [["run: npm start\n", "run: npm start &\n"]],
  [["      - name: Start the app\n        run: npm start\n", ""], ["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    timeout-minutes: 15\n"]]
]);
assert.match(log(runOf("disk-full")), /no space left on device/);
const freeDisk = "      - run: sudo rm -rf /usr/local/lib/android /usr/share/dotnet /opt/ghc\n      - name: Build the image\n";
scenario("disk-full", [["      - name: Build the image\n", freeDisk]], [
  [["      - name: Build the image\n", "      - run: docker system prune -af\n      - name: Build the image\n"]],
  [["        run: docker build", "        continue-on-error: true\n        run: docker build"]]
]);
assert.match(log(runOf("service-db")), /Error: getaddrinfo EAI_AGAIN postgres/);
scenario("service-db", [["        image: postgres:17\n", "        image: postgres:17\n        ports:\n          - 5432:5432\n"], ["@postgres:5432", "@localhost:5432"]], [
  [["@postgres:5432", "@localhost:5432"]],
  [["        image: postgres:17\n", "        image: postgres:17\n        ports:\n          - 5432:5432\n"]]
]);

// --- Secrets and permissions ------------------------------------------------------------
const guardUpload = ["      - name: Upload coverage\n", "      - name: Upload coverage\n        if: github.event_name == 'push'\n"];
scenario("fork-secret", [guardUpload], [
  [["      - name: Upload coverage\n", "      - name: Upload coverage\n        if: secrets.COVERAGE_TOKEN != ''\n"]],
  [["      - name: Upload coverage\n", "      - name: Upload coverage\n        continue-on-error: true\n"]],
  [["  pull_request:\n", "  pull_request_target:\n"]]
]);
assert.match(runOf("fork-secret", [["      - name: Upload coverage\n", "      - name: Upload coverage\n        if: secrets.COVERAGE_TOKEN != ''\n"]]).errors[1], /Unrecognized named-value: 'secrets'/);
assert.match(log(runOf("pr-comment")), /GraphQL: Resource not accessible by integration \(addComment\)/);
scenario("pr-comment", [["  contents: read\n", "  contents: read\n  pull-requests: write\n"]], [
  [["permissions:\n  contents: read\n", "permissions: write-all\n"]],
  [["  contents: read\n", "  contents: write\n"]]
]);
assert.match(log(runOf("ghcr-push")), /denied: permission_denied: write_package/);
scenario("ghcr-push", [["  contents: read\n", "  contents: read\n  packages: write\n"]], [
  [["permissions:\n  contents: read\n", "permissions: write-all\n"]],
  [["secrets.GITHUB_TOKEN", "secrets.CR_PAT"]]
]);
scenario("env-secret", [["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment: production\n"]], [
  [["secrets.DEPLOY_TOKEN", "vars.DEPLOY_TOKEN"]],
  [["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment: staging\n"]]
]);
scenario("write-all", [["permissions: write-all\n", "permissions:\n  contents: read\n"]], [
  [["permissions: write-all\n", ""]],
  [["permissions: write-all\n", "permissions:\n  contents: write\n"]]
]);

// --- Caching and artifacts -----------------------------------------------------------
assert.match(log(runOf("cache-key")), /^Cache not found for input keys: npm-[0-9a-f]{40}$/m);
scenario("cache-key", [["key: npm-${{ github.sha }}", "key: npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}"]], [
  [["key: npm-${{ github.sha }}", "key: npm"]],
  [["key: npm-${{ github.sha }}", "key: npm-${{ github.run_id }}"]],
  [["key: npm-${{ github.sha }}", "key: npm-${{ github.sha }}\n          restore-keys: npm-"]]
]);
assert.match(log(runOf("pip-cache")), /Error: No file in \/home\/runner\/work\/shop\/shop matched to \[\*\*\/requirements\.txt or \*\*\/pyproject\.toml\], make sure you have checked out the target repository/);
scenario("pip-cache", [["          cache: pip\n", "          cache: pip\n          cache-dependency-path: requirements-dev.txt\n"]], [
  [["          cache: pip\n", ""]],
  [["          cache: pip\n", "          cache: pip\n          cache-dependency-path: requirements.txt\n"]]
]);
assert.match(log(runOf("artifact-name")), /Error: Unable to download artifact\(s\): Artifact 'build' not found/);
scenario("artifact-name", [["          name: build\n", "          name: web\n"]], [
  [["          name: build\n", ""]],
  [["          name: build\n          path: dist\n", "          name: web\n"]]
]);
assert.match(log(runOf("artifact-v3")), /Error: This request has been automatically failed because it uses a deprecated version of `actions\/upload-artifact: v3`\. Learn more: https:\/\/github\.blog\/changelog\/2024-04-16-deprecation-notice-v3-of-the-artifact-actions\//);
scenario("artifact-v3", [["upload-artifact@v3", "upload-artifact@v6"]], [[["upload-artifact@v3", "upload-artifact@v4"]], [["upload-artifact@v3", "upload-artifact@v2"]]]);
assert.match(log(runOf("artifact-conflict")), /Failed to CreateArtifact: Received non-retryable error: Failed request: \(409\) Conflict: an artifact with this name already exists on the workflow run/);
scenario("artifact-conflict", [["          name: coverage\n", "          name: coverage-${{ matrix.node }}\n"]], [
  [["          name: coverage\n", "          name: coverage\n          overwrite: true\n"]],
  [["      matrix:\n", "      fail-fast: false\n      matrix:\n"]]
]);
const shard = [["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        shard: [1, 2, 3]\n"], ["      - run: npm test\n", "      - run: npm test -- --shard=${{ matrix.shard }}/3\n"]];
const npmCache = ["          node-version: 24\n", "          node-version: 24\n          cache: npm\n"];
scenario("slow-build", [...shard, npmCache], [
  [npmCache],
  [...shard],
  [shard[0], ["      - run: npm test\n", "      - run: npm test -- --shard=1/3\n"], npmCache]
]);

// --- Deployments and environments ---------------------------------------------------
{
  const [a, b] = verify(S("concurrency"), S("concurrency").files).runs[0];
  assert.strictEqual(a.effects.deployed[0].version, 42);
  assert.ok(a.effects.deployed[0].at > b.effects.deployed[0].at, "without concurrency the older deploy finishes last");
}
scenario("concurrency", [["jobs:\n", "concurrency:\n  group: deploy-production\n  cancel-in-progress: false\njobs:\n"]], [
  [["jobs:\n", "concurrency:\n  group: ${{ github.run_id }}\njobs:\n"]],
  [["jobs:\n", "concurrency:\n  group: deploy-${{ github.sha }}\njobs:\n"]]
]);
assert.ok(solved("concurrency", [["jobs:\n", "concurrency:\n  group: deploy-production\n  cancel-in-progress: true\njobs:\n"]]), "canceling the older run also ends on 43");
assert.ok(solved("concurrency", [["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    concurrency: production\n"]]), "a job-level group works too");
assert.match(verify(S("concurrency"), filesOf("concurrency", [["jobs:\n", "concurrency:\n  group: deploy\n  cancel-in-progress: true\njobs:\n"]])).runs[0][0].annotations.map((x) => x[1]).join(), /Canceling since a higher priority waiting request for 'deploy' exists/);
scenario("approval", [["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment: production\n"]], [
  [["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment: prod\n"]]
]);
{
  const s = S("approval");
  const files = filesOf("approval", [["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment: production\n"]]);
  const [w] = E.trigger(globalThis.AQScenarios.worldOf(s), files, "push", {});
  assert.strictEqual(w.status, "waiting", "without approval the deploy waits");
  assert.ok(!w.effects.deployed.length);
}
assert.match(log(runOf("oidc")), /It looks like you might be trying to authenticate with OIDC\. Did you mean to set the `id-token` permission\?[\s\S]*Error: Credentials could not be loaded, please check your action inputs: Could not load credentials from any providers/);
assert.match(log(runOf("oidc", [["  contents: read\n", "  contents: read\n  id-token: write\n"]])), /Error: Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity/);
scenario("oidc", [["  contents: read\n", "  contents: read\n  id-token: write\n"], ["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment: production\n"]], [
  [["  contents: read\n", "  contents: read\n  id-token: write\n"]],
  [["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment: production\n"]],
  [["permissions:\n  contents: read\n", "permissions: write-all\n"], ["    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment: production\n"]]
]);

// --- Reuse --------------------------------------------------------------------------
scenario("reusable-secrets", [["      target: production\n", "      target: production\n    secrets: inherit\n"]], [
  [["      target: production\n", "      target: production\n    secrets:\n      DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n"]],
  [["    with:\n", "    env:\n      DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n    with:\n"]]
]);
assert.match(runOf("reusable-secrets", [["      target: production\n", "      target: production\n    secrets:\n      DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n"]]).errors.join("\n"), /Invalid secret, DEPLOY_TOKEN is not defined in the referenced workflow\./);
assert.ok(solved("reusable-secrets", [
  ["      target: production\n", "      target: production\n    secrets:\n      DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n"],
  ["        required: true\n", "        required: true\n    secrets:\n      DEPLOY_TOKEN:\n        required: true\n", ".github/workflows/deploy.yml"]
]), "named secrets declared in the callee also work");
assert.match(log(runOf("local-action")), /Can't find 'action\.yml', 'action\.yaml' or 'Dockerfile' under '\/home\/runner\/work\/shop\/shop\/\.github\/actions\/setup'\. Did you forget to run actions\/checkout before running your local action\?/);
scenario("local-action", [["      - uses: ./.github/actions/setup\n      - uses: actions/checkout@v6\n", "      - uses: actions/checkout@v6\n      - uses: ./.github/actions/setup\n"]], [
  [["      - uses: ./.github/actions/setup\n", "      - uses: .github/actions/setup\n"]],
  [["      - uses: ./.github/actions/setup\n", ""]]
]);
assert.match(log(runOf("composite-shell")), /action\.yml \(Line: 11, Col: 7\): Required property is missing: shell/);
scenario("composite-shell", [["    - run: npm run lint\n", "    - run: npm run lint\n      shell: bash\n", ".github/actions/setup/action.yml"]], [
  [["    - run: npm run lint\n", "", ".github/actions/setup/action.yml"]],
  [["      - uses: ./.github/actions/setup\n", "      - uses: ./.github/actions/setup\n        with:\n          shell: bash\n"]]
]);

// --- Security --------------------------------------------------------------------------
const safeTitle = [["          echo \"Checking: ${{ github.event.pull_request.title }}\"\n          echo \"${{ github.event.pull_request.title }}\" | grep", "          echo \"Checking: $TITLE\"\n          echo \"$TITLE\" | grep"],
  ["      - name: Check the title\n", "      - name: Check the title\n        env:\n          TITLE: ${{ github.event.pull_request.title }}\n"]];
assert.ok(verify(S("injection"), S("injection").files).run(1).effects.remote.length, "the $( ) title runs the attacker's script");
scenario("injection", safeTitle, [
  [["\"${{ github.event.pull_request.title }}\"", "'${{ github.event.pull_request.title }}'"], ["\"Checking: ${{ github.event.pull_request.title }}\"", "'Checking: ${{ github.event.pull_request.title }}'"]],
  [["  pull_request_target:\n", "  pull_request:\n"]]
]);
const toPR = ["  pull_request_target:\n", "  pull_request:\n"];
const noRef = ["        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n", ""];
assert.ok(verify(S("pwn-request"), S("pwn-request").files).run(0).effects.pwned, "the fork's postinstall runs with secrets");
scenario("pwn-request", [toPR, noRef, guardUpload], [
  [noRef, guardUpload],
  [toPR, noRef],
  [["  pull_request_target:\n", "  pull_request_target:\n    types: [labeled]\n"]]
]);
assert.ok(runOf("unpinned").effects.leaks.includes("DEPLOY_TOKEN"));
scenario("unpinned", [["acme/changed-files@v45", "acme/changed-files@48d8f15b2aaa3d255ca5af3eba4870f807ce6b3c # v45.0.6"]], [
  [["acme/changed-files@v45", "acme/changed-files@v45.0.6"]],
  [["acme/changed-files@v45", "acme/changed-files@48d8f15"]],
  [["acme/changed-files@v45", "acme/changed-files@0e58ed8671d6b60d0890c21b07f8835ace038e67"]]
]);
assert.match(log(runOf("unpinned", [["acme/changed-files@v45", "acme/changed-files@48d8f15"]])), /unable to find version `48d8f15`/);
scenario("secret-leak", [["      - name: Debug the token\n        run: echo \"$DEPLOY_TOKEN\" | base64\n", ""]], [
  [["        run: echo \"$DEPLOY_TOKEN\" | base64\n", "        run: |\n          echo \"::add-mask::$DEPLOY_TOKEN\"\n          echo \"$DEPLOY_TOKEN\" | base64\n"]],
  [["| base64", "| base64 | base64"]]
]);
assert.match(log(runOf("secret-leak", [["      - name: Debug the token\n        run: echo \"$DEPLOY_TOKEN\" | base64\n", "      - run: echo \"$DEPLOY_TOKEN\"\n"]])), /^\*\*\*$/m);
const narrow = [['"StringEquals": {\n          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"\n        },\n        "StringLike": {\n          "token.actions.githubusercontent.com:sub": "repo:devquest/*"\n        }',
  '"StringEquals": {\n          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",\n          "token.actions.githubusercontent.com:sub": "repo:devquest/shop:environment:production"\n        }', "aws/shop-deploy-trust.json"]];
scenario("oidc-trust", narrow, [
  [["repo:devquest/*", "repo:devquest/shop:*", "aws/shop-deploy-trust.json"]],
  [["repo:devquest/*", "repo:devquest/shop:ref:refs/heads/main", "aws/shop-deploy-trust.json"]],
  [["\"Version\"", "\"Versio", "aws/shop-deploy-trust.json"]]
]);
scenario("self-hosted", [["  test:\n    runs-on: [self-hosted, linux]\n", "  test:\n    runs-on: ubuntu-latest\n"]], [
  [["    if: github.event_name == 'push'\n", ""]],
  [["  pull_request:\n", "  pull_request_target:\n"]]
]);

// Dependabot: the fix is a Dependabot secret (set from the gh console), or skipping the upload for Dependabot is not enough.
{
  const s = S("dependabot-secret");
  const w = globalThis.AQScenarios.worldOf(s);
  assert.match(log(verify(s, s.files, w).run(0)), /Secret source: Dependabot[\s\S]*COVERAGE_TOKEN is empty/);
  assert.ok(!s.won(verify(s, s.files, { ...w, secrets: { ...w.secrets, COVERAGE_TOKEN: "new" } })), "setting the Actions secret again does not help");
  assert.ok(!solved("dependabot-secret", [["      - name: Upload coverage\n", "      - name: Upload coverage\n        if: github.actor != 'dependabot[bot]'\n"]]), "skipping the upload loses the coverage");
  assert.ok(s.won(verify(s, s.files, { ...w, dependabotSecrets: { COVERAGE_TOKEN: "cov-5d0a71e2b9" } })), "a Dependabot secret fixes it");
  tested.add(s.id);
}
scenario("stale-runs", [["jobs:\n", "concurrency:\n  group: ${{ github.workflow }}-${{ github.head_ref || github.ref }}\n  cancel-in-progress: true\njobs:\n"]], [
  [["jobs:\n", "concurrency:\n  group: ${{ github.workflow }}-${{ github.head_ref || github.ref }}\njobs:\n"]],
  [["jobs:\n", "concurrency:\n  group: ${{ github.run_id }}\n  cancel-in-progress: true\njobs:\n"]]
]);

// --- Added coverage: LFS, required checks, merge queue, token events, Windows, outputs, rate limits ---
assert.match(log(runOf("lfs")), /^version https:\/\/git-lfs\.github\.com\/spec\/v1$/m);
scenario("lfs", [["      - uses: actions/checkout@v6\n", "      - uses: actions/checkout@v6\n        with:\n          lfs: true\n"]], [
  [["      - uses: actions/checkout@v6\n", "      - uses: actions/checkout@v6\n        with:\n          fetch-depth: 0\n"]],
  [["          grep -q \"^sku,price\" data/prices.csv\n", "          grep -q \"^sku,price\" data/prices.csv || true\n"]]
]);
assert.deepStrictEqual(runOf("required-check").required, [{ name: "test", state: "expected" }]);
scenario("required-check", [["    paths:\n      - \"src/**\"\n      - package-lock.json\n", ""]], [
  [["    paths:\n", "    paths-ignore:\n"], ["      - \"src/**\"\n", "      - \"docs/**\"\n"]],
  [["  test:\n", "  tests:\n"]]
]);
scenario("merge-queue", [["  pull_request:\n", "  pull_request:\n  merge_group:\n"]], [
  [["    branches: [main]\n", "    branches: [main, \"gh-readonly-queue/**\"]\n"]].slice(0, 0).concat([["  pull_request:\n", "  pull_request:\n    types: [opened, synchronize, reopened, enqueued]\n"]]),
  [["  pull_request:\n", "  pull_request_target:\n"]]
]);
{
  const r = verify(S("token-no-trigger"), S("token-no-trigger").files).runs[0];
  assert.strictEqual(r.length, 1, "a tag pushed with the GITHUB_TOKEN starts no other workflow");
  assert.deepStrictEqual(r[0].effects.pushedTags.map((t) => t.by), ["github"]);
}
const REL = ".github/workflows/release.yml", DEP = ".github/workflows/deploy.yml";
scenario("token-no-trigger", [["      - uses: actions/checkout@v6\n", "      - uses: actions/checkout@v6\n        with:\n          token: ${{ secrets.RELEASE_APP_TOKEN }}\n", REL]], [
  [["permissions:\n  contents: write\n", "permissions: write-all\n", REL]],
  [["    tags: ['v*']\n", "    tags: ['**']\n", DEP]],
  [["    tags: ['v*']\n", "    tags: ['v*']\n    branches: [main]\n", DEP]],
  [["      - uses: actions/checkout@v6\n", "      - uses: actions/checkout@v6\n        with:\n          token: ${{ secrets.RELEASE_TOKEN }}\n", REL]]
]);
assert.ok(solved("token-no-trigger", [
  ["permissions:\n  contents: write\n", "permissions:\n  contents: write\n  actions: write\n", REL],
  ["          git push origin \"v1.4.${{ github.run_number }}\"\n", "          git push origin \"v1.4.${{ github.run_number }}\"\n          gh workflow run deploy.yml --ref \"v1.4.${{ github.run_number }}\"\n        env:\n          GH_TOKEN: ${{ github.token }}\n", REL],
  ["  push:\n    tags: ['v*']\n", "  push:\n    tags: ['v*']\n  workflow_dispatch:\n", DEP]
]), "dispatching the deploy at the tag also works");
assert.match(log(verify(S("token-no-trigger"), filesOf("token-no-trigger", [["          git push origin \"v1.4.${{ github.run_number }}\"\n", "          git push origin \"v1.4.${{ github.run_number }}\"\n          gh workflow run deploy.yml --ref v1\n        env:\n          GH_TOKEN: ${{ github.token }}\n", REL]])).run(0)),
  /HTTP 403: Resource not accessible by integration \(https:\/\/api\.github\.com\/repos\/devquest\/shop\/actions\/workflows\/deploy\.yml\/dispatches\)/);
assert.match(log(runOf("windows-shell")), /Remove-Item: A parameter cannot be found that matches parameter name 'rf'\./);
assert.match(log(runOf("windows-shell")), /shell: C:\\Program Files\\PowerShell\\7\\pwsh\.EXE -command "\. '\{0\}'"/);
scenario("windows-shell", [["      - name: Clean and build\n", "      - name: Clean and build\n        shell: bash\n"]], [
  [["os: [ubuntu-latest, windows-latest]", "os: [ubuntu-latest]"]],
  [["      - name: Clean and build\n", "      - name: Clean and build\n        shell: cmd\n"]],
  [["      - name: Clean and build\n", "      - name: Clean and build\n        continue-on-error: true\n"]]
]);
assert.match(log(runOf("windows-shell", [["      - name: Clean and build\n", "      - name: Clean and build\n        shell: cmd\n"]])), /'rm' is not recognized as an internal or external command,\noperable program or batch file\./);
assert.ok(solved("windows-shell", [["    runs-on: ${{ matrix.os }}\n", "    runs-on: ${{ matrix.os }}\n    defaults:\n      run:\n        shell: bash\n"]]), "a job-level default shell works too");
assert.match(log(runOf("secret-output")), /deploy: IMAGE is empty; nothing to deploy/);
scenario("secret-output", [
  ['run: echo "image=${{ secrets.REGISTRY }}/shop:1.4.${{ github.run_number }}" >> "$GITHUB_OUTPUT"', 'run: echo "tag=1.4.${{ github.run_number }}" >> "$GITHUB_OUTPUT"'],
  ["      image: ${{ steps.meta.outputs.image }}", "      tag: ${{ steps.meta.outputs.tag }}"],
  ["IMAGE: ${{ needs.build.outputs.image }}", "IMAGE: ${{ secrets.REGISTRY }}/shop:${{ needs.build.outputs.tag }}"]
], [
  [["      image: ${{ steps.meta.outputs.image }}", "      image-name: ${{ steps.meta.outputs.image }}"], ["needs.build.outputs.image", "needs.build.outputs.image-name"]],
  [['>> "$GITHUB_OUTPUT"', '>> "$GITHUB_ENV"']],
  [['run: echo "image=${{ secrets.REGISTRY }}/shop', 'run: echo "image=$(echo ${{ secrets.REGISTRY }} | base64)/shop']]
]);
assert.match(log(runOf("rate-limit")), /HTTP 403: API rate limit exceeded for installation ID 41806354\./);
const paged = ["          for n in $(seq 1 1500); do\n            gh api \"repos/devquest/shop/pulls/$n\" --jq .title >> titles.txt\n          done\n",
  "          gh api \"repos/devquest/shop/pulls?state=all&per_page=100\" --paginate --jq '.[].title' > titles.txt\n"];
scenario("rate-limit", [paged], [
  [["--jq .title >> titles.txt\n", "--jq .title >> titles.txt\n            sleep 1\n"]],
  [["  pull-requests: read\n", "  pull-requests: write\n"]],
  [["seq 1 1500", "seq 1 1000"]]
]);
assert.ok(solved("rate-limit", [[paged[0], "          gh pr list --state all --limit 1500 --json title --jq '.[].title' > titles.txt\n"]]), "gh pr list (GraphQL) also works");

for (const s of SCENARIOS) assert.ok(tested.has(s.id), `${s.id}: needs a fix and wrong moves in this test`);
console.log(`playground ok: ${SCENARIOS.length} scenarios, each with a fix and wrong moves`);
