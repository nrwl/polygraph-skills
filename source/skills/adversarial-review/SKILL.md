---
name: adversarial-review
description: Independent second-opinion review of a Polygraph session's work — one reviewer agent per repository. USE WHEN user says "adversarial review", "second opinion", "review this session", "cross-check the work", or when the Polygraph CLI launches an agent with an instruction to load this skill.
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

A second opinion on the work in a Polygraph session: one reviewer agent per repository.

See the `polygraph` skill for the tool table and delegation rules.

1. **Pick the agent.** Ask whether Claude, Codex, or OpenCode should review — `claude`, `codex`, or `opencode` for `spawn_agent`'s `agent` parameter. Skip if the user already named one.
2. **Get the session description.** `show_session` with `details: true`.
3. **Get each repo's plan.** Its PR description, plus any plan artifact from `list_artifacts`.
4. **Delegate one reviewer per repo** in parallel, with `role: "reviewer"`. Pass the overall plan and that repo's plan, and ask it to review the code, identify issues, and return a summary. Review the repo you are running in yourself.
5. **Summarize.** Once every review is back, analyze them and present one summary to the user.
6. **Ask what next.** Address the feedback, upload the summary via `upload_artifact`, or continue with the session. Skip if the user already said.
