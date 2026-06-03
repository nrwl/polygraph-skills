---
name: polygraph
description: Guidance for coordinating changes across multiple repositories using Polygraph. Use when working on a feature that affects another repository, coordinating changes/branches/PRs across repos, delegating tasks to child agents in different repos, discovering how code is consumed across repositories, or starting a multi-repo coordination session. TRIGGER when user mentions "polygraph", "other repos", "other repositories", "who uses this", "what uses this", "cross-repo", "multi-repo", "consuming this API/endpoint", "dependent repositories", or asks about what other repos are doing with shared code/APIs/endpoints.
{% if platform == "claude" %}
allowed-tools:
  - mcp__plugin_polygraph_polygraph-mcp
{% endif %}
---

{% assign has_subagents = false %}
{% if platform == "claude" or platform == "opencode" or platform == "codex" %}
{% assign has_subagents = true %}
{% endif %}

# Multi-Repo Coordination with Polygraph

{% if platform == "codex" %}
**IMPORTANT:** NEVER `cd` into cloned repositories or access their files directly. ALWAYS use Codex Polygraph subagents to invoke the Polygraph MCP `spawn_agent` tool for work in other repositories.

## Critical Routing Rule (Codex Parent Conversation)

Read this before the tool table below — it determines which tools are yours to call directly.

- Codex `spawn_agent` ≠ Polygraph MCP `spawn_agent`. Codex `spawn_agent` launches the local custom subagents (`polygraph-init-subagent`, `polygraph-delegate-subagent`). The Polygraph MCP `spawn_agent` runs work inside another repository and must only be invoked from inside those subagents.
- **For new sessions:** call Codex `spawn_agent` with `agent_type: "polygraph-init-subagent"`. Do NOT call Polygraph MCP `list_repos` or `start_session` directly from this conversation.
- **For explicit repo additions to an existing session:** if the user gives exact refs by ID, short name, full name, GitHub `owner/repo` slug, or URL-like slug, call Polygraph MCP `add_repo` directly with those refs. Do NOT call `list_repos` or launch candidate discovery first.
- **For repo work:** call Codex `spawn_agent` with `agent_type: "polygraph-delegate-subagent"`. Do NOT call Polygraph MCP `spawn_agent` or `show_agent` directly from this conversation; collect results with `wait_agent` when needed.
- **Allowed direct Polygraph MCP calls from the parent:** `whoami`, `login`, `list_accounts`, `select_account`, `show_session` for read-only inspection of an existing session, `update_session_description` for session metadata updates, `link_reference` for linking external references to sessions, and `add_repo` only for explicit repo additions to an existing session.
- Do NOT pass `fork_context: true` to Codex `spawn_agent` when `agent_type` is a custom agent — Codex rejects it.
{% else %}
**IMPORTANT:** NEVER `cd` into cloned repositories or access their files directly. ALWAYS use the `spawn_agent` tool to perform work in other repositories.
{% endif %}

This skill provides guidance for working on features that span multiple repositories using Polygraph for coordination.

## Available Tools

Polygraph functionality is available via both MCP tools and CLI commands. Use whichever is available in your current environment.

| MCP Tool | CLI Equivalent | Description |
| --- | --- | --- |
| `list_repos` | `polygraph repo list` | Discover candidate repositories with descriptions and graph relationships |
| `start_session` | `polygraph session start --repo <ids>` | Initialize a Polygraph session with selected repositories |
| `spawn_agent` | — | Start a new child task or send an explicit follow-up to an active task in another repository. Input: `{ sessionId, repo, instruction, context?, taskId? }`. Output: `{ taskId, message, status: 'delegated' }`. Pass the `taskId` returned by a prior call to route a follow-up message to a specific active task; omit to start a new child run. A session resume or reconstruction is read-only context restoration; after resuming, do not use `spawn_agent` to continue changes unless the user explicitly asks for changes. |
| `show_agent` | — | Poll flat per-child status for the session. Output: `{ children: PolygraphChildStatusItem[] }` where each item exposes `repositoryId`, `repoFullName`, `status`, `lastOutputLines`, `durationMs`, `instruction`, `agentType?`, `inputRequiredQuestion?`. `status` is an AcpRunStatus: `'created' \| 'in-progress' \| 'input-required' \| 'completed' \| 'failed' \| 'cancelled'` (British double-L on `'cancelled'`). `inputRequiredQuestion` is populated only when `status === 'input-required'`. |
| `stop_agent` | — | Cancel an in-progress child. Output: `{ taskId, state: 'cancelled', sessionPreserved: true, output, message }`. Because `sessionPreserved: true`, the preserved agent session can be restored later for context, but resume must wait for explicit user instructions before making changes. |
| `push_branch` | — | Push a local git branch to the remote repository. Requires a session description. |
| `create_pr` | — | Create draft PRs with session metadata linking related PRs |
| `show_session` | `polygraph session show <id> [--details]` | Query status of the current session. Use details when session summary, repo IDs, PR URLs, and PR descriptions are needed. |
| `update_session_description` | `polygraph session update-description` | Set the current session description from a synthesized progress summary or user-provided text. This updates session metadata only; it does not require PR creation or mark-ready. |
| `link_reference` | — | Link an external reference to a session. |
| `mark_pr_ready` | — | Mark draft PRs as ready for review |
| `associate_pr` | — | Associate an existing PR with a session |
| `add_repo` | — | Add repositories to a running Polygraph session. For explicit refs, pass the refs directly and skip `list_repos`. |
| `complete_session` | `polygraph session archive <id>` | Mark a session complete |
| `get_ci_logs` | — | Retrieve full plain-text log for a specific CI job |
| — | `polygraph auth login [--token]` | Authenticate with Polygraph (use `--token` for headless/CI) |
| — | `polygraph session list` | List all sessions |
| — | `polygraph account list` / `polygraph account select` | Organization management |
| — | `polygraph whoami` | Show current auth status and org |

{% if platform == "claude" or platform == "opencode" %}

**Delegation rules:** `list_repos` and `start_session` MUST be called via the `polygraph-init-subagent` as described in step 0. Direct `add_repo` is allowed only when the user provides exact repo refs for an existing session. `spawn_agent` and `show_agent` MUST ALWAYS be called via background Task subagents (`run_in_background: true`) as described in the delegation sections below — NEVER call them directly in the main conversation.
{% elsif platform == "codex" %}

**Routing reminder:** Per the Critical Routing Rule above, the parent conversation must use Codex `spawn_agent` with `agent_type: "polygraph-init-subagent"` for new sessions and `agent_type: "polygraph-delegate-subagent"` for repo work — not the Polygraph MCP tools shown in the table. `wait_agent` collects results when needed.
{% endif %}

## CLI Statefulness

The Polygraph CLI (`polygraph`) is **stateful**. When you select an organization — via `polygraph account select` or the equivalent MCP tool — that selection is saved globally and all subsequent CLI commands and MCP tool calls operate against it. You do not need to pass the org on every command.

## Setup

Before using Polygraph tools, ensure the CLI is authenticated and an organization is selected.

### Check Authentication

Use `polygraph whoami` (or the `whoami` MCP tool) to check if the user is currently logged in and which organization is active.

- If the user **is logged in** and an org is selected → proceed to the workflow.
- If the user **is not logged in** → use `polygraph auth login` (or the `login` MCP tool) to authenticate. After login, an organization must be selected.

### Select Organization

After logging in (or if logged in but no org is selected), use `polygraph account select` (or the equivalent MCP tool) to choose the organization that future commands will run against.

## Workflow Overview

{% if has_subagents %}

0. **Initialize or join Polygraph session** - If you were spawned inside an existing session (the startup banner names a session ID), reuse it. Call `show_session` first; if it already has repos and the user did not ask to add more, you're done. If the user asks to add exact repo refs, call `add_repo` directly with those refs and skip candidate discovery. If the session has no repos and no exact refs were provided, launch the `polygraph-init-subagent` with that `sessionId` so it discovers candidates and uses `add_repo` (NOT `start_session`). Only when there is no session ID at all should the init subagent create a new session.
1. **Delegate work to each repo** - Use the `polygraph-delegate-subagent` to start child agents in other repositories. Choose the Simple (fire-and-forget) or Multi-turn (interactive) pattern described below based on whether the child may need clarification.
   {% else %}
2. **Initialize or join Polygraph session** - If you already have a session ID, call `show_session` to fetch details. If the user asks to add exact repo refs, call `add_repo` directly with those refs and skip candidate discovery. Otherwise, discover candidate repos, select relevant repositories, and create a new session via `list_repos` and `start_session`.
3. **Delegate work to each repo** - Use `spawn_agent` to start child agents in other repositories (returns immediately). Choose the Simple (fire-and-forget) or Multi-turn (interactive) pattern described below.
   {% endif %}
4. **Monitor child agents** - Use `show_agent` to poll progress and read the flat `children[]` array for each child's `status` and `lastOutputLines`.
5. **Stop child agents** (if needed) - Use `stop_agent` to cancel an in-progress child agent. The underlying agent session is preserved for later read-only context restoration; after a resume, wait for explicit user instructions before making changes.
6. **Push branches** - Use `push_branch` after making commits. A required `description` must follow the Session Description Policy.
7. **Update session description** - Use `update_session_description` to update the session description; must follow the Session Description Policy. Independent of PR creation or mark-ready.
8. **Create draft PRs** - Use `create_pr` to create linked draft PRs. Always pass `description` following the Session Description Policy.
9. **Associate existing PRs** (optional) - Use `associate_pr` to link PRs created outside Polygraph.
10. **Query PR status** - Use `show_session` to check progress.
11. **Mark PRs ready** - Use `mark_pr_ready` when work is complete.
12. **Complete session** - Use `complete_session` to mark the session as completed when the user requests it.

## Step-by-Step Guide

### 0. Initialize or Join Polygraph Session

There are three cases. Pick exactly one before calling any tool.

**Hard rule: if a session ID is already in scope (e.g., the startup banner says "You're in Polygraph session …", or the user passed one), that session ID is authoritative for this entire conversation. NEVER call `start_session` — doing so creates a brand-new session and orphans the one the parent harness is pointed at. Reuse the existing session via `show_session` and, if needed, `add_repo`.**

**Case A — Existing session, already has repos.** Call `show_session` directly with the known session ID. Skip the init subagent entirely. Print the session details (format below) and proceed.

**Case B — Existing session, no repos yet (or user wants to add more).** If the user gives exact repo refs by ID, short name, full name, GitHub `owner/repo` slug, or URL-like slug, call `add_repo(sessionId, repoIds: [...])` directly with those refs. Do NOT call `list_repos`, do NOT ask for candidates, and do NOT launch the init subagent just to resolve those refs. If the user wants discovery/filtering instead, launch the `polygraph-init-subagent`, passing both the existing `sessionId` and `userContext`. The subagent will discover candidates, select relevant repositories, and call `add_repo` against the existing session — it will NOT call `start_session`.

**Case C — No session at all.** Launch the `polygraph-init-subagent` with only `userContext` (no `sessionId`). The subagent will discover candidates and call `start_session` to create a new session.

{% if has_subagents %}

In case B, call `add_repo` yourself when exact repo refs were provided; otherwise the subagent handles discovery and attachment. In case C the subagent handles session creation. In case A you call `show_session` yourself.
{% else %}

In case B, direct exact repo refs go straight to `add_repo`; use `list_repos` only when discovery/filtering is needed. In case C, discover candidate repos using `list_repos`, select relevant repositories, and call `start_session`. In case A, just call `show_session`.
{% endif %}

**Session ID handling:**

- For a new session (case C), `start_session` auto-generates a unique session ID. You do NOT need to pass one.
- For cases A and B, the session ID already exists; reuse it everywhere — never let `start_session` run in this conversation.
{% if platform == "claude" %}

**Launch the init subagent** (cases B and C — skip in case A):

{% raw %}

```
Task(
  subagent_type: "polygraph-init-subagent",
  description: "Init Polygraph session",
  prompt: """
    Parameters:
    - sessionId: "<existing-session-id-or-omit-for-new-session>"
    - userContext: "<description of what the user wants to do>"

    If sessionId is provided, reuse that session and use add_repo to attach repositories — do NOT call start_session. If exact repo refs were provided, pass them directly to add_repo and do NOT call list_repos. If discovery is needed, discover candidates and select relevant repos. If sessionId is omitted, create a new session via start_session. Return a structured summary.
  """
)
```

{% endraw %}

Omit the `sessionId` line for case C. Include it (with the existing session ID) for case B.
{% elsif platform == "opencode" %}

**Launch the init subagent** using `@polygraph-init-subagent` (cases B and C — skip in case A):

Invoke the `polygraph-init-subagent` agent when discovery is needed. Always pass `userContext`. If you are in case B (existing session with no repos) and no exact repo refs were provided, also pass the existing `sessionId` and instruct the subagent to use `add_repo` rather than `start_session`. The subagent returns a structured summary.
{% elsif platform == "codex" %}

**Launch `polygraph-init-subagent`** (cases B and C — skip in case A):

Use Codex's `spawn_agent` tool to start the custom Polygraph init subagent:

{% raw %}

```
spawn_agent(
  agent_type: "polygraph-init-subagent",
  message: """
    Parameters:
    - sessionId: "<existing-session-id-or-omit-for-new-session>"
    - userContext: "<description of what the user wants to do>"

    If sessionId is provided, reuse that session and use add_repo to attach repositories — do NOT call start_session. If exact repo refs were provided, pass them directly to add_repo and do NOT call list_repos. If discovery is needed, discover candidates and select relevant repos. If sessionId is omitted, create a new session via start_session. Return a structured summary.
  """
)
```

{% endraw %}

Omit the `sessionId` line for case C. Include it (with the existing session ID) for case B. When the main flow needs the session before proceeding, collect the result with `wait_agent`.
{% else %}

If an existing `sessionId` is in scope and the user provided exact repo refs, call `add_repo` directly with those refs. Otherwise call `list_repos` to discover available repositories, select relevant repos based on user context, then call `start_session` with the selected repository IDs.
{% endif %}

The subagent will:

1. Use exact repo refs directly when provided for an existing session; otherwise call `list_repos` to discover available repositories
2. Select relevant repos based on the user context (or include all if uncertain)
3. Either call `start_session` (case C, no `sessionId`) or call `add_repo` against the existing session (case B). It will never call `start_session` when a `sessionId` was provided.
4. Call `show_session` to retrieve session details
5. Return a summary with session URL and repo info

**Case C only — new session just created:** After the init subagent completes and creates the new session, render the session welcome card (skip the session-details block below for this case). Prefer the `session_intro` MCP tool — call it with the session ID; it returns the card as markdown. If that tool is unavailable, run `polygraph session intro -s <sessionId>` via the CLI instead. Either way, print the result to the user verbatim as markdown — do NOT wrap it in a code block or reformat it (the logo is pre-fenced; the rest is live markdown). It needs no other input, and you do not need to call `show_session` first. Then continue (ask the user what they want, or start the requested task).

**After receiving the subagent's summary (Case B) or after calling `show_session` for an existing session (Case A), print the session details:**

**Session:** POLYGRAPH_SESSION_URL

**Repositories in this session:**

- REPO_FULL_NAME

- REPO_FULL_NAME: from the session repository entries
- POLYGRAPH_SESSION_URL: from `polygraphSessionUrl`

### Explore an Existing Session

Use this workflow when the user gives a Polygraph session ID and asks to understand, resume, inspect, or investigate prior work.

**Resume is not a work command.** If the user's intent is to resume, reconnect, or reconstruct a prior Polygraph session, fetch and summarize the restored context, then stop. Do not edit files, push branches, add repos, delegate new work, or continue previous changes until the user explicitly asks for changes. Treat "resume" as context restoration followed by waiting for user instructions.

1. Fetch detailed session context:
   - Prefer `show_session` with `details: true` when the MCP tool exposes that option.
   - Otherwise run `polygraph session show --details <session-id>`.
2. Treat the detailed output as authoritative context. It should include:
   - `<summary>` — the session summary.
   - `<repositories>` — relevant repos, including each repo's `<id>` and `<name>`.
   - `<pullRequests>` — relevant PRs, including `<url>`, `<repoId>`, `<repoName>`, branch metadata, and `<description>`.
3. Parse the XML-style blocks and XML-unescape text inside `<summary>` and `<description>`.
4. Build a repo/PR map:
   - repo id
   - repo full name
   - PR URL
   - branch
   - base branch
   - title
   - status
   - PR description
5. If the request was resume/reconnect/reconstruct only, report the restored session context and wait for the user's next instruction.
6. If the user explicitly asked to inspect or investigate prior work, use the PR descriptions and session summary to decide whether more repo investigation is needed.
7. If the repo to investigate is already part of the session, delegate directly to that repo.
8. If the repo to investigate is not currently initialized in the session, and either the user provided an exact repo ref or the repo appears in `<repositories>`, call `add_repo` with that ref or repo `<id>` directly. Do not call `list_repos` just to resolve the repo.
9. After `add_repo`, call `show_session` again to verify the repo was added, then delegate to that repo.
10. Fall back to `list_repos` only when the desired repo is not an exact ref and is missing from `<repositories>`, or when the details output came from an older Polygraph version that did not include repo IDs.

When delegating investigation from a PR, include the PR context in the child instruction:

```
Session: <session-id>
Repo: <repoName>
Repo ID: <repoId>
PR: <url>
Branch: <branch>
Base branch: <baseBranch>
Description:
<description>

Inspect the PR commits/diff and investigate the requested behavior. Report findings with file paths and concrete evidence.
```

## Simple tasks (fire-and-forget)

Use this pattern when the task is well-defined and the child is not expected to need clarification. It is a single-round delegation: kick it off, poll until terminal, then push branch + create PR.

{% if platform == "claude" %}

**CRITICAL:** `spawn_agent` and `show_agent` MUST ALWAYS be called via background Task subagents (`run_in_background: true`), NEVER directly from the main conversation. Direct calls flood the context window with polling noise and degrade the user experience. This is a hard requirement, not a suggestion.

1. Launch a background `Task` subagent per repo using `polygraph-delegate-subagent`. The subagent calls `spawn_agent`, then polls `show_agent` on backoff until terminal.

{% raw %}

```
Task(
  subagent_type: "polygraph-delegate-subagent",
  run_in_background: true,
  description: "Delegate to <repo-name>",
  prompt: """
    Parameters:
    - sessionId: "<session-id>"
    - repo: "<org/repo-name>"
    - instruction: "<the task instruction>"
    - context: "<optional context>"

    Delegate the work, poll for completion, and return a structured summary.
  """
)
```

{% endraw %}

2. Delegate to multiple repos in parallel by launching multiple background Task subagents at the same time. Read the output files later to check progress.
3. For each child, the subagent watches `child.status` in the flat `children[]` response and exits when it sees a terminal status — typically `'completed'` or `'failed'` (and `'cancelled'` if it was stopped).
4. Once all background subagents report a terminal status, continue to `push_branch` + `create_pr`.

In rare cases where you need to check the raw child agent status directly (e.g., debugging a stuck subagent), you may call `show_agent` as a one-off tool call. Do NOT use this for regular polling — that MUST happen in background subagents.

{% elsif platform == "opencode" %}

**CRITICAL:** `spawn_agent` and `show_agent` MUST ALWAYS be called via `@polygraph-delegate-subagent`, NEVER directly from the main conversation. Direct calls flood the context window with polling noise and degrade the user experience. This is a hard requirement, not a suggestion.

1. For each repo, invoke `@polygraph-delegate-subagent` with `sessionId`, `repo`, `instruction`, and optional `context`. The subagent calls `spawn_agent`, then polls `show_agent` on backoff until terminal.
2. Delegate to multiple repos in parallel by launching multiple `@polygraph-delegate-subagent` invocations.
3. For each child, the subagent watches `child.status` in the flat `children[]` response and exits when it sees a terminal status — typically `'completed'` or `'failed'` (and `'cancelled'` if it was stopped).
4. Once all subagents report a terminal status, continue to `push_branch` + `create_pr`.

{% elsif platform == "codex" %}

**CRITICAL:** Routine Polygraph MCP `spawn_agent` and `show_agent` calls MUST run inside the custom Codex `polygraph-delegate-subagent`, not directly in the main conversation. Codex `spawn_agent` launches a local subagent; the Polygraph MCP `spawn_agent` starts work in another repository. Keeping the MCP delegate-and-poll loop inside `polygraph-delegate-subagent` prevents polling noise from filling the user's context.

1. For each repo, launch `polygraph-delegate-subagent` via Codex's `spawn_agent`:

{% raw %}

```
spawn_agent(
  agent_type: "polygraph-delegate-subagent",
  message: """
    Parameters:
    - sessionId: "<session-id>"
    - repo: "<org/repo-name>"
    - instruction: "<the task instruction>"
    - context: "<optional context>"

    Call the Polygraph MCP spawn_agent for the repo, then poll show_agent on backoff until terminal. Return a structured summary with repo, status, session ID, and result text.
  """
)
```

{% endraw %}

2. Delegate to multiple repos in parallel by launching multiple `polygraph-delegate-subagent` instances before waiting for results.
3. For each child, the subagent watches `child.status` in the flat `children[]` response and exits when it sees a terminal status — typically `'completed'` or `'failed'` (and `'cancelled'` if it was stopped).
4. Collect completed results with `wait_agent` when the main flow needs them, then continue to `push_branch` + `create_pr`.

In rare cases where you need to check the raw child agent status directly (e.g., debugging a stuck subagent), you may call the Polygraph MCP `show_agent` as a one-off tool call. Do NOT use this for regular polling — that belongs inside `polygraph-delegate-subagent`.

{% else %}

1. Call `spawn_agent` with `sessionId`, `repo`, and `instruction` for each repo. The call returns immediately.
2. Poll `show_agent` on backoff; for each child, watch `child.status` in the flat `children[]` response until it reaches a terminal status — typically `'completed'` or `'failed'` (and `'cancelled'` if it was stopped).
3. Review `child.lastOutputLines` for the final log tail.
4. Continue to `push_branch` + `create_pr`.

{% endif %}

Use Simple when the task is well-defined and the child will not need clarification.

## Multi-turn tasks (interactive)

Use this pattern when the child may need clarification, the task is exploratory, or interactive collaboration is desired. The orchestrator exposes paused children via the `'input-required'` status.

1. Call `spawn_agent` with the initial `instruction`. Parse the response:

   ```json
   { "taskId": "…", "message": "…", "status": "delegated" }
   ```

   Store the returned `taskId`. You will pass it back on any follow-up turn so the orchestrator routes the message to the same active task instead of starting a new run.

2. Poll `show_agent`. The response shape is `{ children: PolygraphChildStatusItem[] }`. For each child, inspect:

   - `child.status` — one of `'created'`, `'in-progress'`, `'input-required'`, `'completed'`, `'failed'`, `'cancelled'` (British double-L on `'cancelled'`).
   - `child.inputRequiredQuestion` — populated only when `child.status === 'input-required'`.
   - `child.lastOutputLines` — recent log tail.
   - `child.repoFullName` — which repo is talking.

   Drive the state machine:

   - `child.status === 'in-progress'` or `'created'` — continue polling.
   - `child.status === 'input-required'` — read `child.inputRequiredQuestion`, surface it to the user verbatim (e.g. "The child agent in `{child.repoFullName}` needs input: {child.inputRequiredQuestion}"), get the answer, then call `spawn_agent` again with `taskId: <stored taskId>` and `instruction: <answer>`. Continue polling.
   - `child.status === 'completed'` — read `child.lastOutputLines`, proceed to `push_branch` + `create_pr`.
   - `child.status === 'failed'` — read `child.lastOutputLines`, surface the failure.
   - `child.status === 'cancelled'` — the child was stopped via `stop_agent`; see below.

3. To abort mid-flight, call `stop_agent` with `{ sessionId, repo }`. The response is:

   ```json
   {
     "taskId": "…",
     "state": "cancelled",
     "sessionPreserved": true,
     "output": "…",
     "message": "…"
   }
   ```

   Because `sessionPreserved: true`, the preserved agent session can be restored later for context. After resuming, do not make changes or continue prior work until the user explicitly asks for changes.

Use Multi-turn when the child may need clarification, the task is exploratory, or interactive collaboration is desired. Otherwise use Simple.

{% if platform == "opencode" %}
<!-- opencode-only gate. Claude and Codex parents handle permission gates via the native
     MCP elicitation dialog and never see permission-required tasks in the polling loop —
     these instructions are noise for them. This gate can be removed once opencode's MCP
     client gains elicitation capability upstream. -->
## Handling permission requests

Child agents running in other repositories may pause and ask the parent agent whether a specific action is permitted. Polygraph exposes this via two wire paths.

**Native path (MCP permission dialog):** If your MCP client supports the permission dialog UI, the user picks directly in that dialog — you (the agent) won't see `permission-required` tasks in that flow.

**Structured fallback path:** When `cloud_polygraph_child_status` reports a task in `permission-required` state, read the `pendingPermission` object on that task (carries `harness`, `action`, `target`, `repositoryId`, `repoFullName`, `scope`, `availableScopes`, optional `reason`, optional `rawInput`), then call `allow_agent` (to grant the requested action) or `deny_agent` (to refuse it) with the `{sessionId, repo}` of the child agent.

### Answering a permission request

```jsonc
// To grant the requested action:
{
  "sessionId": "...",
  "repo": "nrwl/example-repo",
  "scope": "session",              // or "one-time"
  "reason": "Trusted local repo"   // optional
}
// — call `allow_agent` with this payload.

// To refuse the requested action:
{
  "sessionId": "...",
  "repo": "nrwl/example-repo",
  "reason": "Action looks risky"   // optional
}
// — call `deny_agent` with this payload.
```

The three decisions:

- `allow_agent` with `scope: 'one-time'` — permits the single action only; the child must ask again for the next action of the same type.
- `allow_agent` with `scope: 'session'` — permits the action and remembers that grant for the rest of the child's session; the child will not ask again.
- `deny_agent` — rejects the request; child continues without performing the action.

**Fail-closed default:** When you see a task in `permission-required` state, you MUST call either `allow_agent` or `deny_agent`. Failing to call one leaves the gate held open until the child's idle timer fires; the child cannot make progress until you decide.

> **OpenCode caveat:** *OpenCode children sometimes request permissions without specific command/path (target is empty). Dialog says 'session' grant covers ALL `${action}` calls this session — read carefully before granting session scope.*

### Polling for permission-required in the fallback path

When polling `cloud_polygraph_child_status` (or `show_agent`), treat `permission-required` like `input-required`:

1. Read `child.pendingPermission` — inspect `harness`, `action`, `target`, `repoFullName`, and `scope`.
2. Surface the request to the user: "Child agent in `{repoFullName}` requests `{scope}` permission to run `{action}` on `{target}`."
3. Obtain the user's decision.
4. Call `allow_agent` (to grant) or `deny_agent` (to refuse) with `{ sessionId, repo }`.
5. Resume polling.
{% else %}
<!-- Claude and Codex parents handle permission gates via the native MCP elicitation dialog
     rendered by polygraph-mcp's show_agent handler. The dialog targets the parent harness's
     own UI, NOT this agent. From the agent's vantage point the gate is transient: a
     `show_agent` poll may briefly see `permission-required` between the child opening the
     gate and the user picking in the dialog. The agent must NOT resolve it itself. -->
## Handling permission requests

Your MCP client supports the native permission dialog. When a child agent requests permission, the dialog renders directly in your UI and the user picks — the decision routes back through `polygraph-mcp` automatically.

**Critical: do NOT call `allow_agent` or `deny_agent` yourself.** If `show_agent` (or `cloud_polygraph_child_status`) briefly reports a child in `permission-required` state with `pendingPermission` populated, that is a transient state the dialog is in the middle of resolving. Your job is to keep polling — the next poll will see the child back in `in-progress` (or `failed` / `cancelled` if the user denied or dismissed).

If you call `allow_agent` while the dialog is already open, you create a race: the user's pick lands first and the explicit allow fails with `Task <id> is in state 'completed', not 'permission-required'`. The child receives the user's choice; your call is wasted work.

The `allow_agent` and `deny_agent` tools exist for parents whose MCP clients do NOT advertise elicitation capability (opencode TUI today). They are not part of your flow.
{% endif %}

### 2. Push Branches

Once work is complete in a repository, push the branch using `push_branch`. This must be done before creating a PR.

**Parameters:**

- `sessionId` (required): The Polygraph session ID
- `repo` (required): Repository name or repository ID to push from
- `branch` (required): Branch name to push to remote
- `description` (required): A session description is required. Must follow the Session Description Policy.

```
push_branch(
  sessionId: "<session-id>",
  repo: "org/repo-name",
  branch: "polygraph/ad5fa-add-user-preferences"
)
```

### Session Description Policy

`description` is user-facing Polygraph session context.

`description` is required for `push_branch`, `create_pr`, `associate_pr`, and `update_session_description`. (`mark_pr_ready` does not take a description.) Use the canonical structured format:

```text
Goal: <what the session is trying to accomplish>

Current Progress: <what has been completed so far, including PR/session state when relevant>

What Worked: <important decisions, approaches, or constraints that future agents should preserve>

Next Steps: <clear next implementation steps>
```

- Do not use a one-line feature summary for final handoff or PR creation in a multi-repo session.
- Keep it concise but durable for a future resumed agent.
- Prefer high-level state over file-by-file changelogs.
- Mention unresolved decisions or risks when they matter.
- In `Next Steps`, include only next implementation steps. Do not list routine operational steps such as pushing branches, watching CI, or marking PRs ready.

> **Tip (optional):** The Polygraph UI renders fenced ` ```mermaid ` blocks in the session description as diagrams. If a small diagram would genuinely clarify the session state — for example, cross-repo relationships or a sequence of changes — you may include one. Plain text remains the norm; diagrams are never required.

### 3. Create Draft PRs

Create PRs for all repositories at once using `create_pr`. PRs are created as drafts with session metadata that links related PRs across repos. Branches must be pushed first. For fork PR creation or registration, include `targetRepository` on the PR spec to identify the repository that should receive the PR.

**Parameters:**

- `sessionId` (required): The Polygraph session ID
- `prs` (required): Array of PR specifications, each containing:
  - `owner` (required): GitHub repository owner
  - `repo` (required): GitHub repository name
  - `title` (required): PR title
  - `body` (required): PR description (session metadata is appended automatically)
  - `branch` (required): Branch name that was pushed
  - `targetRepository` (optional): Target GitHub repository for fork PR creation or registration, as `owner/repo`. Omit for same-repository PRs.
- `description` (required): Must follow the Session Description Policy.

**PR title format (applies to parent and child agents):**

- PR titles become squash-merge commit messages in most repos. They MUST follow the target repo's commit convention (e.g., Conventional Commits: `<type>(<scope>): <subject>`).
- Do NOT add agent-identifier prefixes such as `[codex]`, `[claude]`, or `[opencode]` to PR titles. These prefixes violate commit-lint rules and pollute the git history.

```
create_pr(
  sessionId: "<session-id>",
  prs: [
    {
      owner: "org",
      repo: "frontend",
      title: "feat: Add user preferences UI",
      body: "Part of multi-repo user preferences feature",
      branch: "polygraph/ad5fa-add-user-preferences"
    },
    {
      owner: "org",
      repo: "backend",
      title: "feat: Add user preferences API",
      body: "Part of multi-repo user preferences feature",
      branch: "polygraph/ad5fa-add-user-preferences"
    }
  ]
)
```

For fork PR creation or registration, keep `owner` and `repo` set to the source repository that owns the pushed branch and set `targetRepository` to the target repository:

```
create_pr(
  sessionId: "<session-id>",
  prs: [
    {
      owner: "contributor",
      repo: "frontend-fork",
      targetRepository: "org/frontend",
      title: "feat: Add user preferences UI",
      body: "Part of multi-repo user preferences feature",
      branch: "polygraph/ad5fa-add-user-preferences"
    }
  ]
)
```

**After creating PRs**, always print the Polygraph session URL:

```
**Polygraph session:** POLYGRAPH_SESSION_URL
```

### 4. Get Current Polygraph Session

Check the details of a session using `show_session` or `polygraph session show --details <session-id>`. Returns the full session state including repositories, PRs, CI status, and the Polygraph session URL.

**Parameters:**

- `sessionId` (required): The Polygraph session ID

**Returns:**

- `session.sessionId`: The session ID
- `session.polygraphSessionUrl`: URL to the Polygraph session UI
- `session.description`: DescriptionItem[] timeline describing the session.
- `session.agentSessionId`: The agent CLI session ID — captured automatically by the MCP server (null if no agent has run yet).
- `session.linkedReferences`: Array of references linked to this session
- Session repository entries: Array of connected repositories, each with:
  - `id`: Repository ID
  - `name`: Repository name
  - `defaultBranch`: Default branch (e.g., `main`)
  - `vcsConfiguration.repositoryFullName`: Full repo name (e.g., `org/repo`)
  - `vcsConfiguration.provider`: VCS provider (e.g., `GITHUB`)
  - description field: AI-generated description of what this repository does (may be null)
  - `initiator`: Whether this repository initiated the session
- `session.dependencyGraph`: Graph of repository dependency `edges`
- `session.pullRequests[]`: Array of PRs, each with:
  - `url`: PR URL
  - `branch`: Branch name
  - `baseBranch`: Target branch
  - `title`: PR title
  - `status`: One of `DRAFT`, `OPEN`, `MERGED`, `CLOSED`
  - `repoId`: Associated repository ID
  - `relatedPRs`: Array of related PR URLs across repos
- `session.ciStatus`: CI pipeline status keyed by PR ID, each containing:
  - `status`: One of `SUCCEEDED`, `FAILED`, `IN_PROGRESS`, `NOT_STARTED` (null if no CIPE and no external CI)
  - `cipeUrl`: URL to the CI pipeline execution details (null if no CIPE)
  - `completedAt`: Epoch millis timestamp, set only when the CIPE has completed (null otherwise)
  - `selfHealingStatus`: The self-healing fix status string from Nx Cloud's AI fix feature (null if no AI fix exists)
  - `externalCIRuns`: Array of external CI runs (present when no CIPE but external CI data exists, e.g., GitHub Actions). Each run contains:
    - `runId`: GitHub Actions run ID
    - `name`: Workflow name
    - `status`: Run status (`completed`, `in_progress`, `queued`)
    - `conclusion`: Run conclusion (`success`, `failure`, `cancelled`, `timed_out`, or null)
    - `url`: GitHub Actions run URL
    - `jobs`: Array of jobs in the run, each with:
      - `jobId`: Job ID (use with `get_ci_logs`)
      - `name`: Job name
      - `status`: Job status
      - `conclusion`: Job conclusion (or null)

```
show_session(sessionId: "<session-id>")
```

### Linked References

Use `link_reference` to link an external reference to the current Polygraph session.

**Parameters:**

- `sessionId` (required): The Polygraph session receiving the linked reference
- `reference` (required): Reference metadata with `type`, `url`, and `label`
- `reference.sessionId` (session references only): The referenced Polygraph session ID when `reference.type` is `session`

When an external resource is mentioned during a Polygraph session and appears relevant to the current work, the parent agent should record it with `link_reference({ sessionId, reference })`. This applies to relevant external resources such as pull requests, GitHub issues, other Polygraph sessions, and Linear issues.

Invoke the MCP tool with a single object containing `{ sessionId, reference }`. For example, to record a relevant pull request:

```
link_reference({
  sessionId: "<current-session-id>",
  reference: {
    type: "github_pr",
    url: "https://github.com/nrwl/polygraph-skills/pull/123",
    label: "Implementation PR"
  }
})
```

To record a relevant Polygraph session, use the same invocation shape and include `reference.sessionId`:

```
link_reference({
  sessionId: "<current-session-id>",
  reference: {
    type: "session",
    url: "https://polygraph.example/s/<inspected-session-id>",
    label: "Inspected Polygraph session",
    sessionId: "<inspected-session-id>"
  }
})
```

The canonical MCP parameters are `{ sessionId, reference }`. There is no unlink command.

### 5. Mark PRs Ready

Once all changes are verified and ready to merge, use `mark_pr_ready` to transition PRs from DRAFT to OPEN status.

**Parameters:**

- `sessionId` (required): The Polygraph session ID
- `prUrls` (required): Array of PR URLs to mark as ready for review

```
mark_pr_ready(
  sessionId: "<session-id>",
  prUrls: [
    "https://github.com/org/frontend/pull/123",
    "https://github.com/org/backend/pull/456"
  ]
)
```

**After marking PRs as ready**, always print the Polygraph session URL so the user can easily access the session overview. Call `show_session` and display:

```
**Polygraph session:** POLYGRAPH_SESSION_URL
```

Where `POLYGRAPH_SESSION_URL` is from `polygraphSessionUrl` in the response.

### 6. Associate Existing PRs

Use `associate_pr` to link pull requests that were created outside of Polygraph (e.g., manually or by CI) to the current session. This is useful when PRs already exist for the branches in the session and you want Polygraph to track them.

Provide either a `prUrl` to associate a specific PR, or a `branch` name plus `repo` to find and associate PRs for a source repository.

**Parameters:**

- `sessionId` (required): The Polygraph session ID
- `prUrl` (optional): URL of an existing pull request to associate
- `branch` (optional): Branch name to find and associate PRs for
- `repo` (optional): Source repository for branch-based association. Required when using `branch` in a multi-repo session.
- `description` (required): Must follow the Session Description Policy.

```
associate_pr(
  sessionId: "<session-id>",
  prUrl: "https://github.com/org/repo/pull/123"
)
```

Or by branch:

```
associate_pr(
  sessionId: "<session-id>",
  repo: "org/repo",
  branch: "feature/my-changes"
)
```

**Returns** the list of PRs now associated with the session.

### 7. Add Repositories to a Session

Use `add_repo` to add repositories to an existing Polygraph session after it has already started.

**Direct-add rule:** When the user provides exact repo refs by ID, short name, full name, GitHub `owner/repo` slug, or URL-like slug, pass those refs directly to `add_repo` and do not call `list_repos` first. Candidate discovery remains account-repo-only and is only for cases where the user does not know the exact repo or asks to choose/filter candidates.

**Parameters:**

- `sessionId` (required): The Polygraph session ID
- `repoIds` (required): Repository IDs or exact repository refs to add. Accepts IDs, short names, full names, GitHub `owner/repo` slugs, and URL-like slugs.

```
add_repo(
  sessionId: "<session-id>",
  repoIds: ["nrwl/ocean"]
)
```

### 8. Complete Session

**IMPORTANT: Only call this tool when the user explicitly asks to complete or close the session.** Do not automatically complete sessions as part of the workflow.

**Warning:** Completing a session seals it from further modifications. Only complete a session when the user explicitly confirms they are done coordinating the session.

Use `complete_session` to mark the session as completed. Completing a session will:

- **Mark the session as completed** and sealed from further modifications (no new PRs, status changes, etc.)

This is idempotent — completing an already-completed session returns success.

**Parameters:**

- `sessionId` (required): The Polygraph session ID
- `clean` (optional): Remove local session worktrees after marking the session complete

**Returns:**

- `sessionId`: The session ID
- `completed`: Boolean indicating completion status

```
complete_session(
  sessionId: "<session-id>"
)
```

**When to call:**

- After all cross-repo work is finished
- All PRs have been created and marked ready for review
- The user explicitly confirms they want to close all PRs and seal the session

## Other Capabilities

### Retrieving CI Job Logs

Use `get_ci_logs` to retrieve the full plain-text log for a specific CI job. This is the drill-in tool for investigating CI failures after identifying a failed job from the session's CI status.

**ONLY use this tool when NO CIPE (CI Pipeline Execution) exists for the PR.** When a CIPE exists (`ciStatus[prId].cipeUrl` is non-null), logs and failure data are available through the CIPE system (Nx Cloud) via `ci_information` — do NOT call `get_ci_logs`. This tool is specifically for PRs where only external CI runs exist (e.g., GitHub Actions runs without an Nx Cloud CIPE).

**Parameters:**

- `sessionId` (required): The Polygraph session ID
- `repoId` (required): Repository ID (MongoDB ObjectId hex string, from the session repository entry)
- `jobId` (required): GitHub Actions job ID (from `ciStatus[prId].externalCIRuns[].jobs[].jobId` in the `show_session` response)

**Returns:**

- On success: `{ success: true, jobId: number, logFile: string, sizeBytes: number }`
- On failure: `{ success: false, error: string }`

The tool saves the log to a local temp file and returns the path in `logFile`. Use the `Read` tool to examine the file contents. For large logs, use `offset` and `limit` parameters to read specific sections.

```
get_ci_logs(
  sessionId: "<session-id>",
  repoId: "<repo-id>",
  jobId: 12345678
)
// Returns: { success: true, jobId: 12345678, logFile: "/tmp/ci-logs/job-12345678.log", sizeBytes: 152340 }
// Then: Read(logFile) to examine the log
```

**Typical flow:**

1. Use `show_session` to see PR CI status
2. Check `ciStatus[prId].cipeUrl` — if a CIPE exists, use `ci_information` for logs and skip this tool
3. If NO CIPE exists, check `ciStatus[prId].externalCIRuns` — examine runs and jobs directly from the session data
4. For a failed job, call `get_ci_logs(sessionId, repoId, jobId)` to save the log to a file
5. Use `Read(logFile)` to examine the log content — use `offset`/`limit` for large files

**Important:** Logs can be large (100KB+). Only fetch logs for failed or relevant jobs, and read only the sections you need.

### Update Session Description

Use this when the user asks to summarize progress, update the session description, capture the current state.

Before writing:
- Read the current session details.
- Consider the current conversation, child-agent results, PRs, pushed branches, validation, and unresolved decisions.
- If appending a new item, read the current/latest description first and write the full replacement description with the existing items plus the new item.
- If updating or replacing the existing last item, write the resulting state directly.

Write the description using the canonical structured format in the Session Description Policy. Then call `update_session_description` with the resulting summary.

### Print Polygraph Session Details

When asked to print polygraph session details, use `show_session` or `polygraph session show --details <session-id>` and display in the following format.

**Session:** POLYGRAPH_SESSION_URL

| Repo           | PR                 | PR Status | CI Status | Self-Healing        | CI Link          |
| -------------- | ------------------ | --------- | --------- | ------------------- | ---------------- |
| REPO_FULL_NAME | [PR_TITLE](PR_URL) | PR_STATUS | CI_STATUS | SELF_HEALING_STATUS | [View](CIPE_URL) |

If the session has a description timeline, also display:

**Description:** SESSION_DESCRIPTION

(Omit the Description line if `description` is empty.)

- REPO_FULL_NAME: from the session repository entries (match repository to PR via `repoId`)
- PR_URL, PR_TITLE, PR_STATUS: from `pullRequests[]`
- CI_STATUS: from `ciStatus[prId].status`
- SELF_HEALING_STATUS: from `ciStatus[prId].selfHealingStatus` (omit or show `-` if null)
- CIPE_URL: from `ciStatus[prId].cipeUrl`
- POLYGRAPH_SESSION_URL: from `polygraphSessionUrl`
- SESSION_DESCRIPTION: from the latest/current item in `description`

## Best Practices

{% if platform == "claude" %}

1. **MUST delegate via background subagents** — You MUST use `Task(run_in_background: true)` for every `spawn_agent` and `show_agent` call. NEVER call these directly in the main conversation — it floods the context window with polling noise.
   {% elsif platform == "opencode" %}
1. **MUST delegate via subagents** — You MUST use `@polygraph-delegate-subagent` for every `spawn_agent` and `show_agent` call. NEVER call these directly in the main conversation — it floods the context window with polling noise.
   {% elsif platform == "codex" %}
1. **MUST route through Codex Polygraph subagents** — Use Codex `spawn_agent` with `agent_type: "polygraph-init-subagent"` to create new sessions and `agent_type: "polygraph-delegate-subagent"` for every routine Polygraph MCP `spawn_agent` / `show_agent` delegate-and-poll loop. Collect results with `wait_agent` when needed.
   {% else %}
1. **Delegate asynchronously** — Use `spawn_agent` which returns immediately, then poll with `show_agent`.
   {% endif %}
1. **Poll child status before proceeding** — Always verify child agents have reached a terminal `child.status` (`'completed'`, `'failed'`, or `'cancelled'`) via `show_agent` before pushing branches or creating PRs
1. **Link PRs in descriptions** - Reference related PRs in each PR body
1. **Keep PRs as drafts** until all repos are ready
1. **Always pass `description`** when calling `create_pr`, `associate_pr`, or `update_session_description` — it is required and must follow the Session Description Policy
1. **Test integration** before marking PRs ready
1. **Coordinate merge order** if there are deployment dependencies
   {% if platform == "claude" %}
1. **NEVER call `spawn_agent` or `show_agent` directly**. These MUST ALWAYS go through background Task subagents (`run_in_background: true`).
   {% elsif platform == "opencode" %}
1. **NEVER call `spawn_agent` or `show_agent` directly**. These MUST ALWAYS go through `@polygraph-delegate-subagent`.
   {% elsif platform == "codex" %}
1. **NEVER call the Polygraph MCP `spawn_agent` or `show_agent` directly for routine delegation**. These MUST run inside `polygraph-delegate-subagent`.
   {% endif %}
1. **Use `stop_agent` to clean up** — Stop child agents that are stuck or no longer needed. The child's session is preserved (`sessionPreserved: true`) so the context can be restored later, but after resuming you must wait for explicit user instructions before making changes.
1. **Only complete sessions when asked** — Only call `complete_session` when the user explicitly requests it. Completing a session seals it from further modifications. Do not automatically complete sessions.
