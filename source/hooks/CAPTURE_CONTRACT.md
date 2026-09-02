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
- OpenCode: `chat.message` (session from the hook's documented
  `input.sessionID`) and the `session.idle` bus event (both deferred to a
  detached worker; subagent sessions resolve to their root before waking).
- Cursor: `beforeSubmitPrompt`, `afterAgentResponse`, and `stop` (all
  detach via `--detach`). `beforeSubmitPrompt` is a blocking hook, so the
  parent process must return immediately and emit nothing on stdout.
  `afterAgentResponse` is the agent-done wake: an observational hook that
  fires once an assistant message completes, in the same family as
  `afterAgentThought`, which `cursor-agent --plugin-dir` probes dispatch at
  plugin scope. It carries the message text, which the wake never forwards.
  `stop` is Cursor's observational agent-loop-end hook; its only output
  field (`followup_message`) would auto-submit another prompt, so the wake
  never writes to stdout. Plugin-scope dispatch of `stop` is unconfirmed
  (probes observed `sessionStart`, `afterAgentThought`, `postToolUse`, and
  `sessionEnd`, never `stop`): an undispatched registration is inert and a
  dispatched one repeats the same idempotent poke. All registrations live in
  the plugin manifest; nothing may prompt a user-scope `~/.cursor/hooks.json`
  registration. None of these events defines a step boundary — a
  multi-message turn wakes more than once, and the transcript alone decides
  where steps begin and end.

Every wake calls `_ensure-agent-session-capture` with only the agent type and
harness session ID. Mutable working-directory and transcript-path evidence
must not narrow an ensure lookup. There is no `--source` on the ensure
command: a liveness poke has no mapping provenance. Which event fired is
never forwarded — prompt-submit and agent-done wakes are identical
invocations. The legacy `_link-agent-session` compatibility fallback keeps
the working directory, transcript path, and `--source hook` because it still
records a mapping.

## Process identity

A mapping PID lets Ocean close capture when the harness exits, so a link
carries a PID only when it names the long-lived harness process. Wakes
(`_ensure-agent-session-capture` and its legacy fallback) never carry one.
Cursor runs every hook through a short-lived shell wrapper: a hook's parent
PID is that wrapper, not `cursor-agent`, and Cursor's payload and environment
expose no harness PID. Cursor links therefore omit `--pid` entirely, and
Ocean's transcript and explicit harness-exit mechanisms govern that
lifecycle rather than a PID that dies the moment the hook returns. OpenCode
links carry the in-process plugin host's own PID. Claude SessionStart omits
the PID because the asynchronous hook's parent can be stale; other Claude
and Codex links are unchanged.

## Execution rules

Command-hook wakes are bounded by one shared five-second deadline,
repeatable, and may overlap or arrive out of order with SessionEnd. A
timed-out or ambiguously executed command is never retried by the plugin.
An older CLI that reports `_ensure-agent-session-capture` as unsupported is
retried once through the established `_link-agent-session` mapping command.
The version-skew check accepts Ocean's explicit marker and the observed Shell
0.1.x root-usage/validation response whose first rejected argument is the
hidden command. Other CLI failures never trigger the fallback. A wake is
successful only when the preferred command or that fallback exits
successfully, so a successful compatibility wake does not log the old CLI's
full usage on every prompt and done event.

A `POLYGRAPH_CLI` that points at a plain `.js`/`.mjs`/`.cjs` entry always
runs through a Node runtime — never executed directly — so exactly one
process launches per wake even on hosts (Bun in OpenCode) that throw spawn
launch errors synchronously instead of reporting them on the result.

Detached command hooks, OpenCode wakes, and Claude's SessionEnd finalization
hand off to a detached worker. A wake worker enforces the shared five-second
CLI kill deadline; the finalization worker allows at most 90 seconds. Each
worker owns the complete CLI invocation and writes failures durably to
`~/.polygraph/logs`; the harness event loop observes launch errors only.
Workers always launch through a Node runtime — `process.execPath` when it is
Node, otherwise `node` from PATH — because OpenCode hosts the plugin inside
a compiled Bun binary.

## Finalization

Only Claude's `SessionEnd` finalizes (`_finalize-agent-session`, which keeps
`--source`): it is the one lifecycle event among the supported harnesses that
reliably means session exit. Claude `SessionStart` accepts `startup`, `resume`,
`clear`, and `compact`. Ordinary Stop/idle events never finalize. Cursor
documents an observational `sessionEnd`, unverified under `cursor-agent`; it
is deliberately not wired up yet.

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
the legacy Shell 0.1.x stdout response: root `Usage: polygraph`, followed by
`Validation failed for one or more options` and `Unknown argument:
_ensure-agent-session-capture`, with exit status 1 and empty stderr.
