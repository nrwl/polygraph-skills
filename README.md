<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/nrwl/polygraph-skills/main/source/assets/polygraph-light.svg">
    <img src="https://raw.githubusercontent.com/nrwl/polygraph-skills/main/source/assets/polygraph.svg" alt="Polygraph Logo" width="140">
  </picture>
</p>

<h1 align="center">Polygraph Skills</h1>

<p align="center">
  AI agent skills and subagents for <a href="https://trypolygraph.com/">Polygraph</a> — the agent-agnostic meta-harness for maximum agentic autonomy, giving agents visibility across every repo and memory that survives every session.
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

Polygraph is the agent-agnostic meta-harness for maximum agentic autonomy. It works with the agents you already use and gives them what they're missing: visibility across every repo boundary, and memory that survives every session. Agents discover how repositories relate, coordinate changes across them, and hand off or resume work later with repos, branches, PRs, and logs all preserved.

## Setup

Run the interactive setup and follow the prompts:

```sh
polygraph config
```

It detects your AI agent — Claude Code, Codex, OpenCode, and more — and installs the Polygraph skills and subagents for it. Re-run it any time to add another agent or update an existing install.

### Codex: raising the long-poll ceiling

The delegate subagent polls child agents with `show_agent(waitForTransitionMs: 300000)` — a single 5-minute wait instead of a stream of short polls, which is what keeps delegation cheap. Claude Code and OpenCode honor the full wait. Codex does not by default.

Codex caps every MCP tool call at `tool_timeout_sec = 60`, so long polls effectively cap at 50s. Nothing the plugin ships can change that: a plugin's `.mcp.json` has no timeout field, and `tool_timeout_sec` is only read from `~/.codex/config.toml`. Polling still works at 50s — the MCP resolves the real ceiling per client and returns early rather than erroring — you just pay for more round trips.

To get the full 5-minute wait under Codex, set **both**:

1. `tool_timeout_sec` in `~/.codex/config.toml`:

   ```toml
   [mcp_servers.polygraph]
   tool_timeout_sec = 360
   ```

2. `POLYGRAPH_MCP_MAX_WAIT_MS` in that server's env, if you launch it from the CLI:

   ```sh
   POLYGRAPH_MCP_MAX_WAIT_MS=300000
   ```

Neither is required — they are a throughput optimization, not a correctness fix.

## Skills

- **polygraph** — Comprehensive guidance for Polygraph sessions: shared context, repository graph visibility, PR/CI state, delegation, and session management.
- **adversarial-review** — Second-opinion review of a session's work by independent reviewer agents, one per repo, running under a read-only `reviewer` role.
- **await-polygraph-ci** — Wait for CI pipelines to settle across all repos in a session, investigate failures, and present fix options.
- **get-latest-ci** — One-shot fetch of the latest CI pipeline execution for the current branch.
- **session-debrief** — Analyze the raw logs of past Polygraph sessions and produce structured, rank-ordered debriefs for use in a different session.

## Agents

- **polygraph-init-subagent** — Discovers candidate repositories and initializes a Polygraph session.
- **polygraph-delegate-subagent** — Delegates work to a child agent in another repository, polls for completion.
- **session-debrief** — Analyzes the raw logs of past Polygraph sessions and returns a structured, rank-ordered debrief for the current task.

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

- **[Polygraph](https://trypolygraph.com/)** — The agent-agnostic meta-harness for maximum agentic autonomy
- **[@polygraph/mcp](https://www.npmjs.com/package/@polygraph/mcp)** — The MCP server that powers Polygraph tools
## License

License information is defined in the package metadata.
