---
name: adversarial-review
description: Review a Polygraph session with independent per-repo reviewers and attach one consolidated review artifact. USE WHEN user says "adversarial review", "review this session", or when the Polygraph CLI launches an agent with an instruction to load this skill.
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

1. **Pick the agent.** Ask whether Claude, Codex, or OpenCode should review — `claude`, `codex`, or `opencode` for `spawn_agent`'s `agent` parameter. Skip if the user already named one.
2. **Get the session description.**
3. **Get each repo's plan.** Ask each repo's agent to provide the plan.
4. **Delegate one reviewer per repo** in parallel, with `role: "reviewer"`. Pass the overall plan and that repo's plan, and ask it to review the code, identify issues, and return a summary. Do the delegation even for the "initiator" repo.
5. **Summarize and attach.** Once every review is back, analyze them into one consolidated Markdown review with per-repo sections and present it to the user. Then call `upload_artifact` once with the current `sessionId`, that review as `content`, `kind: "review"`, `format: "markdown"`, and a unique current-UTC name such as `adversarial-review-YYYY-MM-DDTHH-mm-ssZ.md`. If the upload fails, report that separately without suppressing the review.
6. **Ask what next.** Address the feedback or continue with the session. Skip if the user already said.
7. If the user selects "address the feedback", pass each repo's feedback to the repo default agent (not the reviewer). The initiator should fix things itself without delegating.
