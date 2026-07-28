---
name: adversarial-review
description: Second-opinion code review of the work done in a Polygraph session, performed by independent reviewer agents — one per repository — running under a non-default `reviewer` role so they never disturb the implementation agents. USE WHEN user says "adversarial review", "second opinion", "review this session", "cross-check the work", "review the polygraph session", "have another agent check this", or when the Polygraph CLI launches an agent with an instruction to load this skill.
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

A second opinion on the work a Polygraph session produced. Independent reviewer agents — one per repo — read the real diff, compare it against what the session said it would do, and report concrete findings. You pick the reviewing agent, hand each reviewer its repo's plan, then consolidate.

Some Polygraph tools have both MCP and CLI equivalents — use whichever is available in your environment. See the `polygraph` skill's tool table for the full mapping and its delegation rules; this skill adds constraints, it never relaxes them.

**Reviewers are read-only.** No `reviewer*`-role agent may edit files, commit, push, or open PRs. Acting on findings is the user's explicit choice in Step 6.

Reviewers run under the non-default role `reviewer` (or `reviewer-<agent>` when the user picks several agents) so they can run beside a repo's default-role implementation agent. Their logs stay local — inspect one with `polygraph agent attach <repo> --role reviewer`, and tell the user that once when you launch them.

Invoked as `/polygraph:adversarial-review` (bare `adversarial-review` as fallback), or by `polygraph session review --adversarial`, which launches a fresh agent — deliberately not the implementer's own conversation — with the session id in its startup context. Take the session id from that startup context or the user; if there is none, say so and stop. This skill reviews an existing session, it never creates one.

## Step 1: Pick the reviewing agent

Ask which agent should review: **Claude**, **Codex**, or **OpenCode**.{% if platform == "claude" %} Use `AskUserQuestion`, multi-select enabled.{% endif %}

- **Skip the question** when the user already named one ("adversarial review with codex") or the CLI instruction did.
- Multi-select is fine: one reviewer per (repo, agent), each under its own `reviewer-<agent>` role, findings attributed separately through Step 5.

The pick becomes the `agent` parameter of `spawn_agent` — valid values are exactly `claude`, `opencode`, `codex`. If the user names anything else, say it is unsupported and ask again.

## Step 2: Session context

Call `show_session` with `details: true` for the summary/description timeline, `<repositories>` (the review's work list), and `<pullRequests>`. XML-unescape `<summary>` and `<description>`. Then call `list_artifacts` and read any plan artifacts — those are the session-level plan and the primary statement of intent you review against.

## Step 3: Per-repo plan

For each repo, assemble: PR title and description (match `<pullRequests>` on `<repoId>`), branch, base branch, and any repo-specific plan artifact.

**If a repo has neither a PR nor a plan artifact, do not skip it.** Tell its reviewer to derive intent from the diff against the base branch (the default branch if none is recorded), and flag that repo in the Step 5 summary as "intent derived from the diff". Silently dropping a repo is a failure of this skill.

## Step 4: One reviewer per repo

- **Other repos → delegate**, all launched in parallel.
- **The repo you are running in → review it yourself, locally.** Polygraph delegation is only for other repos; never delegate into your own. Produce the same summary shape so it slots into Step 5 beside the delegated ones.

Delegation goes through the delegation subagent the `polygraph` skill mandates — never call `spawn_agent` / `show_agent` from the main conversation ({% if platform == "claude" %}background `polygraph:polygraph-delegate-subagent` Tasks, `run_in_background: true`{% elsif platform == "opencode" %}`@polygraph-delegate-subagent`{% elsif platform == "codex" %}Codex `spawn_agent` with `agent_type: "polygraph-delegate-subagent"`, collected via `wait_agent`{% else %}or, with no subagent mechanism, `spawn_agent` followed by chained `show_agent` long-polls{% endif %}). Read-only inspection (`show_session`, `list_artifacts`) may be called directly. Pass `sessionId`, `repo`, the chosen `agent`, `role`, the `instruction` below, and a `context` noting the reviewer is read-only.

Wait for every reviewer to reach a terminal status before synthesizing.

### The reviewer instruction

The reviewer sees neither this skill nor the session, so state:

- **It is a REVIEWER and read-only** — no edits, commits, pushes, or PRs.
- **The session goal** and the session-level plan.
- **What this repo was supposed to do** — its PR description and plan artifact, or the derive-from-diff fallback above.
- **Branch and base branch** — review the actual code changes (`git diff <base>...<branch>`).
- **What to return**, as a compact structured summary rather than a conversational reply:
  - concrete issues, each with a `file:line`, a severity (critical / high / medium / low), and CONFIRMED (provable from the diff) or SPECULATIVE;
  - an explicit hunt for divergence from the plan — asked for but missing, done differently, or done but never asked for — reported even when the code is otherwise fine;
  - a verdict, the plan source, and anything it could not check.

## Step 5: Synthesize

Merge duplicates several reviewers found (noting the agreement — it is signal), rank by severity, and present one summary grouped by repository, worst first. Keep confirmed findings visibly separate from speculative ones; never present a guess as fact. Name every reviewer that failed, was cancelled, or timed out, and every repo whose intent came from the diff rather than a plan. Repeat the `polygraph agent attach <repo> --role reviewer` hint for anyone who wants the raw reviewer logs.

## Step 6: What next

Unless the user already said, ask which they want — more than one is fine:

- **(a) Address the feedback now.**
- **(b) Upload the summary** via `upload_artifact` with `kind: "plan"` (the findings become the plan of record) or `"file"`, under a stable `name` like `adversarial-review` so repeat runs update one artifact. That is a session-level write you make yourself, like `update_session` — not a delegation.
- **(c) Nothing** — keep the summary in the conversation and continue.

For (a), hand each repo's findings to that repo's **DEFAULT-role** agent (`spawn_agent` with `role` omitted, still via the delegation subagent). Never send a fix instruction to a `reviewer*` role and never let a reviewer apply its own findings; fix your own repo yourself. If a reviewer reports that it edited, committed, or pushed anything, treat that as a defect — say so, and tell the user to check that repo's working tree.
