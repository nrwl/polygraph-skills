<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/nrwl/nx-ai-agents-config/main/assets/nx-logo-light.svg">
    <img src="https://raw.githubusercontent.com/nrwl/nx-ai-agents-config/main/assets/nx-logo.svg" alt="Nx Logo" width="140">
  </picture>
</p>

<h1 align="center">Polygraph Skills</h1>

<p align="center">
  AI agent skills and subagents for <a href="https://nx.dev/features/polygraph">Polygraph</a> — the meta-harness that gives agents visibility across every repo and memory that survives every session.
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

Polygraph is a meta-harness that gives AI agents what they're missing: visibility across every repo boundary, and memory that survives every session. Agents discover how repositories relate, coordinate changes across them, and hand off or resume work later with repos, branches, PRs, and logs all preserved.

## Skills

- **polygraph** — Comprehensive guidance for multi-repo coordination: session init, delegation, branch pushing, PR creation, and session management
- **await-polygraph-ci** — Wait for CI pipelines to settle across all repos in a session, investigate failures, and present fix options
- **get-latest-ci** — One-shot fetch of the latest CI pipeline execution for the current branch

## Agents

- **polygraph-init-subagent** — Discovers candidate repositories and initializes a Polygraph session
- **polygraph-delegate-subagent** — Delegates work to a child agent in another repository, polls for completion

## Codex Installer

The publishable Codex package now exposes an explicit installer CLI:

```sh
npx @polygraph/codex-plugin
```

That command copies the packaged Codex plugin into:

```text
~/.agents/plugins/polygraph
```

installs the packaged custom Codex subagents into:

```text
$CODEX_HOME/agents
```

updates the personal Codex marketplace at:

```text
~/.agents/plugins/marketplace.json
```

so the `polygraph` plugin points at `./.agents/plugins/polygraph`, and enables the plugin in:

```text
$CODEX_HOME/config.toml
```

`CODEX_HOME` defaults to `~/.codex` when unset.

To verify an install, run:

```sh
npx @polygraph/codex-plugin check
```

## OpenCode Plugin

The publishable OpenCode package exposes the skills and subagents through OpenCode's native plugin system. Add it to `opencode.json`:

```json
{
  "plugin": ["@polygraph/opencode-plugin"]
}
```

For repeatable installs, pin the npm version:

```json
{
  "plugin": ["@polygraph/opencode-plugin@0.4.18"]
}
```

The plugin adds its packaged `skills/` directory to OpenCode's skill paths and registers the packaged Markdown agents as `subagent` entries in OpenCode config during startup.

## Development

```sh
# Install dependencies
npm install

# Regenerate generated artifacts
npm run sync-artifacts
```

## Releasing

Run the `Release PR` GitHub Actions workflow with a version bump (`patch`, `minor`, or `major`).
It opens a release PR against `main` instead of pushing directly.
When that PR is merged, the `Stage Release` workflow automatically tags the release and publishes the Claude, Codex, and OpenCode npm packages.
A maintainer must then review and approve each staged package with 2FA before it is published to the live registry.

Configure each npm package's trusted publisher to allow `npm stage publish` from `.github/workflows/publish.yml`.
For the strictest release flow, do not allow direct `npm publish` for the trusted publisher and disallow token-based publishing after the staged workflow has been verified.

## Learn More

- **[Polygraph](https://nx.dev/features/polygraph)** — The meta-harness for cross-repo visibility and session memory
- **[@polygraph/mcp](https://www.npmjs.com/package/@polygraph/mcp)** — The MCP server that powers Polygraph tools
- **[Nx AI Agent Skills](https://github.com/nrwl/nx-ai-agents-config)** — The main Nx AI agent skills repo

## License

License information is defined in the package metadata.
