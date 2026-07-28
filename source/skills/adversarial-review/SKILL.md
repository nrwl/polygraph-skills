---
name: adversarial-review
description: Second-opinion code review of the work done in a Polygraph session, performed by independent reviewer agents — one per repository — running under a non-default `reviewer` role so they never disturb the implementation agents. USE WHEN user says "adversarial review", "second opinion", "review this session", "cross-check the work", "review the polygraph session", "have another agent check this", or when the Polygraph CLI resumes a session with an instruction to load this skill.
{% if platform == "claude" %}
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Task
  - AskUserQuestion
  - mcp__plugin_polygraph_polygraph-mcp
{% endif %}
---

# Adversarial Review

A second-opinion review of the work a Polygraph session produced. Independent reviewer agents — one per repository in the session — read the real diff, compare it against what the session said it would do, and report concrete findings. You (the parent) pick the reviewing agent, hand each reviewer its repo's plan, then consolidate everything into one summary.

**Reviewers are read-only.** They must not edit files, commit, push, or open PRs. Acting on findings is a separate step that the user has to choose (Step 6).

Some Polygraph tools have both MCP and CLI equivalents — use whichever is available in your environment. See the `polygraph` skill's tool table for the full mapping, and follow every delegation rule it states; this skill adds constraints, it never relaxes them.

## Invocation

- The user types `/polygraph:adversarial-review` (fall back to the bare `adversarial-review` if the plugin-namespaced form is not found).
- The Polygraph CLI runs `polygraph session review --adversarial`, which resumes the session and hands this agent an instruction naming this skill.

Both entry points run the same procedure. Resolve the session ID from the resumed session, the startup banner, or the user. If Polygraph auth is missing or no organization is selected, stop and follow the `polygraph` skill's Setup section instead of guessing. If there is no session at all, say so and stop — this skill reviews an existing session; it does not create one.

## The reviewer role

Reviewers run under a **non-default role** so they can work in a repo at the same time as that repo's default-role implementation agent. Each (repo, role) pair hosts at most one active child agent.

- Default role → `reviewer`. When the user picks more than one reviewing agent, use one role per agent: `reviewer-claude`, `reviewer-codex`, `reviewer-opencode`.
- **Non-default-role agents do NOT upload their logs to the cloud.** They will not appear in `polygraph session logs`. Inspect a reviewer locally with:

  ```sh
  polygraph agent attach <repo> --role reviewer
  ```

  Tell the user this once, when you launch the reviewers, so they know where to watch.
- Never spawn a reviewer under the default role — that would collide with the implementation agent in that repo.
- If a (repo, role) already has an active reviewer from an earlier review, a new `spawn_agent` for that pair is delivered to it as a follow-up rather than starting a second run. That is usually what you want. Use `stop_agent` with the same `role` first if you need a clean run.

## Step 1: Pick the reviewing agent

Ask the user which agent implementation should perform the review: **Claude**, **Codex**, or **OpenCode**.

- **Skip the question** if the user already named one when invoking the skill (e.g. "adversarial review with codex", "second opinion using opencode"), or if the CLI instruction named one.
- Multi-select is fine. If the user picks more than one, spawn one reviewer per (repo, agent) pair using the distinct roles listed above, and keep their findings separately attributed through Step 5.
{% if platform == "claude" %}
- Use `AskUserQuestion` for the pick, with one option per agent and multi-select enabled.
{% endif %}

The choice is passed as the `agent` parameter of `spawn_agent`. Valid values are `claude`, `opencode`, and `codex` — lowercase, exactly these three. Never invent another value; if the user names an agent outside this set, say it is not supported and ask again.

## Step 2: Get the high-level session context

1. Call `show_session` with `details: true` (CLI: `polygraph session show --details <session-id>`). Read:
   - `<summary>` / the description timeline — the session's stated goal and progress.
   - `<repositories>` — every repo `<id>` and `<name>`. This is the review's work list.
   - `<pullRequests>` — `<url>`, `<repoId>`, `<repoName>`, branch, base branch, title, `<description>`.

   XML-unescape the text inside `<summary>` and `<description>` before using it.
2. Call `list_artifacts` for the session and read any attached **plan** artifacts. These are the session-level plan and are the primary statement of intent you review against. If `list_artifacts` is unavailable in your environment, note that and continue with the session description and PR descriptions alone.

## Step 3: Assemble the per-repository plan

For each repo in `<repositories>`, build the record the reviewer needs:

| Field | Source |
| --- | --- |
| repo full name | `<repositories>` entry |
| repo ID | `<repositories>` entry `<id>` |
| PR title + description | the `<pullRequests>` entry whose `<repoId>` matches |
| branch | that PR's branch |
| base branch | that PR's base branch |
| repo-specific plan | any plan artifact scoped to (or naming) this repo |

**Fallback when a repo has neither a PR nor a plan artifact:** do NOT skip the repo. Ask its reviewer to derive intent from the diff against the base branch (default branch if no base branch is recorded), and explicitly mark that repo as "intent derived from the diff, not from a stated plan" in the Step 5 summary. Silently dropping a repo is a failure of this skill.

## Step 4: Delegate one reviewer per repo

Review **every** repository in the session.

- **Other repos → delegate.** One reviewer child agent per (repo, agent), all launched in parallel.
- **The repo you are running in → review it yourself, directly.** Polygraph delegation is only for other repos; never delegate into your own. Do the diff reading locally{% if platform == "claude" %} — a regular (non-Polygraph) `Task` subagent is fine and keeps the diff out of your main context{% endif %}, apply the same read-only rule, and produce the same structured summary so it slots into Step 5 alongside the delegated ones.

{% if platform == "claude" %}
**CRITICAL:** `spawn_agent` and `show_agent` MUST ALWAYS be called via background `polygraph-delegate-subagent` Tasks (`run_in_background: true`), NEVER directly from the main conversation. Direct calls flood the context window with polling noise. This is a hard requirement inherited from the `polygraph` skill, not a suggestion. Read-only session inspection (`show_session`, `list_artifacts`) may be called directly.

Launch one background Task per (repo, agent), all in a single message so they run in parallel:

{% raw %}

```
Task(
  subagent_type: "polygraph:polygraph-delegate-subagent",
  run_in_background: true,
  description: "Review <repo-name>",
  prompt: """
    Parameters:
    - sessionId: "<session-id>"
    - repo: "<org/repo-name>"
    - agent: "<claude | codex | opencode>"
    - role: "reviewer"
    - instruction: "<the reviewer instruction below>"
    - context: "Adversarial review of a Polygraph session. The reviewer is read-only."

    Delegate the work, poll for completion, and return a structured summary.
  """
)
```

{% endraw %}

Fall back to the bare `polygraph-delegate-subagent` only if the plugin-namespaced form is not found.
{% elsif platform == "opencode" %}
**CRITICAL:** `spawn_agent` and `show_agent` MUST ALWAYS be called via `@polygraph-delegate-subagent`, NEVER directly from the main conversation. Direct calls flood the context window with polling noise. This is a hard requirement inherited from the `polygraph` skill, not a suggestion. Read-only session inspection (`show_session`, `list_artifacts`) may be called directly.

Invoke `@polygraph-delegate-subagent` once per (repo, agent) — all invocations launched together so they run in parallel — passing `sessionId`, `repo`, `agent`, `role: "reviewer"`, the reviewer `instruction` below, and a short `context` noting this is a read-only adversarial review.
{% elsif platform == "codex" %}
**CRITICAL:** The Polygraph MCP `spawn_agent` and `show_agent` calls MUST run inside the custom Codex `polygraph-delegate-subagent`, not directly in the main conversation. Codex `spawn_agent` launches that local subagent; the Polygraph MCP `spawn_agent` starts the reviewer in another repository. Read-only session inspection (`show_session`, `list_artifacts`) may be called directly from the parent.

Launch one `polygraph-delegate-subagent` per (repo, agent) before waiting on any of them, then collect results with `wait_agent`:

{% raw %}

```
spawn_agent(
  agent_type: "polygraph-delegate-subagent",
  message: """
    Parameters:
    - sessionId: "<session-id>"
    - repo: "<org/repo-name>"
    - agent: "<claude | codex | opencode>"
    - role: "reviewer"
    - instruction: "<the reviewer instruction below>"
    - context: "Adversarial review of a Polygraph session. The reviewer is read-only."

    Call the Polygraph MCP spawn_agent for the repo, then poll show_agent via chained waitForTransitionMs long-poll calls until terminal. Return a structured summary with repo, role, status, and result text.
  """
)
```

{% endraw %}

Do NOT pass `fork_context: true` when `agent_type` is a custom agent — Codex rejects it.
{% else %}
Call `spawn_agent` once per (repo, agent) with `sessionId`, `repo`, `agent`, `role`, `instruction`, and `context`. The calls return immediately, so issue them all before polling. Then poll `show_agent` per repo (pass the same `role`) via chained `waitForTransitionMs` long-poll calls until each reaches a terminal status.
{% endif %}

### The reviewer instruction

Every reviewer's `instruction` MUST contain all of the following. Fill the placeholders from Steps 2 and 3 — the reviewer cannot see this skill or the session.

```
You are a REVIEWER performing an adversarial second-opinion review. You are READ-ONLY:
do NOT edit files, do NOT commit, do NOT push, do NOT open or update PRs, do NOT run
formatters or codemods. Inspect and report only.

Session goal:
<session summary / goal, plus the session-level plan artifact>

What this repo was supposed to do:
<PR title + description, and the repo-specific plan artifact>
<or, when neither exists: "No PR or plan artifact exists for this repo. Derive the
intended change from the diff itself and say so explicitly in your summary.">

Branch: <branch>
Base branch: <base branch>

Review the actual code changes on <branch> against <base branch> (e.g.
`git diff <base branch>...<branch>`; fetch history first if git reports a missing object).

Your job:
1. Review the actual code changes — read the diff and the surrounding code, not just the
   commit messages.
2. Identify concrete issues. Every finding needs a `file:line` reference and a severity of
   critical, high, medium, or low.
3. Explicitly hunt for divergence from the stated plan: things the plan asked for that are
   missing, things done differently than described, and things done that the plan never
   mentioned. Report divergence even when the code is otherwise fine.
4. Mark each finding as CONFIRMED (you can point at the exact lines in the diff that prove
   it) or SPECULATIVE (it depends on context you could not verify).

Return a compact structured summary, not a conversational reply, in exactly this shape:

## Review: <org/repo>
**Verdict:** <ship | ship with fixes | do not ship>
**Plan source:** <PR description | plan artifact | derived from diff>
**Diff reviewed:** <base branch>...<branch> (<N> files)

### Divergence from plan
- <one bullet per divergence, or "none found">

### Findings
- [critical|high|medium|low] [CONFIRMED|SPECULATIVE] path/to/file.ts:42 — <the issue in one
  sentence> — <why it is wrong / what breaks> — <suggested fix>

### Not reviewed
- <anything you could not check, and why>

If you find nothing, say so explicitly rather than padding the list.
```

### Waiting for reviewers

Every reviewer must reach a **terminal status** (`completed`, `failed`, or `cancelled`) before you synthesize. Do not summarize from partial output. If a reviewer pauses on `input-required`, surface its question to the user verbatim and route the answer back with the same `repo` **and the same `role`**.

## Step 5: Synthesize

Once every reviewer is terminal, read the results and produce ONE consolidated summary:

1. **Deduplicate.** When several reviewers (multiple agents on the same repo, or two repos reporting the same cross-repo issue) raise the same finding, merge it into one entry and note which reviewers found it — agreement is itself signal.
2. **Rank by severity** (critical → high → medium → low) within each repository.
3. **Group by repository**, most severe repo first.
4. **Separate confirmed from speculative.** Be explicit about which findings a reviewer backed with diff evidence and which are guesses about context it could not verify. Never present a speculative finding as fact.
5. **Report the gaps.** Name every reviewer that failed, was cancelled, or timed out, and every repo whose intent had to be derived from the diff (Step 3 fallback). Do not quietly drop them.

Present it like this:

```
# Adversarial review — <session title>

**Reviewed by:** <agent(s)> · **Repos:** <n> · **Findings:** <n> (<n> critical, <n> high, …)

## <org/repo-a> — <verdict>
Plan source: <…>

**Divergence from plan**
- <…>

**Findings**
1. [critical · CONFIRMED] `src/auth.ts:88` — <issue> — <impact> — <suggested fix>
2. [medium · SPECULATIVE] `src/db.ts:14` — <issue> — <impact> — <suggested fix>

## <org/repo-b> — <verdict>
…

## Reviewer coverage
- <org/repo-c>: reviewer failed (<reason>) — not reviewed
- <org/repo-d>: no PR or plan artifact; intent derived from the diff
```

Also remind the user here that reviewer logs are local only, with the `polygraph agent attach <repo> --role reviewer` command.

## Step 6: Ask what to do next

Unless the user already said what they want, ask. More than one option can be picked:

- **(a) Address the feedback now** — turn the findings into fixes.
- **(b) Upload the summary as a session artifact** — call `upload_artifact` for the session with `kind: "plan"` (when the findings become the plan of record for follow-up work) or `kind: "file"` (a plain record), and a stable `name` such as `adversarial-review` so repeat runs update the same artifact instead of littering the session. This is a session-level write the parent makes itself, like `update_session` — it is not a delegation.
- **(c) Do nothing** — keep the summary in the conversation and continue with the session.

{% if platform == "claude" %}
Use `AskUserQuestion` with multi-select for this.
{% endif %}

**If they pick (a):** hand each repo's relevant findings to that repo's **DEFAULT-role** agent — `spawn_agent` with the `role` omitted, still routed through the delegation subagent the `polygraph` skill requires. The reviewer role stays read-only for the whole lifetime of the review: never send a fix instruction to a `reviewer*` role, and never let a reviewer apply its own findings. Fix your own repo's findings yourself, in your own working directory.

## Notes

- Reviewers are read-only. If a reviewer reports that it edited, committed, or pushed anything, treat that as a defect: say so in the summary and tell the user to check that repo's working tree.
- Reviewer roles are non-default, so their transcripts stay on the machine that ran them and never reach `polygraph session logs`. `polygraph agent attach <repo> --role reviewer` is the only way to watch one live.
- This skill never pushes branches, creates PRs, or marks PRs ready. `upload_artifact` in Step 6b is the only write it performs, and only when the user asks for it.
- One active agent per (repo, role) — that is what lets a reviewer run beside an implementation agent in the same repo. Keep the roles distinct and never reuse the default role for a reviewer.
- A review is not a resume-and-continue. Reading a session for review does not authorize changing it; changes need the explicit user choice in Step 6.
