---
name: session-debrief
description: Analyze the raw logs of past Polygraph sessions and produce structured, rank-ordered debriefs for use in a different session. Use when launched (typically as a background agent) with a ranked list of relevant Polygraph session IDs and a statement of the current task; pulls parent and child transcripts via the polygraph CLI and returns one consolidated debrief.
---

# Session Debrief

You produce debriefs of PAST Polygraph sessions so a parent agent working on a NEW task can decide what context is relevant. You are read-only with respect to the inspected sessions: never resume them, never spawn agents into them, never push branches, create PRs, or update their descriptions.

## Input

- A ranked list of sessions `{ sessionId, title?, url? }`, most relevant first (rank 1 = most relevant). If no explicit ranking is stated, the given order IS the ranking.
- A statement of the current task the parent is working on.

## Procedure

Speed matters: the parent agent keeps working while it waits for you, and it folds your debrief in whenever it lands.

**Single session (the usual case).** The parent normally launches one background debrief agent per related session, so your input will usually contain exactly one session. Run the "Debriefing one session" steps directly — do not spawn a subagent for a single session.

**Multiple sessions: fan out.** When given more than one session, debrief them CONCURRENTLY, never one after another: spawn one subagent per session, all in a single message so they run in parallel. Give each subagent: its session entry (sessionId, title, url, rank), the current-task statement, the "Debriefing one session" steps, and the per-session output template — copied into its prompt, since it cannot see this skill. Each subagent returns its completed debrief section as its final message. Assemble the returned sections in rank order and return them; do not rewrite them. Only if your environment cannot spawn subagents, run the "Debriefing one session" steps yourself, sequentially in rank order.

### Debriefing one session

Invoke the CLI as `${POLYGRAPH_CLI:-polygraph}` in every command: when the session was launched from a specific CLI build, `POLYGRAPH_CLI` points at it and children must use the same one. When you copy these steps into a subagent prompt, keep the `${POLYGRAPH_CLI:-polygraph}` form verbatim.

1. `${POLYGRAPH_CLI:-polygraph} session show --details <sessionId>` — metadata, description timeline, repositories, PRs, and the session's interval history (one entry per start/resume/review: who, machine, harness, time window, parent, and `selected` vs `runner-up` when the server's resume ranking is available). The description timeline often already summarizes goals and outcomes; mine it before reading transcripts. On a session with several intervals, the interval list tells you who worked in parallel and which line of work the next resume would land on — read it before the transcripts so you can attribute what you read.
2. Duplicate-work check: if the metadata shows this session pursuing the SAME task as the current one (not merely related work) and it is unfinished or recently active, do NOT read the transcripts. Return the debrief section immediately, with `**DUPLICATE WORK IN FLIGHT**` as the first line after the heading, followed by the session's status and last activity, one line of evidence for the match, and what resuming it would restore. The parent halts and asks the user to choose between resuming that session and continuing the current one, so speed matters more than depth here.
3. `${POLYGRAPH_CLI:-polygraph} session logs -s <sessionId> --all --tail none > "$TMPDIR/<sessionId>-logs.txt" 2>&1` — the parent transcript plus every child transcript, rendered as plain text, in ONE call. On multi-branch sessions the output is grouped by interval in story order: an unattributed block first (steps from before interval stamping), then one labeled beat per interval (who · harness · time window); intervals whose windows overlap are indented under a `Parallel work` header — treat those as concurrent branches, not one thread, and attribute detours to the branch whose header they sit under. An interval with no logged output still appears as its header plus `(no transcript)` — usually a review or an attempt that uploaded nothing; say so rather than guessing. Then read the file directly (with offsets for large files). Do NOT fetch `--json` and do NOT query the transcript with node/python one-liners — reading the rendered text is faster and you extract while reading. **Coverage caveat:** `session logs --all` covers default-role children only — agents spawned with a `role` keep their transcripts local to the machine that ran them (viewable there via `polygraph agent attach --role <role>`); if the session used such agents, note in the debrief that their work is not visible in these logs.
4. Write the debrief section (format below).

Large transcripts: read the file in a few large chunks, prioritizing user prompts, assistant text and final messages, tool errors and failure events, and task notifications. Routine tool-use noise (file reads, searches) is safe to skim. Do not make repeated small queries against the transcript; each round trip costs more than reading a bigger chunk.

## Output

Return ONE consolidated debrief as your final message — it is consumed by the parent agent, not shown raw to a human. Sessions in rank order, each following this template. Target a tight page per session; do not pad.

### Rank N — <session title> (<sessionId>)

**DUPLICATE WORK IN FLIGHT** — only when the duplicate-work check fired: status, last activity, one-line evidence. Omit this line otherwise.
**URL:** <session url>
**Goal:** what the session set out to do.
**What happened:** condensed narrative of the work performed.
**Outcome + artifacts:** PRs (URL + status), branches, key files touched.
**Key decisions:** one bullet per decision, with the recorded rationale.
**Gotchas / failed approaches:** what went wrong or was abandoned, and why.
**Unresolved:** open items or next steps the session left behind.
**Relevance to current task:** one or two sentences connecting this session to the stated task. The parent decides what to use — report the connection, do not overclaim.

## Constraints

- Exact citations: session URLs, PR URLs, file paths, branch names.
- If a session's logs are hidden or unavailable, say which (`hidden: true` in the CLI output means hidden by the author; empty steps mean no logs uploaded) and debrief from `session show --details` metadata, description timeline, and PRs alone.
- No speculation: when the transcript does not show why a decision was made, write "rationale not recorded".
- Read-only: the inspected sessions must be byte-for-byte unaffected by your work.
- Session data only: debrief from what the CLI and MCP tools return (metadata, description timeline, transcripts, PRs). Do NOT read repository code, run git or gh, or fetch PR diffs to verify claims — report what the session shows and leave verification to the parent.
- Fail fast: if a CLI command errors, retry it once at most, then report the error verbatim in your debrief section and move on. Do not build workarounds (no copying auth/config to a fake HOME, no POLYGRAPH_ROOT redirection, no privilege or sandbox escapes) — a debrief that says "logs unavailable: <error>" is more useful than one that arrives late.
