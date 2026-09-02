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

Detached command hooks, OpenCode wakes, and Claude/Cursor finalization hand
off to a detached worker. A wake worker enforces the shared five-second CLI
kill deadline; the finalization worker allows at most 90 seconds. Each
worker owns the complete CLI invocation and writes failures durably to
`~/.polygraph/logs/hooks.log`; the harness event loop observes launch errors
only. Workers always launch through a Node runtime — `process.execPath` when
it is Node, otherwise `node` from PATH — because OpenCode hosts the plugin
inside a compiled Bun binary.

A worker's inherited stdout/stderr go to `~/.polygraph/logs/capture-wake.log`
or `session-finalize.log`, each rotated to `.1` once it exceeds 5 MiB, the
same bound as `hooks.log`. If that file cannot be opened, the worker still
launches with its output discarded and the failure is logged best-effort;
no hook ever writes to its own stdout, and no hook waits on a worker.

## Finalization

Claude's `SessionEnd` and Cursor's `sessionEnd` finalize
(`_finalize-agent-session`, which keeps `--source`): each is the one
lifecycle event of its harness that means the conversation has ended. Both
hand off to the detached finalization worker and emit nothing on stdout.
Cursor's `sessionEnd` is observational and dispatched to plugin-scope hooks
under `cursor-agent --plugin-dir`; its payload carries `session_id` and
`conversation_id`, `workspace_roots`, `transcript_path`, `reason`, and
`final_status`. The finalize claim forwards identity, working directory,
transcript path, and `--source hook` only — never a PID (Cursor's hook parent
is a transient wrapper) and never the end reason, because the transcript
alone decides what the final answer was. Claude `SessionStart` accepts
`startup`, `resume`, `clear`, and `compact`. Ordinary Stop/idle events never
finalize. Codex and OpenCode expose no reliable session-exit event and do
not finalize.

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
finalization does not resurrect capture. Concretely, Ocean keeps a terminal
marker for each finalized harness session and applies a freshness guard to
it: a delayed or reordered wake that names a harness session with a terminal
marker is a no-op and never resurrects capture, while a genuinely newer
session mapping for that identity — a later SessionStart/sessionStart link
recorded after the marker — may supersede the older terminal marker and
start fresh capture. The plugin never distinguishes the two cases; it
issues the same identity-only wake either way. Ocean should emit
`POLYGRAPH_ENSURE_AGENT_SESSION_CAPTURE_UNSUPPORTED` when a CLI
intentionally cannot serve the ensure command; the plugin also recognizes
the legacy Shell 0.1.x stdout response: root `Usage: polygraph`, followed by
`Validation failed for one or more options` and `Unknown argument:
_ensure-agent-session-capture`, with exit status 1 and empty stderr.
