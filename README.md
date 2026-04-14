<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/nrwl/nx-ai-agents-config/main/assets/nx-logo-light.svg">
    <img src="https://raw.githubusercontent.com/nrwl/nx-ai-agents-config/main/assets/nx-logo.svg" alt="Nx Logo" width="140">
  </picture>
</p>

<h1 align="center">Polygraph Skills</h1>

<p align="center">
  AI agent skills and subagents for <a href="https://nx.dev/features/polygraph">Polygraph</a> multi-repo coordination. The build writes publishable package roots into <code>dist/</code>.
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

Polygraph coordinates changes across multiple repositories using [Nx Cloud](https://nx.dev/nx-cloud). It lets AI agents delegate work to child agents in other repos, monitor CI across repos, and manage multi-repo sessions.

## Skills

- **polygraph** — Comprehensive guidance for multi-repo coordination: session init, delegation, branch pushing, PR creation, and session management
- **await-polygraph-ci** — Wait for CI pipelines to settle across all repos in a session, investigate failures, and present fix options
- **get-latest-ci** — One-shot fetch of the latest CI pipeline execution for the current branch

## Agents

- **polygraph-init-subagent** — Discovers candidate repositories and initializes a Polygraph session
- **polygraph-delegate-subagent** — Delegates work to a child agent in another repository, polls for completion

## Dist Layout

- `dist/claude` — publishable Claude plugin npm package (`polygraph-claude-plugin`)
- `dist/codex` — publishable Codex plugin npm package (`polygraph-codex-plugin`)
- `dist/opencode` — generated OpenCode artifacts

## Codex Installer

The publishable Codex package now exposes an explicit installer CLI:

```sh
npx polygraph-codex-plugin
```

That command copies the packaged Codex plugin payload into:

```text
$CODEX_HOME/plugins/cache/polygraph/polygraph/<version>
```

and enables the plugin in:

```text
$CODEX_HOME/config.toml
```

`CODEX_HOME` defaults to `~/.codex` when unset.

To verify an install, run:

```sh
npx polygraph-codex-plugin check
```

## Development

```sh
# Install dependencies
npm install

# Generate dist/ directly from source/
npm run sync-artifacts
```

## Releasing

Run the `Release PR` GitHub Actions workflow with a version bump (`patch`, `minor`, or `major`).
It opens a release PR against `main` instead of pushing directly.
When that PR is merged, the `Publish` workflow automatically tags the release and publishes both `dist/claude` and `dist/codex` to npm.

## Learn More

- **[Nx Cloud Polygraph](https://nx.dev/features/polygraph)** — Multi-repo coordination with Nx Cloud
- **[polygraph-mcp](https://www.npmjs.com/package/polygraph-mcp)** — The MCP server that powers Polygraph tools
- **[Nx AI Agent Skills](https://github.com/nrwl/nx-ai-agents-config)** — The main Nx AI agent skills repo

## License

License information is defined in the package metadata.
