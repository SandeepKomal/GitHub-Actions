// Workflow X-ray: explains a pasted workflow line by line, offline, flags the
// risky patterns and lists what is missing. Each line's key path comes from the
// YAML reader; a dictionary of paths gives the note. Unknown keys say so.
// tests/check_xray.js drives it under Node.
"use strict";

(function (root) {
  const { parse } = root.AQYaml;
  const MAX_LINES = 400;

  // [pattern, note]. Patterns match a normalised path such as "jobs.<job>.steps[].uses".
  const FIELDS = [
    [/^name$/, "The workflow's name in the Actions tab. Without it, GitHub shows the file path."],
    [/^run-name$/, "The title of each run. It can use expressions, for example the branch or the actor."],
    [/^on$/, "The events that start this workflow."],
    [/^on(\[\])?\.push$|^on\[\]$/, "A trigger. `push` runs on every pushed commit and tag; `pull_request` on pull request activity."],
    [/^on\.push$/, "Runs on pushed commits and tags, filtered by the keys below."],
    [/^on\.pull_request$/, "Runs on pull request activity, with the merge commit checked out. Fork pull requests get no secrets and a read-only token."],
    [/^on\.pull_request_target$/, "Runs in the context of the base branch, with secrets and a write token, even for fork pull requests. Never check out or run the pull request's code here."],
    [/^on\.workflow_dispatch$/, "Adds a Run workflow button, and lets `gh workflow run` start it."],
    [/^on\.workflow_call$/, "Makes this a reusable workflow that other workflows call with `uses:`."],
    [/^on\.schedule$/, "Runs on a timetable, in UTC, on the default branch only. Times are best effort; busy hours run late."],
    [/^on\.schedule\[\]\.cron$/, "Five fields: minute, hour, day of month, month, day of week. The shortest interval is every 5 minutes."],
    [/^on\.(release|issues|issue_comment|workflow_run|merge_group|repository_dispatch|create|delete|deployment|deployment_status|pull_request_review|pull_request_review_comment|registry_package|check_run|check_suite|discussion|label|milestone|page_build|public|status|watch|fork|gollum)$/, "Another event that can start the workflow. `workflow_run` and `issue_comment` run with secrets, so treat their payloads as untrusted."],
    [/^on\.[^.]+\.types(\[\])?$/, "Which activity types of the event start it. Leave it out for the defaults (for pull requests: opened, synchronize, reopened)."],
    [/^on\.[^.]+\.branches(\[\])?$/, "Branch name patterns that start it. For pull requests, the base branch. With only branches, tag pushes do not start it."],
    [/^on\.[^.]+\.branches-ignore(\[\])?$/, "Branch patterns that do not start it. Cannot be combined with `branches` for the same event."],
    [/^on\.[^.]+\.tags(\[\])?$/, "Tag patterns that start it, for example `v*`."],
    [/^on\.[^.]+\.tags-ignore(\[\])?$/, "Tag patterns that do not start it."],
    [/^on\.[^.]+\.paths(\[\])?$/, "Run only when a changed file matches one of these patterns. A skipped required check blocks merging, so use it on optional workflows."],
    [/^on\.[^.]+\.paths-ignore(\[\])?$/, "Do not run when every changed file matches these patterns, for example docs."],
    [/^on\.(workflow_dispatch|workflow_call)\.inputs$/, "Inputs the caller or the Run workflow form provides, read with `inputs.<name>`."],
    [/^on\.(workflow_dispatch|workflow_call)\.inputs\.<input>$/, "One input: its type, whether it is required, and its default."],
    [/^on\.(workflow_dispatch|workflow_call)\.inputs\.<input>\.description$/, "Shown next to the field in the Run workflow form."],
    [/^on\.(workflow_dispatch|workflow_call)\.inputs\.<input>\.required$/, "true makes the caller provide it. For workflow_dispatch the form enforces it."],
    [/^on\.(workflow_dispatch|workflow_call)\.inputs\.<input>\.default$/, "The value when none is given. Quote numbers such as \"3.10\" so YAML keeps them as written."],
    [/^on\.(workflow_dispatch|workflow_call)\.inputs\.<input>\.type$/, "string, boolean, number; for workflow_dispatch also choice and environment."],
    [/^on\.(workflow_dispatch|workflow_call)\.inputs\.<input>\.options(\[\])?$/, "The values a choice input allows."],
    [/^on\.workflow_call\.secrets$/, "Secrets a caller may pass by name. Callers can also pass everything with `secrets: inherit`."],
    [/^on\.workflow_call\.secrets\.<secret>(\.required|\.description)?$/, "One secret the reusable workflow expects."],
    [/^on\.workflow_call\.outputs/, "Values the reusable workflow returns to its caller, from its jobs' outputs."],
    [/^on\.workflow_run(\.workflows(\[\])?)?$/, "Runs after another workflow; it has secrets even when that workflow ran for a fork."],
    [/^permissions$/, "What the GITHUB_TOKEN may do in every job. Scopes not listed get none. Start from `contents: read`."],
    [/^(jobs\.<job>\.)?permissions\.(contents)$/, "Repository contents: read to check out, write to push commits, tags or releases."],
    [/^(jobs\.<job>\.)?permissions\.(pull-requests|issues)$/, "write to comment, label or edit pull requests and issues."],
    [/^(jobs\.<job>\.)?permissions\.packages$/, "write to publish to GitHub Packages and ghcr.io."],
    [/^(jobs\.<job>\.)?permissions\.id-token$/, "write lets the job request an OIDC token, to sign in to a cloud without stored keys."],
    [/^(jobs\.<job>\.)?permissions\.(security-events|actions|checks|statuses|deployments|pages|attestations|discussions|models|repository-projects)$/, "One more scope of the GITHUB_TOKEN: read, write or none."],
    [/^jobs\.<job>\.permissions$/, "The token's permissions for this job only; replaces the workflow-level block."],
    [/^env$/, "Environment variables for every job and step."],
    [/^(jobs\.<job>\.|jobs\.<job>\.steps\[\]\.|jobs\.<job>\.services\.<service>\.|jobs\.<job>\.container\.)?env\.<var>$/, "One environment variable. Values from secrets are masked in logs; values from github.event are attacker-controlled on pull requests."],
    [/^jobs\.<job>\.env$/, "Environment variables for every step of this job."],
    [/^defaults$|^defaults\.run$|^jobs\.<job>\.defaults(\.run)?$/, "Defaults for run steps: shell and working-directory."],
    [/^(jobs\.<job>\.)?defaults\.run\.shell$/, "The shell for every run step. `bash` adds pipefail; without it the default is `bash -e`."],
    [/^(jobs\.<job>\.)?defaults\.run\.working-directory$/, "The directory every run step starts in."],
    [/^concurrency$/, "Only one run in this group at a time. A new run cancels or waits for the one in progress."],
    [/^(jobs\.<job>\.)?concurrency\.group$/, "The group name. Runs with the same name never overlap; include the branch to keep groups apart."],
    [/^(jobs\.<job>\.)?concurrency\.cancel-in-progress$/, "true cancels the older run: good for pull request CI, risky in the middle of a deploy."],
    [/^jobs\.<job>\.concurrency$/, "A concurrency group for this job only, for example one deploy at a time."],
    [/^jobs$/, "The jobs. They run in parallel on fresh runners unless `needs` orders them."],
    [/^jobs\.<job>$/, "A job: a set of steps on one runner. The id is used by `needs` and `needs.<id>.outputs`."],
    [/^jobs\.<job>\.name$/, "The job's name in the checks list. Required status checks match this name."],
    [/^jobs\.<job>\.needs(\[\])?$/, "Jobs that must succeed first. If one fails, this job is skipped unless its `if:` uses always() or failure()."],
    [/^jobs\.<job>\.if$/, "A condition: the job runs only when it is true. Without a status function, success() is added."],
    [/^jobs\.<job>\.runs-on(\[\])?$/, "The runner: a GitHub-hosted label such as ubuntu-latest, or labels of your self-hosted runners. A label no runner has waits until it times out."],
    [/^jobs\.<job>\.runs-on\.(group|labels)(\[\])?$/, "A runner group and labels, for larger or self-hosted runners."],
    [/^jobs\.<job>\.environment$/, "A deployment environment: its protection rules (reviewers, branches, wait timer) apply, and its secrets become available."],
    [/^jobs\.<job>\.environment\.(name|url)$/, "The environment's name, and the URL shown on the deployment."],
    [/^jobs\.<job>\.timeout-minutes$/, "The most this job may run. The default is 360 minutes; set it near the job's real duration."],
    [/^jobs\.<job>\.continue-on-error$/, "true lets the run succeed even if this job fails."],
    [/^jobs\.<job>\.outputs$/, "Values other jobs read through `needs.<job>.outputs`. Outputs containing secrets are dropped."],
    [/^jobs\.<job>\.outputs\.<output>$/, "One job output, usually from `steps.<id>.outputs.<name>`."],
    [/^jobs\.<job>\.strategy$/, "How to run this job several times: matrix, fail-fast, max-parallel."],
    [/^jobs\.<job>\.strategy\.matrix$/, "Every combination of these values becomes a job, up to 256. Read them with `matrix.<key>`."],
    [/^jobs\.<job>\.strategy\.matrix\.<key>(\[\])?$/, "One matrix dimension. Quote version numbers: unquoted 3.10 is the number 3.1."],
    [/^jobs\.<job>\.strategy\.matrix\.include(\[\].*)?$/, "Adds keys to matching combinations, or adds new single combinations."],
    [/^jobs\.<job>\.strategy\.matrix\.exclude(\[\].*)?$/, "Removes combinations that match."],
    [/^jobs\.<job>\.strategy\.fail-fast$/, "true (the default) cancels the other matrix jobs when one fails."],
    [/^jobs\.<job>\.strategy\.max-parallel$/, "How many matrix jobs may run at once."],
    [/^jobs\.<job>\.container(\..*)?$/, "Runs the job's steps inside this container image. Services are then reached by their names."],
    [/^jobs\.<job>\.services$/, "Containers started for this job, such as a database for integration tests."],
    [/^jobs\.<job>\.services\.<service>$/, "One service container. From the runner, reach it on localhost through `ports`; from a job container, by this name."],
    [/^jobs\.<job>\.services\.<service>\.image$/, "The service's image. Pin a version tag."],
    [/^jobs\.<job>\.services\.<service>\.ports(\[\])?$/, "Maps a service port to the runner, for example 5432:5432."],
    [/^jobs\.<job>\.services\.<service>\.(options|credentials|volumes)(\[\]|\..*)?$/, "Extra docker options, such as a health check, so steps wait until the service is ready."],
    [/^jobs\.<job>\.services\.<service>\.env$/, "Environment for the service container."],
    [/^jobs\.<job>\.uses$/, "Calls a reusable workflow: ./.github/workflows/x.yml here, or owner/repo/.github/workflows/x.yml@ref."],
    [/^jobs\.<job>\.with(\.<input>)?$/, "Inputs for the called workflow."],
    [/^jobs\.<job>\.secrets(\.<secret>)?$/, "Secrets passed to the called workflow: `inherit`, or named secrets it declares."],
    [/^jobs\.<job>\.steps$/, "The steps, run in order on the same runner. They share the workspace, not shell variables."],
    [/^jobs\.<job>\.steps\[\]$/, "One step."],
    [/^jobs\.<job>\.steps\[\]\.name$/, "The step's name in the log."],
    [/^jobs\.<job>\.steps\[\]\.id$/, "An id, so later steps can read `steps.<id>.outputs` and `steps.<id>.outcome`."],
    [/^jobs\.<job>\.steps\[\]\.if$/, "Runs the step only when true. `failure()` runs it after a failure, `always()` every time."],
    [/^jobs\.<job>\.steps\[\]\.uses$/, "An action: owner/repo@ref, ./local-path, or docker://image. Pin third-party actions to a full commit SHA."],
    [/^jobs\.<job>\.steps\[\]\.with$/, "Inputs for the action, as documented in its action.yml."],
    [/^jobs\.<job>\.steps\[\]\.with\.<input>$/, "One input for the action."],
    [/^jobs\.<job>\.steps\[\]\.run$/, "A shell script. Each step is a new shell; it stops at the first command that fails. ${{ }} is pasted in before the shell runs."],
    [/^jobs\.<job>\.steps\[\]\.shell$/, "The shell: bash (with pipefail), sh, pwsh, python. Composite actions must set it."],
    [/^jobs\.<job>\.steps\[\]\.working-directory$/, "The directory this run step starts in."],
    [/^jobs\.<job>\.steps\[\]\.env$/, "Environment variables for this step. The safe way to pass untrusted values into a script."],
    [/^jobs\.<job>\.steps\[\]\.continue-on-error$/, "true lets the job continue, and succeed, when this step fails."],
    [/^jobs\.<job>\.steps\[\]\.timeout-minutes$/, "The most this step may run."]
  ];

  // Notes for well-known action inputs.
  const INPUTS = {
    "fetch-depth": "How many commits to fetch. 1 by default; 0 fetches all history and tags, which git describe needs.",
    "persist-credentials": "false keeps the token out of .git/config, so later steps cannot push with it.",
    ref: "Which commit to check out. In pull_request_target, never the pull request's head.",
    "node-version": "The Node.js version, for example 24. Quote versions like \"22.x\".",
    "python-version": "The Python version. Quote it: \"3.10\", not 3.10.",
    "java-version": "The Java version.",
    cache: "Cache the package manager's downloads, keyed on the lockfile.",
    "cache-dependency-path": "Which dependency files make the cache key.",
    path: "The files or folders, one per line.",
    key: "The cache key. Make it change only when the contents should: the OS and hashFiles of the lockfile.",
    "restore-keys": "Prefixes to fall back to when the key has no exact match.",
    name: "The artifact's name; unique within a run.",
    "retention-days": "How long the artifact is kept. Shorter is cheaper.",
    "if-no-files-found": "warn (default), error or ignore when the path matches nothing.",
    "role-to-assume": "The cloud role to assume with OIDC; its trust policy decides which repos and environments may.",
    "aws-region": "The AWS region.",
    languages: "Which languages CodeQL analyses.",
    "github-token": "The token the action uses; usually the default GITHUB_TOKEN."
  };

  function normalise(path) {
    const out = [];
    for (let i = 0; i < path.length; i++) {
      const k = path[i], prev = out[out.length - 1], before = out[out.length - 2];
      if (typeof k === "number") { out[out.length - 1] = prev + "[]"; continue; }
      let seg = k;
      if (prev === "jobs" && out.length === 1) seg = "<job>";
      else if (prev === "env") seg = "<var>";
      else if (prev === "with") seg = "<input>";
      else if (prev === "outputs" && before !== "workflow_call") seg = "<output>";
      else if (prev === "services") seg = "<service>";
      else if (prev === "matrix" && k !== "include" && k !== "exclude") seg = "<key>";
      else if (prev === "inputs") seg = "<input>";
      else if (prev === "secrets" && (before === "workflow_call" || before === "<job>")) seg = before === "<job>" ? "<secret>" : "<secret>";
      out.push(seg);
    }
    return out.join(".").replace(/\.\[\]/g, "[]");
  }

  const UNTRUSTED = /\$\{\{\s*(github\.event\.(pull_request|issue|comment|review|review_comment|discussion|head_commit|commits|pages|workflow_run)\b[^}]*|github\.head_ref)\s*\}\}/;

  function explain(text) {
    const raw = String(text).replace(/\r\n?/g, "\n");
    const n = raw.split("\n").length;
    if (n > MAX_LINES) return { error: `That is ${n} lines. Paste one workflow of up to ${MAX_LINES} lines.` };
    const p = parse(raw);
    if (p.error) return { error: `${p.error.message}. ${p.error.detail}`, line: p.error.line };
    const wf = p.value && typeof p.value === "object" && !Array.isArray(p.value) ? p.value : {};
    const jobs = wf.jobs && typeof wf.jobs === "object" ? wf.jobs : {};
    const on = wf.on;
    const events = typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : on && typeof on === "object" ? Object.keys(on) : [];
    const prTarget = events.includes("pull_request_target") || events.includes("workflow_run");
    const untrustedPR = events.includes("pull_request") || events.includes("pull_request_target");
    const stepOf = (path) => { const j = jobs[path[1]]; return j && Array.isArray(j.steps) ? j.steps[path[3]] : null; };

    const lines = p.lines.map((m) => {
      const line = m.text;
      if (m.kind === "blank" && !line.trim()) return { line, note: null, level: "blank", warns: [] };
      if (m.kind === "comment" || !m.path) return { line, note: m.kind === "comment" ? "A comment. Ignored by GitHub." : "Part of the value above.", level: "info", warns: [] };
      if (m.kind === "cont") return { line, note: "Part of the multi-line value above.", level: "cont", warns: warnFor(m.path, line) };
      const key = normalise(m.path);
      const last = m.path[m.path.length - 1];
      // Well-known action inputs get their own note before the generic one.
      let note = /\.with\.<input>$/.test(key) && INPUTS[last] ? INPUTS[last] : (FIELDS.find(([re]) => re.test(key)) || [])[1];
      if (!note && /\[\]$/.test(key)) note = "One entry in the list above.";
      return { line, note: note || `Not in the X-ray's dictionary: ${key}. Check the spelling and the indentation.`, level: note ? "info" : "unknown", warns: warnFor(m.path, line) };
    });

    function warnFor(path, line) {
      const w = [];
      const key = normalise(path);
      const value = line.replace(/^[^:]*:\s*/, "");
      const step = path[0] === "jobs" && path[2] === "steps" ? stepOf(path) : null;
      const withKey = path[path.length - 2] === "with" ? path[path.length - 1] : null;
      if (/\.run$/.test(key) || (key.endsWith(".run") === false && path[path.length - 1] === "run")) {
        if (UNTRUSTED.test(line)) w.push("Script injection: an attacker controls this value (titles, branch names, comments), and ${{ }} pastes it into the script as code. Pass it through env: and use \"$VAR\".");
        if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(line)) w.push("curl | bash runs whatever the server returns today. Download a pinned version and check its checksum.");
        if (/\b(echo|printf|cat)\b.*(\$\{\{\s*secrets\.|\$\{?[A-Z_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)\b)/.test(line)) w.push("Prints a secret. Masking catches only the exact value; piped, encoded or split, it appears in the log.");
      }
      if (path[path.length - 1] === "uses" && typeof (step || {}).uses === "string") {
        const u = step.uses;
        if (!/^(\.\/|docker:\/\/)/.test(u) && !/@[0-9a-f]{40}$/.test(u)) {
          w.push(/^(actions|github)\//.test(u)
            ? "Not pinned to a full commit SHA. GitHub's own actions are lower risk, but a SHA (with the version in a comment) is the only immutable reference."
            : "Third-party action not pinned to a full commit SHA. A tag can be moved to malicious code; pin owner/repo@<40-character SHA> # vX.Y.Z.");
        }
      }
      if (withKey === "ref" && prTarget && /head|pull_request\.|refs\/pull/.test(line)) w.push("Checks out the pull request's code in a workflow that has secrets and a write token: a pwn request. Use pull_request for untrusted code.");
      if (key === "on.pull_request_target" || (key === "on[]" && /pull_request_target/.test(line)) || (key === "on" && /pull_request_target/.test(line))) w.push("pull_request_target runs with secrets on fork pull requests. Use it only for trusted metadata tasks, never to build or test the pull request.");
      if (/(^|\.)permissions$/.test(key) && /write-all/.test(value)) w.push("write-all gives the token every write permission. List only the scopes the job needs.");
      if (/permissions\.contents$/.test(key) && /write/.test(value)) {
        const writesCode = Object.values(jobs).some((j) => j && Array.isArray(j.steps) && j.steps.some((s) => s && /git push|gh release|git tag|create-release|softprops\/action-gh-release|semantic-release|changesets/.test(String(s.run || s.uses || ""))));
        if (!writesCode) w.push("contents: write, but no step pushes commits, tags or releases. read is enough.");
      }
      if (/continue-on-error$/.test(key) && /true/.test(value)) w.push("Hides failures: the job or run turns green even when this fails.");
      if (withKey === "key" && step && /actions\/cache/.test(String(step.uses)) && !/hashFiles/.test(line)) w.push("A cache key without hashFiles(...) either never changes (stale cache) or changes every run (never hits).");
      if (/runs-on(\[\])?$/.test(key) && /self-hosted/.test(line) && untrustedPR) w.push("Self-hosted runner on a workflow that pull requests start. On a public repository, anyone's fork can run code on this machine.");
      if (/\.uses$/.test(key) && path.length === 3 && /@(main|master)$/.test(line)) w.push("Calls a reusable workflow at a moving branch. Pin it to a tag or SHA.");
      if (/\.image$/.test(key) && /:latest\b|^[^:@]*$/.test(value.trim())) w.push("No fixed version: :latest changes under you. Pin a tag or digest.");
      return w;
    }

    // What is missing, for the file as a whole.
    const review = [];
    if (!("permissions" in wf) && !Object.values(jobs).every((j) => j && typeof j === "object" && "permissions" in j)) review.push("No permissions block: the token gets the repository's default, which on older repositories is write to everything. Add `permissions: contents: read` at the top.");
    for (const [id, j] of Object.entries(jobs)) {
      if (!j || typeof j !== "object" || j.uses) continue;
      if (!("timeout-minutes" in j)) review.push(`Job ${id} has no timeout-minutes: a hang runs for 6 hours. Set it near the job's real duration.`);
      const deploys = j.environment != null || /deploy|release|publish/i.test(id) || (Array.isArray(j.steps) && j.steps.some((s) => s && /deploy|kubectl apply|terraform apply|helm upgrade|s3 sync/.test(String(s.run || ""))));
      if (deploys && !("concurrency" in wf) && !("concurrency" in j)) review.push(`Job ${id} deploys without a concurrency group: two runs can deploy at once and the older one can finish last.`);
    }
    if (!events.length) review.push("No `on:` triggers: this workflow never runs.");
    return { lines, review, events };
  }

  root.AQXray = { explain };
})(typeof window !== "undefined" ? window : globalThis);
