# DevOps Nimbus GitHub Actions

**GitHub Actions, zero to on-call.** Working workflows and deployment examples, and a free site that teaches GitHub Actions by fixing broken pipelines in the browser, for beginners and for engineers who run CI/CD for a team.

[![Learning site](https://img.shields.io/badge/learn-DevOps%20Nimbus-1d1d1f)](https://sandeepkomal.github.io/GitHub-Actions/)
[![CI](https://github.com/SandeepKomal/GitHub-Actions/actions/workflows/ci.yml/badge.svg)](https://github.com/SandeepKomal/GitHub-Actions/actions/workflows/ci.yml)
[![Pages](https://github.com/SandeepKomal/GitHub-Actions/actions/workflows/pages.yml/badge.svg)](https://github.com/SandeepKomal/GitHub-Actions/actions/workflows/pages.yml)
[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-CI%2FCD-2088FF?logo=githubactions&logoColor=white)](https://docs.github.com/en/actions)
[![Security](https://img.shields.io/badge/security-CodeQL%20%C2%B7%20Dependabot-2ea44f)](https://github.com/SandeepKomal/GitHub-Actions/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![No trackers](https://img.shields.io/badge/site-no%20trackers%20%C2%B7%20no%20cookies-2ea44f)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen)](CONTRIBUTING.md)
![Last commit](https://img.shields.io/github/last-commit/SandeepKomal/GitHub-Actions)
[![GitHub stars](https://img.shields.io/github/stars/SandeepKomal/GitHub-Actions?style=social)](https://github.com/SandeepKomal/GitHub-Actions/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/SandeepKomal/GitHub-Actions?style=social)](https://github.com/SandeepKomal/GitHub-Actions/network/members)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/SandeepKomal/GitHub-Actions)

**[Open the learning site](https://sandeepkomal.github.io/GitHub-Actions/)** · [Troubleshoot an error](https://sandeepkomal.github.io/GitHub-Actions/#doctor) · [Every error on one page](https://sandeepkomal.github.io/GitHub-Actions/problems.html) · [All DevOps Nimbus tracks](https://sandeepkomal.github.io/devops-nimbus/)

## Contents

- [Learn it in your browser](#learn-it-in-your-browser)
- [What's in this repository](#whats-in-this-repository)
- [Quick start](#quick-start)
- [Security principles used](#security-principles-used)
- [Kubernetes deployment notes](#kubernetes-deployment-notes)
- [GitHub Actions vs Jenkins](#github-actions-vs-jenkins)
- [Roadmap](#roadmap)
- [Repository layout](#repository-layout)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Security](#security)
- [Privacy and cost](#privacy-and-cost)
- [License and trademarks](#license-and-trademarks)
- [Author and contributors](#author-and-contributors)

## Learn it in your browser

**[sandeepkomal.github.io/GitHub-Actions](https://sandeepkomal.github.io/GitHub-Actions/)** teaches GitHub Actions by fixing broken pipelines, in the browser, with no account:

- **Playground**: a workflow simulator. Edit the YAML, send an event (push, pull request, a fork, workflow_dispatch with inputs, a schedule, a tag) and read the run job by job: needs, matrices, `if:`, step logs, exit codes, cache hits, artifacts, environments with reviewers, concurrency, token permissions and secrets on forks. 56 scenarios from a missing `runs-on` to pwn requests and OIDC trust policies, each with three hints and real error messages.
- **Path**: 12 levels, each with a lab in your own fork that uses this repository's workflows.
- **Workflow X-ray**: paste a workflow; every key is explained and risky patterns are flagged.
- **Troubleshoot**: the error messages Actions prints, each with cause, how to confirm, fix and prevention. Also as a [plain page](https://sandeepkomal.github.io/GitHub-Actions/problems.html).
- **Quiz**, **cheat sheet** and an interactive **architecture** page.
- **Scoreboard**: your score, a skill radar, learning uptime and timed on-call shifts; **Download my progress** and **Load my progress** move it to another device.

The site is static (`site/`), loads nothing from other sites and keeps progress only in your browser. Run its tests with Node.js, no install needed:

```bash
node tests/check_playground.js   # every scenario starts broken; fixes work, wrong moves do not
node tests/fuzz_playground.js    # thousands of malformed inputs, zero exceptions
node tests/check_site_data.js    # quiz, Troubleshoot, cheat sheet, problems page in sync
node tests/check_xray.js
node tools/build-problems.js     # after changing the Troubleshoot data
```

## What's in this repository

A practical GitHub Actions learning repository covering CI, testing, security scanning, container builds, artifact publishing, and Kubernetes deployment patterns.

- GitHub Actions fundamentals: events, jobs, steps, matrices, artifacts, and reusable patterns
- Python CI with automated tests
- Java/Maven build and artifact workflows
- Container build and image scanning with Trivy
- Static analysis and quality gates with SonarQube
- Kubernetes deployment patterns
- Docker Swarm deployment examples
- Secure workflow design with least-privilege permissions and secret-based configuration

## Quick start

Clone the repository:

```bash
git clone https://github.com/SandeepKomal/GitHub-Actions.git
cd GitHub-Actions
```

Run the Python example locally:

```bash
python -m pip install -r requirements-dev.txt
python -m pytest src/addition.py
```

Push a change to `main` and GitHub Actions will run the CI workflow.

## Security principles used

Workflows should:

1. Use `permissions:` explicitly instead of relying on broad defaults.
2. Keep credentials in GitHub Secrets or environment-specific secret managers.
3. Avoid hard-coded registry usernames, cloud credentials, cluster configuration, and tokens.
4. Pin third-party actions to trusted versions or commit SHAs in security-sensitive environments.
5. Scan source and container files before deployment.
6. Use immutable image tags such as a commit SHA instead of `latest` for deployments.

## Kubernetes deployment notes

The Kubernetes examples intentionally use placeholders for cluster credentials and registry settings. They are templates rather than turnkey deployments.

For production, prefer:

- OIDC/federated cloud authentication instead of long-lived access keys
- GitHub Environments for deployment approvals
- immutable container tags
- separate build and deploy jobs
- rollout status checks after `kubectl apply`

## GitHub Actions vs Jenkins

| Area | GitHub Actions | Jenkins |
|---|---|---|
| Hosting | Managed by GitHub | Usually self-hosted |
| GitHub integration | Native | Plugin-based |
| Workflow definition | YAML in repository | Pipeline/Jenkinsfile |
| Extensibility | Actions marketplace + scripts | Large plugin ecosystem |
| Operations | Less infrastructure to maintain | More infrastructure ownership |

Neither platform is universally better. The right choice depends on the environment, integrations, governance requirements, and operational model.

## Roadmap

- Reusable workflows with `workflow_call`
- Environment-based deployments
- OIDC examples for AWS
- Container publishing to GHCR
- Dependency review
- SBOM generation
- Deployment verification and rollback
- GitHub Actions hardening examples

## Repository layout

```text
.github/workflows/
├── ci.yml                 # Python CI (pinned actions, pip cache) and the site's tests
├── first-actions.yml      # Simple matrix example
├── pages.yml              # Publishes site/ to GitHub Pages
├── reusable-ci.yml        # A reusable workflow (workflow_call)
└── security.yml           # CodeQL + dependency/security checks

examples/
├── deploy-java-with-maven-sonar-k8s.yml
├── deploy-to-k8s.yml
└── deploy-to-swarm.yml

src/
└── addition.py            # Small pytest example

site/                      # The DevOps Nimbus GitHub Actions learning site (static)
tests/                     # Node tests and the fuzzer for the site
tools/build-problems.js    # Builds site/problems.html
requirements-dev.txt       # Test dependencies, also the pip cache key
README.md
```

## Troubleshooting

Paste the error from a failed run into [Troubleshoot](https://sandeepkomal.github.io/GitHub-Actions/#doctor) on the site, or search [every error on one page](https://sandeepkomal.github.io/GitHub-Actions/problems.html). Each entry gives the cause, how to confirm it, the fix and how to prevent it.

## Contributing

Contributions are welcome. Please open an issue before large changes, keep examples safe to run, and never commit secrets.

See [CONTRIBUTING.md](CONTRIBUTING.md). Before opening a pull request, run the same checks as CI: the Python tests from [Quick start](#quick-start) and the site tests from [Learn it in your browser](#learn-it-in-your-browser).

## Security

To report a vulnerability, do not post exploit details in a public issue; contact the repository owner privately through GitHub. Pushes to `main`, pull requests and a weekly schedule run CodeQL ([security.yml](.github/workflows/security.yml)), and Dependabot keeps the pinned actions up to date ([dependabot.yml](.github/dependabot.yml)). See [SECURITY.md](SECURITY.md).

## Privacy and cost

The learning site runs entirely in your browser: no accounts, cookies, trackers or database. Your progress stays in your browser unless you download it. The site is free and hosted on GitHub Pages, and the workflows here run on GitHub-hosted runners within GitHub's free minutes for public repositories.

## License and trademarks

MIT, see [LICENSE](LICENSE).

GitHub® and GitHub Actions are trademarks of GitHub, Inc. This project is independent and not affiliated with GitHub.

## Author and contributors

**Sandeep Komal** · [github.com/SandeepKomal](https://github.com/SandeepKomal)

Built and maintained with [DevopsNimbus](https://github.com/DevopsNimbus). See everyone who has contributed in the [contributors graph](https://github.com/SandeepKomal/GitHub-Actions/graphs/contributors).

If these examples help you learn GitHub Actions, starring the repository helps others discover the collection.

**Repository:** https://github.com/SandeepKomal/GitHub-Actions
