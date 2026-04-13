<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/nrwl/nx-ai-agents-config/main/assets/nx-logo-light.svg">
    <img src="https://raw.githubusercontent.com/nrwl/nx-ai-agents-config/main/assets/nx-logo.svg" alt="Nx Logo" width="140">
  </picture>
</p>

<h1 align="center">Polygraph Skills</h1>

<p align="center">
  AI agent skills and subagents for <a href="https://nx.dev/features/polygraph">Polygraph</a> multi-repo coordination. Published as a <a href="https://www.npmjs.com/package/@nrwl/polygraph-skills">Claude Code plugin</a>.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Claude_Code-555?logo=anthropic&logoColor=white&style=flat" alt="Claude Code">
  <img src="https://img.shields.io/badge/Cursor-555?logo=cursor&logoColor=white&style=flat" alt="Cursor">
  <img src="https://img.shields.io/badge/GitHub_Copilot-555?logo=github&logoColor=white&style=flat" alt="GitHub Copilot">
  <img src="https://img.shields.io/badge/Gemini-555?logo=google&logoColor=white&style=flat" alt="Gemini">
  <img src="https://img.shields.io/badge/OpenCode-555?logo=terminal&logoColor=white&style=flat" alt="OpenCode">
  <br>
  <img src="https://img.shields.io/github/license/nrwl/polygraph-skills" alt="License">
</p>

## What is Polygraph?

Polygraph coordinates changes across multiple repositories using [Nx Cloud](https://nx.dev/nx-cloud). It lets AI agents delegate work to child agents in other repos, monitor CI across repos, and manage multi-repo sessions.

## Skills

- **polygraph** — Comprehensive guidance for multi-repo coordination: session init, delegation, branch pushing, PR creation, and session management
- **await-polygraph-ci** — Wait for CI pipelines to settle across all repos in a session, investigate failures, and present fix options
- **get-latest-ci** — One-shot fetch of the latest CI pipeline execution for the current branch

## Agents

- **polygraph-init-subagent** — Discovers candidate repositories and initializes a Polygraph session
- **polygraph-delegate-subagent** — Delegates work to a child agent in another repository, polls for completion

## Installation

### Claude Code

```sh
claude plugin add @nrwl/polygraph-skills
```

### Other agents

Platform-specific outputs are generated at build time for Cursor, GitHub Copilot, Gemini, OpenCode, and Codex. Distribution for non-Claude agents is coming soon.

## Development

```sh
# Install dependencies
npm install

# Generate platform-specific outputs from source/
npm run sync-artifacts

# Build dist/ for publishing
npm run setup-publish
```

## Releasing

Run the `Release PR` GitHub Actions workflow with a version bump (`patch`, `minor`, or `major`).
It opens a release PR against `main` instead of pushing directly.
When that PR is merged, the `Publish` workflow automatically tags the release and publishes it to npm.

## Learn More

- **[Nx Cloud Polygraph](https://nx.dev/features/polygraph)** — Multi-repo coordination with Nx Cloud
- **[polygraph-mcp](https://www.npmjs.com/package/polygraph-mcp)** — The MCP server that powers Polygraph tools
- **[Nx AI Agent Skills](https://github.com/nrwl/nx-ai-agents-config)** — The main Nx AI agent skills repo

## License

MIT
