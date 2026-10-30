# GitHub Actions CI/CD Examples

A practical GitHub Actions learning repository covering CI, testing, security scanning, container builds, artifact publishing, and Kubernetes deployment patterns.

[![CI](https://github.com/SandeepKomal/GitHub-Actions/actions/workflows/ci.yml/badge.svg)](https://github.com/SandeepKomal/GitHub-Actions/actions/workflows/ci.yml)
[![Security](https://img.shields.io/badge/security-Trivy%20%2B%20CodeQL-blue)](https://github.com/SandeepKomal/GitHub-Actions)
[![GitHub stars](https://img.shields.io/github/stars/SandeepKomal/GitHub-Actions?style=flat)](https://github.com/SandeepKomal/GitHub-Actions/stargazers)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## Actions Quest: the learning site

**[sandeepkomal.github.io/GitHub-Actions](https://sandeepkomal.github.io/GitHub-Actions/)** teaches GitHub Actions by fixing broken pipelines, in the browser, with no account:

- **Playground**: a workflow simulator. Edit the YAML, send an event (push, pull request, a fork, workflow_dispatch with inputs, a schedule, a tag) and read the run job by job: needs, matrices, `if:`, step logs, exit codes, cache hits, artifacts, environments with reviewers, concurrency, token permissions and secrets on forks. 49 scenarios from a missing `runs-on` to pwn requests and OIDC trust policies, each with three hints and real error messages.
- **Path**: 12 levels, each with a lab in your own fork that uses this repository's workflows.
- **Workflow X-ray**: paste a workflow; every key is explained and risky patterns are flagged.
- **Troubleshoot**: the error messages Actions prints, each with cause, how to confirm, fix and prevention. Also as a [plain page](https://sandeepkomal.github.io/GitHub-Actions/problems.html).
- **Quiz**, **cheat sheet** and an interactive **architecture** page.

The site is static (`site/`), loads nothing from other sites and keeps progress only in your browser. Run its tests with Node.js, no install needed:

```bash
node tests/check_playground.js   # every scenario starts broken; fixes work, wrong moves do not
node tests/fuzz_playground.js    # thousands of malformed inputs, zero exceptions
node tests/check_site_data.js    # quiz, Troubleshoot, cheat sheet, problems page in sync
node tests/check_xray.js
node tools/build-problems.js     # after changing the Troubleshoot data
```

## What this repository demonstrates

- GitHub Actions fundamentals: events, jobs, steps, matrices, artifacts, and reusable patterns
- Python CI with automated tests
- Java/Maven build and artifact workflows
- Container build and image scanning with Trivy
- Static analysis and quality gates with SonarQube
- Kubernetes deployment patterns
- Docker Swarm deployment examples
- Secure workflow design with least-privilege permissions and secret-based configuration

## Repository map

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

site/                      # The Actions Quest learning site (static)
tests/                     # Node tests and the fuzzer for the site
tools/build-problems.js    # Builds site/problems.html
requirements-dev.txt       # Test dependencies, also the pip cache key
README.md
```

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

## Contributing

Contributions are welcome. Please open an issue before large changes, keep examples safe to run, and never commit secrets.

## Roadmap

- Reusable workflows with `workflow_call`
- Environment-based deployments
- OIDC examples for AWS
- Container publishing to GHCR
- Dependency review
- SBOM generation
- Deployment verification and rollback
- GitHub Actions hardening examples

## ⭐

If these examples help you learn GitHub Actions, starring the repository helps others discover the collection.

**Repository:** https://github.com/SandeepKomal/GitHub-Actions
