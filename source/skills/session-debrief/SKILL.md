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

1. `polygraph session show --details <sessionId>` — metadata, description timeline, repositories, PRs. The description timeline often already summarizes goals and outcomes; mine it before reading transcripts.
2. `polygraph session logs -s <sessionId> --all --json` — the parent transcript plus every child transcript in ONE call. Do not fetch the parent and child transcripts with separate commands.
3. Write the debrief section (format below).

Large transcripts: if the full `--json` output is too large to hold, page with `--tail 200 --page <n>` and prioritize, in order: user prompts, assistant text and final messages, tool errors and failure events, task notifications. Routine tool-use noise (file reads, searches) is safe to skim.

## Output

Return ONE consolidated debrief as your final message — it is consumed by the parent agent, not shown raw to a human. Sessions in rank order, each following this template. Target a tight page per session; do not pad.

### Rank N — <session title> (<sessionId>)

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
