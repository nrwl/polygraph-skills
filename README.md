<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/nrwl/nx-ai-agents-config/main/assets/nx-logo-light.svg">
    <img src="https://raw.githubusercontent.com/nrwl/nx-ai-agents-config/main/assets/nx-logo.svg" alt="Nx Logo" width="140">
  </picture>
</p>

<h1 align="center">Polygraph Skills</h1>

<p align="center">
  AI agent skills and subagents for <a href="https://trypolygraph.com/">Polygraph</a> — the meta-harness for maximum agentic autonomy, giving agents visibility across every repo and memory that survives every session.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Codex-555?logo=openai&logoColor=white&style=flat" alt="Codex">
  <img src="https://img.shields.io/badge/Claude_Code-555?logo=anthropic&logoColor=white&style=flat" alt="Claude Code">
  <img src="https://img.shields.io/badge/GitHub_Copilot-555?logo=github&logoColor=white&style=flat" alt="GitHub Copilot">
  <img src="https://img.shields.io/badge/Gemini-555?logo=google&logoColor=white&style=flat" alt="Gemini">
  <img src="https://img.shields.io/badge/OpenCode-555?logo=terminal&logoColor=white&style=flat" alt="OpenCode">
  <br>
  <img src="https://img.shields.io/github/license/nrwl/polygraph-skills" alt="License">
</p>

## What is Polygraph?

Polygraph is a meta-harness for maximum agentic autonomy. It works with the agents you already use and gives them what they're missing: visibility across every repo boundary, and memory that survives every session. Agents discover how repositories relate, coordinate changes across them, and hand off or resume work later with repos, branches, PRs, and logs all preserved.

## Setup

Run the interactive setup and follow the prompts:

```sh
polygraph config
```

It detects your AI agent — Claude Code, Codex, OpenCode, and more — and installs the Polygraph skills and subagents for it. Re-run it any time to add another agent or update an existing install.

## Skills

- **polygraph** — Comprehensive guidance for multi-repo coordination: session init, delegation, branch pushing, PR creation, and session management
- **await-polygraph-ci** — Wait for CI pipelines to settle across all repos in a session, investigate failures, and present fix options
- **get-latest-ci** — One-shot fetch of the latest CI pipeline execution for the current branch

## Agents

- **polygraph-init-subagent** — Discovers candidate repositories and initializes a Polygraph session
- **polygraph-delegate-subagent** — Delegates work to a child agent in another repository, polls for completion

## Development

```sh
# Install dependencies
npm install

# Regenerate generated artifacts
npm run sync-artifacts
```

## Releasing

Releases are prepared as a pull request, then published when that PR merges into `main`. Nothing publishes from a button; the PR is the record of what will ship.

1. Run the **Release PR** GitHub Actions workflow (`workflow_dispatch`) and choose a `channel`:
   - **`next`** — the pre-release channel consumed by snapshot and localhost Polygraph agent environments, and by the `polygraph-next` Claude marketplace entry. It prepares `<next patch>-next.<run number>` and, in the same PR, repoints the `polygraph-next` marketplace entry at that version.
   - **`latest`** — the production channel. Pick a `specifier` (`patch`, `minor`, or `major`); it prepares the stable `<version>`.
2. The workflow opens a `release/v<version>` PR containing the version bump (and, for `next`, the marketplace pin). Review the diff — this is your rehearsal, nothing has published yet.
3. Merge the PR. The **Release** workflow triggers on push to `main`, detects the version change, infers the channel from the version (a `-next.N` prerelease publishes to the npm `next` dist-tag, a stable version to `latest`), and publishes all three packages. Stable `latest` releases also push a `v<version>` git tag; `next` builds are identified by their prerelease version and npm dist-tag, so they carry no git tag.

The bump is based on the registry (`@polygraph/claude-plugin`'s current `latest`), not on the version already in the working tree, so an intervening `-next` version doesn't skew the stable sequence. The Claude, Codex, and OpenCode packages always share one version.

Publishing waits for approval from the `release-approval` environment reviewers before anything reaches the live registry. It uses npm OIDC trusted publishing with provenance — no npm tokens. Each package's npmjs.com trusted-publisher settings must allow regular OIDC publishing from `.github/workflows/publish.yml`; if they currently require staged publishing, a maintainer must update them before the first release. The trusted publisher can also pin the GitHub environment name `release-approval` for a tighter OIDC binding.

## Learn More

- **[Polygraph](https://trypolygraph.com/)** — The meta-harness for maximum agentic autonomy
- **[@polygraph/mcp](https://www.npmjs.com/package/@polygraph/mcp)** — The MCP server that powers Polygraph tools
## License

License information is defined in the package metadata.
