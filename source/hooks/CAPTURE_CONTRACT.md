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
  parent process must return immediately and emit nothing on stdout; Cursor
  treats empty output as allow. `afterAgentResponse` is the agent-done wake:
  an observational hook that fires once an assistant message completes. It
  carries the message text, which the wake never forwards. `stop` is
  Cursor's blocking agent-loop-end hook: it may answer with a
  `followup_message`, which Cursor auto-submits as the next prompt, so the
  wake exits 0 with empty stdout and never writes to it — Cursor treats no
  output as no follow-up. Live multi-turn runs under `cursor-agent --plugin-dir`
  dispatched `beforeSubmitPrompt`, `afterAgentResponse`, `sessionStart`,
  `afterAgentThought`, `postToolUse`, and `sessionEnd` to plugin-scope
  hooks; `stop` was never observed, so its registration is inert unless a
  Cursor build dispatches it, in which case it repeats the same idempotent
  poke. All registrations live in the plugin manifest; nothing may prompt a
  user-scope `~/.cursor/hooks.json` registration. None of these events
  defines a step boundary — a multi-message turn wakes more than once, and
  the transcript alone decides where steps begin and end.

Every wake calls `_ensure-agent-session-capture` with the agent type, the
harness session ID, and `--observed-at <ms>`: the epoch-millisecond time at
which the hook fired, read synchronously in the hook process (for OpenCode,
in the event handler) before any deferral or worker detach. Ocean uses it to
refresh the exact mapping and to compare terminal-marker freshness. It is
lifecycle/liveness metadata only — never a step boundary and never data —
and a worker's own start time is never used, so a delayed worker cannot
present its startup as evidence that the harness was still live. Mutable
working-directory and transcript-path evidence must not narrow an ensure
lookup. There is no `--source` on the ensure command: a liveness poke has no
mapping provenance. Which event fired is never forwarded — prompt-submit and
agent-done wakes are identical invocations apart from the timestamp. The
legacy `_link-agent-session` compatibility fallback keeps the working
directory, transcript path, and `--source hook` because it still records a
mapping, and never carries `--observed-at`. `_finalize-agent-session` carries
its own `--observed-at`, described under Finalization.

## Process identity

Harness and plugin links never carry a PID. A command hook's `process.ppid`
is an implementation detail of the harness's hook launcher and may name a
short-lived shell or helper rather than the agent. OpenCode's in-process
plugin PID is host-wide rather than session-specific. Neither is trustworthy
session lifecycle evidence, so `_link-agent-session`, capture wakes, and
finalizers never emit `--pid`. Claude, Codex, and Cursor use their explicit
session-end events for graceful finalization. OpenCode exposes no trustworthy
per-session exit event; capture already uploads transcript records
incrementally, and an unobserved hard exit does not create a semantic boundary.

## Execution rules

Command-hook wakes are bounded by one shared twenty-second deadline,
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

Every launch — the wake or finalize CLI process and the detached worker —
starts from a directory that exists: the claim's working directory when it
still does, else the home directory, else the temp directory. A harness
working directory can vanish before a delayed hook runs (an archived
session worktree), and a spawn from a missing cwd fails with ENOENT before
the CLI starts, which would silently drop a finalize. The fallback changes
only where the process starts; the `--cwd` evidence on the finalize and
legacy link commands stays the claim's original directory. The
`_link-agent-session` process run by `record-session-mapping` (SessionStart
and PostToolUse links) launches by the same rule while keeping its
synchronous, unbounded, stdout-ignored contract. A hook's own working
directory is consulted only when the payload carries none, only inside the
protected path, and only for Claude and Codex, whose command hooks run in the
session directory: a hook already running from a deleted directory
(`process.cwd()` fails with `uv_cwd`) still reaches that fallback instead of
crashing before it. Cursor runs plugin hooks from the plugin root, which is
never the repository, so a Cursor payload without `workspace_roots` yields a
claim with no directory and no `--cwd` on the finalize or legacy link
command; the launch then starts from the home directory as a spawn detail
only.

Detached command hooks, OpenCode wakes, and Claude/Codex/Cursor finalization
hand off to a detached worker. A wake worker enforces the shared twenty-second
CLI kill deadline; the finalization worker allows at most 90 seconds. Each
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

Claude's and Codex's `SessionEnd` and Cursor's `sessionEnd` finalize
(`_finalize-agent-session`, which keeps `--source`): each is the one
lifecycle event of its harness that means the conversation has ended. All
three hand off to the detached finalization worker and emit nothing on stdout.
Cursor's `sessionEnd` is observational and dispatched to plugin-scope hooks
under `cursor-agent --plugin-dir`; its payload carries `session_id` and
`conversation_id`, `workspace_roots`, `transcript_path`, `reason`, and
`final_status`. The finalize claim forwards identity, working directory,
transcript path, `--source hook`, and `--observed-at <ms>` — the
epoch-millisecond time at which the session-end hook fired, read
synchronously in the hook process before the worker detaches, exactly as a
wake reads it — and never a PID (Cursor's hook parent is a transient
wrapper) or the end reason, because the transcript alone decides what the
final answer was. The observation time is what lets Ocean order a finalize
against wakes and relinks: the finalization worker may run up to 90 seconds
after the harness exit it describes, and its own start time is never used. Claude `SessionStart` accepts
`startup`, `resume`, `clear`, `compact`, and `fork`. Ordinary Stop/idle
events never finalize. Codex's graceful `SessionEnd` hook has a one-second
default budget and three-second maximum; the hook only launches the detached
worker, so final capture continues outside that budget. OpenCode exposes no
trustworthy per-session exit event and cannot finalize.

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
it: a delayed or reordered wake whose `--observed-at` does not postdate a
harness session's terminal marker is a no-op and never resurrects capture,
while a genuinely newer session mapping for that identity — a later
SessionStart/sessionStart link recorded after the marker — may supersede
the older terminal marker and start fresh capture. The plugin never
distinguishes the two cases; it issues the same identity-plus-timestamp
wake either way. Ocean must accept `--observed-at` on
`_ensure-agent-session-capture` and on `_finalize-agent-session`, and must
ignore a finalize whose observation predates the mapping's last-seen time
(`mapping.lastSeenAt > observedAt`) instead of writing a completion marker:
a harness exit observed at T1 whose finalize lands after a
SessionStart/sessionStart relink or a wake of the same identity observed
later than T1 describes a conversation that has since resumed, and must not
terminate it. Ocean should emit
`POLYGRAPH_ENSURE_AGENT_SESSION_CAPTURE_UNSUPPORTED` when a CLI
intentionally cannot serve the ensure command; the plugin also recognizes
the legacy Shell 0.1.x stdout response: root `Usage: polygraph`, followed by
`Validation failed for one or more options` and `Unknown argument:
_ensure-agent-session-capture`, with exit status 1 and empty stderr.
