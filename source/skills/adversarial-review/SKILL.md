---
name: adversarial-review
description: Review a Polygraph session with independent per-repo reviewers and attach one consolidated review artifact.
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

1. Skip this step entirely if a reviewer agent was already named — by the user, or in the instruction that launched you (e.g. from `polygraph session review --adversarial`); in that case use that agent and do not ask. Otherwise, **pick the agent**: Ask whether Claude, Codex, or OpenCode should review — `claude`, `codex`, or `opencode` for `spawn_agent`'s `agent` parameter. If the user names a model, pass it via `spawn_agent`'s optional `model` parameter; don't ask about models.
2. **Get the session description.**
3. **Get each repo's plan.** Ask agent to provide it.
4. **Delegate one reviewer per repo** in parallel, `role: "reviewer"`. Pass plans; ask to review, identify issues, and summarize. Do the delegation even for the "initiator" repo.
5. **Summarize and attach.** Consolidate reviews into one consolidated Markdown review with per-repo sections and present it to the user. Then call `upload_artifact` once with `sessionId`, that review as `content`, `kind: "review"`, `format: "markdown"`, and name like `adversarial-review-YYYY-MM-DDTHH-mm-ssZ.md`. If upload fails, don't suppress review.
6. **Ask what next.** Address feedback or continue. Skip if already said.
7. If the user selects "address the feedback", pass each repo's feedback to the repo default agent (not the reviewer). The initiator should fix things without delegating.
