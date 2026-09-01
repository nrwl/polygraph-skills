# Claude capture hook contract

The Claude hooks in this directory carry capture liveness only. Transcript
records remain canonical for prompts, answers, completion, and step boundaries.
Neither `UserPromptSubmit` nor `Stop` communicates a semantic boundary.

Both wake hooks call `_ensure-agent-session-capture` with the same agent
identity, working directory, transcript path, and `--source hook`. Calls are
bounded by one shared five-second deadline, repeatable, and may overlap or
arrive out of order with SessionEnd. A timed-out or ambiguously executed
command is never retried by the plugin.
An older CLI that reports `_ensure-agent-session-capture` as unsupported is
retried once through the established identity-only `_link-agent-session`
command. A wake is successful only when the preferred command or that fallback
exits successfully.

SessionEnd launches a detached Node worker. The worker owns the complete
`_finalize-agent-session` invocation and writes CLI failures to the hook log;
the short-lived hook process is not responsible for observing CLI exit.

All identity-only wake and finalize invocations preserve the hook environment
except for `POLYGRAPH_SESSION_ID` and `POLYGRAPH_CAPTURE_TOKEN`. On Windows,
Ocean may provide `POLYGRAPH_CLI_REEXEC` as a JSON argv array for a shell-free
invocation of the exact CLI build. Plugins without that hint retain the
established JavaScript-entry retry through Node, but only after a proven launch
failure.

Ocean must provide the ordering guarantee the plugin cannot impose across
Claude's asynchronous hooks: ensure/link and finalize are idempotent for an
agent session, finalize dominates an in-flight or later wake, and a wake after
finalization does not resurrect capture. Ocean should emit
`POLYGRAPH_ENSURE_AGENT_SESSION_CAPTURE_UNSUPPORTED` when a CLI intentionally
cannot serve the ensure command; the plugin also recognizes the legacy
`Unknown argument: _ensure-agent-session-capture` response.
