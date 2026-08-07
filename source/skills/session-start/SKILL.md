---
name: session-start
description: Start or reconnect a Polygraph session for shared, resumable agent context. Use when the user asks to start a Polygraph session, create session memory, share or resume work context, include related repositories, or inspect an existing session before continuing.
{% if platform == "claude" %}
allowed-tools:
  - mcp__plugin_polygraph_polygraph-mcp
{% endif %}
---

# Start a Polygraph Session

Start or reconnect a Polygraph session so the current work has shared, resumable context: session URL, repository graph visibility, linked PR/CI state, and the option to expand across repository boundaries when needed.

{% if platform == "codex" %}

## Codex Routing Rule

Use Codex `spawn_agent` with `agent_type: "polygraph-init-subagent"` for session creation or repository discovery. Do NOT call the Polygraph MCP `list_repos` or `start_session` tools directly from the parent conversation. Direct `add_repo` is allowed only when the user gives exact repository refs for an existing session.

Do NOT pass `fork_context: true` to Codex `spawn_agent` when `agent_type` is a custom agent.

{% endif %}

## Check Authentication First

Before session work, the parent conversation must check Polygraph auth with `whoami` or `polygraph whoami`.

- If auth is valid and an organization is selected, continue.
- If auth is missing, expired, or no organization is selected, stop session work. Do not keep trying session creation or discovery.
- Facilitate user reauth through the browser-based flow, such as `polygraph auth login` or the MCP `login` equivalent. After login, make sure an organization is selected with `polygraph account select` or the MCP equivalent when needed.
- Re-run `whoami` after reauth. Continue only after it confirms a valid login and selected organization.

Do not breeze past auth failures. In Codex Desktop, auth recovery usually requires the user to complete the browser login flow; surface that clearly and wait for it before continuing.

## Parent Session Detection

The parent conversation is responsible for detecting an existing Polygraph session ID from the current context, startup banner, or user-provided session URL/ID, then passing that `sessionId` explicitly to `polygraph-init-subagent` when launching it. The init subagent cannot infer the parent's current session context by itself.

For a fresh Codex Desktop conversation started with `/polygraph:session-start`, no `sessionId` is expected. Launch `polygraph-init-subagent` without `sessionId` so it creates a new session.

## Decide the Session Path

Pick one path before using tools.

1. **Existing session with repos** - If a Polygraph session ID is already in scope and the user did not ask to add repositories, pick by intent: when the user wants to continue work in that session from this conversation, join it via `resume_session` - a tracked adoption; the restored session context comes back in the tool result. When the user only wants to inspect the session, call `show_session` and print the session details - the read-only alternative. Do not create a new session.
2. **Existing session, adding exact repository refs** - If a session ID is in scope and the user provided exact refs by ID, short name, full name, GitHub `owner/repo` slug, URL-like slug, or MCP resource syntax, call `add_repo(sessionId, repoIds: [...])` directly. Do not run discovery.
3. **Existing session, discovery needed** - If a session ID is in scope but repos need to be discovered or selected, launch `polygraph-init-subagent` with the existing `sessionId` and `userContext`. The subagent must use `add_repo`, not `start_session`.
4. **No session in scope** - Launch `polygraph-init-subagent` with `userContext` and no `sessionId`. The subagent will discover related repositories when needed and call `start_session`.

Exact refs are not limited to organization repos. Public open-source repos can be added by `owner/repo` slug or URL even if they do not appear in repository discovery.

{% if platform == "codex" %}

## Launch the Init Subagent

Use this shape when discovery or new-session creation is needed:

{% raw %}

```
spawn_agent(
  agent_type: "polygraph-init-subagent",
  message: """
    Parameters:
    - sessionId: "<existing-session-id-or-omit-for-new-session>"
    - userContext: "<description of what the user wants to do>"

    The parent conversation detected any existing sessionId from current context, startup banner, or user-provided session URL/ID and passed it explicitly here. The init subagent cannot infer parent session context by itself.

    If sessionId is provided, reuse that session and use add_repo to attach repositories -- do NOT call start_session. If exact repo refs were provided, pass them directly to add_repo and do NOT call list_repos. If discovery is needed, discover candidates and select relevant repos. If sessionId is omitted, this is a fresh session-start flow; create a new session via start_session. Return a structured summary.
  """
)
```

{% endraw %}

Omit the `sessionId` line when creating a new session. Include it when attaching discovered repos to an existing session. Collect the result with `wait_agent` when the main flow needs the session before proceeding.

{% elsif platform == "claude" %}

Launch the plugin-namespaced `polygraph:polygraph-init-subagent` Task for discovery or new-session creation. Use direct `add_repo` only for exact refs on an existing session.

{% elsif platform == "opencode" %}

Invoke `@polygraph-init-subagent` for discovery or new-session creation. Use direct `add_repo` only for exact refs on an existing session.

{% else %}

If there is no subagent mechanism, use `list_repos` only when discovery is needed, then call `start_session` for a new session or `add_repo` for an existing session.

{% endif %}

## Print the Result

When a brand-new session is created, render the session welcome card. Prefer the `session_intro` MCP tool when available; otherwise run `polygraph session intro -s <sessionId>` and print the returned markdown verbatim.

For an existing or reconnected session, print:

**Session:** POLYGRAPH_SESSION_URL

**Repositories in this session:**

- REPO_FULL_NAME

Use `polygraphSessionUrl` from the session response for `POLYGRAPH_SESSION_URL`, and use repository entries from the session response for `REPO_FULL_NAME`.
