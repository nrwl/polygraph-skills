# Capture wake hook contract

The wake hooks in this directory carry capture liveness only. Transcript
records remain canonical for prompts, answers, completion, and step
boundaries. No wake event communicates a semantic boundary, and no wake may
create, close, or cancel a step or pass a status.

## Wake events per harness

Each harness wakes capture on prompt submission and on agent-done/idle,
using the lifecycle events its plugin API actually exposes:

- Claude Code: `UserPromptSubmit` and `Stop` (manifest-async).
- Codex: `UserPromptSubmit` and `Stop` (hook detaches via `--detach`).
- OpenCode: `chat.message` and the `session.idle` bus event (in-process,
  deferred; subagent sessions resolve to their root before waking).
- Cursor: `beforeSubmitPrompt` only (hook detaches via `--detach`; it is a
  blocking hook, so the parent process must return immediately and emit
  nothing on stdout). Cursor does not dispatch `stop` to plugin-scope hooks
  and nothing may prompt a user-scope `~/.cursor/hooks.json` registration,
  so cursor has no agent-done wake; the wake claim builder still accepts a
  `stop` payload in case a future cursor build dispatches it.

Every wake calls `_ensure-agent-session-capture` with agent identity,
working directory, and transcript path only. There is no `--source` on the
ensure command: a liveness poke has no mapping provenance. Which event fired
is never forwarded — prompt-submit and agent-done wakes are identical
invocations.

## Execution rules

Command-hook wakes are bounded by one shared five-second deadline,
repeatable, and may overlap or arrive out of order with SessionEnd. A
timed-out or ambiguously executed command is never retried by the plugin.
An older CLI that reports `_ensure-agent-session-capture` as unsupported is
retried once through the established identity-only `_link-agent-session`
command, which keeps `--source hook` because the mapping it records carries
provenance. A wake is successful only when the preferred command or that
fallback exits successfully.

A `POLYGRAPH_CLI` that points at a plain `.js`/`.mjs`/`.cjs` entry always
runs through a Node runtime — never executed directly — so exactly one
process launches per wake even on hosts (Bun in OpenCode) that throw spawn
launch errors synchronously instead of reporting them on the result.

Detached wakes (`--detach`) and Claude's SessionEnd finalization hand off to
a detached Node worker. The worker owns the complete CLI invocation and
writes failures durably to `~/.polygraph/logs`; the short-lived hook process
observes launch errors only.

## Finalization

Only Claude's `SessionEnd` finalizes (`_finalize-agent-session`, which keeps
`--source`): it is the one lifecycle event among the supported harnesses that
reliably means session exit. Ordinary Stop/idle events never finalize.
Cursor documents an observational `sessionEnd`, unverified under
`cursor-agent`; it is deliberately not wired up yet.

## Environment

All wake and finalize invocations preserve the hook environment except for
`POLYGRAPH_SESSION_ID` and `POLYGRAPH_CAPTURE_TOKEN`. A
`POLYGRAPH_CHILD_AGENT` environment disables every wake and finalize. On
Windows, Ocean may provide `POLYGRAPH_CLI_REEXEC` as a JSON argv array for a
shell-free invocation of the exact CLI build.

## Ocean's obligations

Ocean must provide the ordering guarantee the plugin cannot impose across
asynchronous hooks: ensure/link and finalize are idempotent for an agent
session, finalize dominates an in-flight or later wake, and a wake after
finalization does not resurrect capture. Ocean should emit
`POLYGRAPH_ENSURE_AGENT_SESSION_CAPTURE_UNSUPPORTED` when a CLI
intentionally cannot serve the ensure command; the plugin also recognizes
the legacy `Unknown argument: _ensure-agent-session-capture` response.
