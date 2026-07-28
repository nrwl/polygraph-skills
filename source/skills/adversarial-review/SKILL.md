---
name: adversarial-review
description: Independent second-opinion review of a Polygraph session's work — one reviewer agent per repo, under a read-only `reviewer` role. USE WHEN user says "adversarial review", "second opinion", "review this session", "cross-check the work", "review the polygraph session", or when the Polygraph CLI launches an agent with an instruction to load this skill.
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

One reviewer agent per repo diffs what the session actually changed against what it said it would do.

See the `polygraph` skill for the tool table and delegation rules; this skill adds constraints, never relaxes them.

**Reviewers are read-only** — no `reviewer*` role may edit, commit, push, or open PRs.

Reviewers take the non-default role `reviewer` (or `reviewer-<agent>` for several agents) so they run beside a repo's implementation agent. Their logs stay local: `polygraph agent attach <repo> --role reviewer`.

Invoked as `/polygraph:adversarial-review` (bare `adversarial-review` as fallback), or by `polygraph session review --adversarial`, which launches a fresh agent with the session id in its startup context. Take the session id from there or from the user; stop if there is none.

## Step 1: Pick the reviewing agent

Ask which agent reviews — `claude`, `opencode`, or `codex`, the only valid values for `spawn_agent`'s `agent` parameter.{% if platform == "claude" %} Use `AskUserQuestion`, multi-select.{% endif %} Skip the question if the user or the CLI instruction already named one. Several picks means one reviewer per (repo, agent), each under its own `reviewer-<agent>` role.

## Step 2: Session context

`show_session` with `details: true` for the summary, `<repositories>`, and `<pullRequests>`; then `list_artifacts` for the session-level plan.

## Step 3: Per-repo plan

Per repo, collect its PR title and description, branch, base branch, and any repo-specific plan artifact. A repo with neither PR nor plan artifact is still reviewed — tell its reviewer to derive intent from the diff, and flag it in Step 5.

## Step 4: One reviewer per repo

Delegate other repos in parallel; review the repo you are running in yourself, since delegation is only for other repos.

Delegate through the subagent the `polygraph` skill mandates — never call `spawn_agent` / `show_agent` from the main conversation ({% if platform == "claude" %}background `polygraph:polygraph-delegate-subagent` Tasks, `run_in_background: true`{% elsif platform == "opencode" %}`@polygraph-delegate-subagent`{% elsif platform == "codex" %}Codex `spawn_agent` with `agent_type: "polygraph-delegate-subagent"`, collected via `wait_agent`{% else %}`spawn_agent` plus chained `show_agent` long-polls{% endif %}). `show_session` and `list_artifacts` may be called directly. Wait for every reviewer to reach a terminal status.

Tell each reviewer:

- it is a read-only reviewer — no edits, commits, pushes, or PRs;
- the session goal and plan;
- what this repo was meant to do, or to derive that from the diff;
- the branch and base branch to diff;
- to report concrete issues with `file:line` and a severity, each marked confirmed or speculative;
- to hunt explicitly for divergence from the plan — missing, done differently, or never asked for;
- to answer compactly and structurally, not conversationally.

## Step 5: Synthesize

Merge duplicate findings, group by repo worst-first, and keep confirmed findings separate from speculative ones. Name every reviewer that failed or was cancelled, and every repo reviewed without a plan.

## Step 6: What next

Unless the user already said, ask which they want — more than one is fine: address the findings now, upload the summary via `upload_artifact` (`kind: "plan"` or `"file"`, stable `name` like `adversarial-review`), or nothing.

To address findings, send each repo's to its DEFAULT-role agent — `spawn_agent` with `role` omitted, still via the delegation subagent — and fix your own repo yourself. Never send fixes to a `reviewer*` role.
