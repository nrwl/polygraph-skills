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
- **For repo work:** call Codex `spawn_agent` with `agent_type: "polygraph-delegate-subagent"`. Do NOT call Polygraph MCP `spawn_agent` or `show_agent` directly from this conversation; collect results with `wait_agent` when needed.
- **Allowed direct Polygraph MCP calls from the parent:** `whoami`, `login`, `list_accounts`, `select_account`, and `show_session` for read-only inspection of an existing session.
- Do NOT pass `fork_context: true` to Codex `spawn_agent` when `agent_type` is a custom agent — Codex rejects it.
{% else %}
**IMPORTANT:** NEVER `cd` into cloned repositories or access their files directly. ALWAYS use the `spawn_agent` tool to perform work in other repositories.
{% endif %}

This skill provides guidance for working on features that span multiple repositories using Polygraph for coordination.

## Available Tools

Polygraph functionality is available via both MCP tools and CLI commands. Use whichever is available in your current environment.

| MCP Tool | CLI Equivalent | Description |
| --- | --- | --- |
| `list_repos` | `polygraph repo list` | Discover candidate workspaces with descriptions and graph relationships |
| `start_session` | `polygraph session start --repo <ids>` | Initialize a Polygraph session with selected workspaces |
| `spawn_agent` | — | Start (or resume) a task on a child agent in another repository. Input: `{ sessionId, target, instruction, context?, taskId? }`. Output: `{ taskId, message, status: 'delegated' }`. Pass the `taskId` returned by a prior call to target a follow-up message at a specific active task; omit to start a new child run. |
| `show_agent` | — | Poll flat per-child status for the session. Output: `{ children: PolygraphChildStatusItem[] }` where each item exposes `repositoryId`, `repoFullName`, `status`, `lastOutputLines`, `durationMs`, `instruction`, `agentType?`, `inputRequiredQuestion?`. `status` is an AcpRunStatus: `'created' \| 'in-progress' \| 'input-required' \| 'completed' \| 'failed' \| 'cancelled'` (British double-L on `'cancelled'`). `inputRequiredQuestion` is populated only when `status === 'input-required'`. |
| `stop_agent` | — | Cancel an in-progress child. Output: `{ taskId, state: 'cancelled', sessionPreserved: true, output, message }`. Because `sessionPreserved: true`, a later `spawn_agent` call against the same target resumes from the preserved agent session. |
| `push_branch` | — | Push a local git branch to the remote repository |
| `create_pr` | — | Create draft PRs with session metadata linking related PRs |
| `show_session` | `polygraph session show <id> [--details]` | Query status of the current session. Use details when session summary, repo IDs, PR URLs, and PR descriptions are needed. |
| `link_session` | `polygraph session link --targetSessionId=SESSION_ID --linkedSessionId=SESSION_ID` | Link one session to another session |
| `mark_pr_ready` | — | Mark draft PRs as ready for review |
| `associate_pr` | — | Associate an existing PR with a session |
| `add_repo` | — | Add workspaces to a running Polygraph session |
| `complete_session` | `polygraph session complete <id>` | Mark a session complete |
| `get_ci_logs` | — | Retrieve full plain-text log for a specific CI job |
| — | `polygraph login [--token]` | Authenticate with Nx Cloud (use `--token` for headless/CI) |
| — | `polygraph session list` | List all sessions |
| — | `polygraph org list` / `org select` | Organization management |
| — | `polygraph whoami` | Show current auth status and org |

{% if platform == "claude" or platform == "opencode" %}

**Delegation rules:** `list_repos` and `start_session` MUST be called via the `polygraph-init-subagent` as described in step 0. `spawn_agent` and `show_agent` MUST ALWAYS be called via background Task subagents (`run_in_background: true`) as described in the delegation sections below — NEVER call them directly in the main conversation.
{% elsif platform == "codex" %}

**Routing reminder:** Per the Critical Routing Rule above, the parent conversation must use Codex `spawn_agent` with `agent_type: "polygraph-init-subagent"` for new sessions and `agent_type: "polygraph-delegate-subagent"` for repo work — not the Polygraph MCP tools shown in the table. `wait_agent` collects results when needed.
{% endif %}

## CLI Statefulness

The Polygraph CLI (`polygraph`) is **stateful**. When you select an organization — via `polygraph org select` or the equivalent MCP tool — that selection is saved globally and all subsequent CLI commands and MCP tool calls operate against it. You do not need to pass the org on every command.

## Setup

Before using Polygraph tools, ensure the CLI is authenticated and an organization is selected.

### Check Authentication

Use `polygraph whoami` (or the `whoami` MCP tool) to check if the user is currently logged in and which organization is active.

- If the user **is logged in** and an org is selected → proceed to the workflow.
- If the user **is not logged in** → use `polygraph login` (or the `login` MCP tool) to authenticate. After login, an organization must be selected.

### Select Organization

After logging in (or if logged in but no org is selected), use `polygraph org select` (or the equivalent MCP tool) to choose the organization that future commands will run against.

## Workflow Overview

{% if has_subagents %}

0. **Initialize or join Polygraph session** - If you already have a session ID, call `show_session` to fetch details. Otherwise, launch the `polygraph-init-subagent` to discover candidate repos, select relevant workspaces, and create a new session.
1. **Delegate work to each repo** - Use the `polygraph-delegate-subagent` to start child agents in other repositories. Choose the Simple (fire-and-forget) or Multi-turn (interactive) pattern described below based on whether the child may need clarification.
   {% else %}
2. **Initialize or join Polygraph session** - If you already have a session ID, call `show_session` to fetch details. Otherwise, discover candidate repos, select relevant workspaces, and create a new session via `list_repos` and `start_session`.
3. **Delegate work to each repo** - Use `spawn_agent` to start child agents in other repositories (returns immediately). Choose the Simple (fire-and-forget) or Multi-turn (interactive) pattern described below.
   {% endif %}
4. **Monitor child agents** - Use `show_agent` to poll progress and read the flat `children[]` array for each child's `status` and `lastOutputLines`.
5. **Stop child agents** (if needed) - Use `stop_agent` to cancel an in-progress child agent. The underlying agent session is preserved for later resumption.
6. **Push branches** - Use `push_branch` after making commits.
7. **Create draft PRs** - Use `create_pr` to create linked draft PRs. Both `plan` and `agentSessionId` are required.
8. **Associate existing PRs** (optional) - Use `associate_pr` to link PRs created outside Polygraph.
9. **Query PR status** - Use `show_session` to check progress.
10. **Mark PRs ready** - Use `mark_pr_ready` when work is complete.
11. **Complete session** - Use `complete_session` to mark the session as completed when the user requests it.

## Step-by-Step Guide

### 0. Initialize or Join Polygraph Session

**If you already have a session ID** (e.g., passed by the user or provided when Claude was spawned inside an existing session), the session already exists — do NOT create a new one. Instead, call `show_session` to fetch the session details and skip straight to printing the session details below.

{% if has_subagents %}

**If you need to create a new session**, use the `polygraph-init-subagent` to discover candidate repos, select relevant workspaces, and initialize the Polygraph session. The subagent handles calling `list_repos` and `start_session` and returns a structured summary.
{% else %}

**If you need to create a new session**, discover candidate repos using `list_repos`, select relevant workspaces, and initialize the Polygraph session using `start_session`.
{% endif %}

**Session ID is auto-generated:**

The `start_session` tool automatically generates a unique session ID. You do NOT need to pass a session ID when creating a new session.
{% if platform == "claude" %}

**Launch the init subagent** (only when creating a new session):

{% raw %}

```
Task(
  subagent_type: "polygraph-init-subagent",
  description: "Init Polygraph session",
  prompt: """
    Parameters:
    - userContext: "<description of what the user wants to do>"

    Discover candidates, select relevant repos based on the user context, initialize the session, and return a structured summary.
  """
)
```

{% endraw %}
{% elsif platform == "opencode" %}

**Launch the init subagent** using `@polygraph-init-subagent` (only when creating a new session):

Invoke the `polygraph-init-subagent` agent with the user context. The subagent handles calling `list_repos` and `start_session` and returns a structured summary.
{% elsif platform == "codex" %}

**Launch `polygraph-init-subagent`** (only when creating a new session):

Use Codex's `spawn_agent` tool to start the custom Polygraph init subagent:

{% raw %}

```
spawn_agent(
  agent_type: "polygraph-init-subagent",
  message: """
    Parameters:
    - userContext: "<description of what the user wants to do>"

    Discover candidates, select relevant repos based on the user context, initialize the session, and return a structured summary.
  """
)
```

{% endraw %}

When the main flow needs the session before proceeding, collect the result with `wait_agent`.
{% else %}

Call `list_repos` to discover available workspaces, select relevant repos based on user context, then call `start_session` with the selected workspace IDs.
{% endif %}

The subagent will:

1. Call `list_repos` to discover available workspaces
2. Select relevant repos based on the user context (or include all if uncertain)
3. Call `start_session` with the selected workspace IDs
4. Call `show_session` to retrieve session details
5. Return a summary with session URL, repos, and workspace info

**After receiving the subagent's summary (or after calling `show_session` for an existing session), print the session details:**

**Session:** POLYGRAPH_SESSION_URL

**Repositories in this session:**

| Repo           | Local Path |
| -------------- | ---------- |
| REPO_FULL_NAME | LOCAL_PATH |

- REPO_FULL_NAME: from `workspaces[].vcsConfiguration.repositoryFullName`
- LOCAL_PATH: the absolute path to the local clone of the repo. If you started the session from within a repo, that repo's path is the current working directory. All other repos' paths are available from `show_agent`.
- POLYGRAPH_SESSION_URL: from `polygraphSessionUrl`

### Explore an Existing Session

Use this workflow when the user gives a Polygraph session ID and asks to understand, resume, inspect, or investigate prior work.

1. Fetch detailed session context:
   - Prefer `show_session` with `details: true` when the MCP tool exposes that option.
   - Otherwise run `polygraph session show <session-id> --details`.
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
5. Use the PR descriptions and session summary to decide whether more repo investigation is needed.
6. If the repo to investigate is already part of the session, delegate directly to that repo.
7. If the repo to investigate is not currently initialized in the session but appears in `<repositories>`, call `add_repo` with that repo's `<id>` directly. Do not call `list_repos` just to resolve the repo.
8. After `add_repo`, call `show_session` again to verify the repo was added, then delegate to that repo.
9. Fall back to `list_repos` only when the desired repo is mentioned in prose but is missing from `<repositories>`, or when the details output came from an older Polygraph version that did not include repo IDs.

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

1. Launch a background `Task` subagent per target repo using `polygraph-delegate-subagent`. The subagent calls `spawn_agent`, then polls `show_agent` on backoff until terminal.

{% raw %}

```
Task(
  subagent_type: "polygraph-delegate-subagent",
  run_in_background: true,
  description: "Delegate to <repo-name>",
  prompt: """
    Parameters:
    - sessionId: "<session-id>"
    - target: "<org/repo-name>"
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

1. For each target repo, invoke `@polygraph-delegate-subagent` with `sessionId`, `target`, `instruction`, and optional `context`. The subagent calls `spawn_agent`, then polls `show_agent` on backoff until terminal.
2. Delegate to multiple repos in parallel by launching multiple `@polygraph-delegate-subagent` invocations.
3. For each child, the subagent watches `child.status` in the flat `children[]` response and exits when it sees a terminal status — typically `'completed'` or `'failed'` (and `'cancelled'` if it was stopped).
4. Once all subagents report a terminal status, continue to `push_branch` + `create_pr`.

{% elsif platform == "codex" %}

**CRITICAL:** Routine Polygraph MCP `spawn_agent` and `show_agent` calls MUST run inside the custom Codex `polygraph-delegate-subagent`, not directly in the main conversation. Codex `spawn_agent` launches a local subagent; the Polygraph MCP `spawn_agent` starts work in another repository. Keeping the MCP delegate-and-poll loop inside `polygraph-delegate-subagent` prevents polling noise from filling the user's context.

1. For each target repo, launch `polygraph-delegate-subagent` via Codex's `spawn_agent`:

{% raw %}

```
spawn_agent(
  agent_type: "polygraph-delegate-subagent",
  message: """
    Parameters:
    - sessionId: "<session-id>"
    - target: "<org/repo-name>"
    - instruction: "<the task instruction>"
    - context: "<optional context>"

    Call the Polygraph MCP spawn_agent for the target repo, then poll show_agent on backoff until terminal. Return a structured summary with repo, status, session ID, and result text.
  """
)
```

{% endraw %}

2. Delegate to multiple repos in parallel by launching multiple `polygraph-delegate-subagent` instances before waiting for results.
3. For each child, the subagent watches `child.status` in the flat `children[]` response and exits when it sees a terminal status — typically `'completed'` or `'failed'` (and `'cancelled'` if it was stopped).
4. Collect completed results with `wait_agent` when the main flow needs them, then continue to `push_branch` + `create_pr`.

In rare cases where you need to check the raw child agent status directly (e.g., debugging a stuck subagent), you may call the Polygraph MCP `show_agent` as a one-off tool call. Do NOT use this for regular polling — that belongs inside `polygraph-delegate-subagent`.

{% else %}

1. Call `spawn_agent` with `sessionId`, `target`, and `instruction` for each target repo. The call returns immediately.
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

   Store the returned `taskId`. You will pass it back on any follow-up turn so the orchestrator resumes the same active task instead of starting a new run.

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

3. To abort mid-flight, call `stop_agent` with `{ sessionId, target }`. The response is:

   ```json
   {
     "taskId": "…",
     "state": "cancelled",
     "sessionPreserved": true,
     "output": "…",
     "message": "…"
   }
   ```

   Because `sessionPreserved: true`, a later `spawn_agent` call against the same target resumes from the preserved agent session.

Use Multi-turn when the child may need clarification, the task is exploratory, or interactive collaboration is desired. Otherwise use Simple.

### 2. Push Branches

Once work is complete in a repository, push the branch using `push_branch`. This must be done before creating a PR.

**Parameters:**

- `sessionId` (required): The Polygraph session ID
- `target` (required): Repository name or workspace ID to push from
- `branch` (required): Branch name to push to remote

```
push_branch(
  sessionId: "<session-id>",
  target: "org/repo-name",
  branch: "polygraph/ad5fa-add-user-preferences"
)
```

### 3. Create Draft PRs

Create PRs for all repositories at once using `create_pr`. PRs are created as drafts with session metadata that links related PRs across repos. Branches must be pushed first.

**Parameters:**

- `sessionId` (required): The Polygraph session ID
- `prs` (required): Array of PR specifications, each containing:
  - `owner` (required): GitHub repository owner
  - `repo` (required): GitHub repository name
  - `title` (required): PR title
  - `body` (required): PR description (session metadata is appended automatically)
  - `branch` (required): Branch name that was pushed
- `plan` (required): High-level plan describing the session's purpose. Both `plan` and `agentSessionId` must always be provided together to enable session resuming.
- `agentSessionId` (required): The Claude CLI session ID. Both `plan` and `agentSessionId` must always be provided together to enable session resuming.

```
create_pr(
  sessionId: "<session-id>",
  plan: "Add user preferences feature: UI in frontend, API in backend",
  agentSessionId: "<claude-session-id>",
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

**After creating PRs**, always print the Polygraph session URL:

```
**Polygraph session:** POLYGRAPH_SESSION_URL
```

### 4. Get Current Polygraph Session

Check the details of a session using `show_session` or `polygraph session show --details <session-id>`. Returns the full session state including workspaces, PRs, CI status, and the Polygraph session URL.

**Parameters:**

- `sessionId` (required): The Polygraph session ID

**Returns:**

- `session.sessionId`: The session ID
- `session.polygraphSessionUrl`: URL to the Polygraph session UI
- `session.plan`: High-level plan describing what this session is doing (null if not set)
- `session.agentSessionId`: The Claude CLI session ID that can be used to resume the session (null if not set)
- `session.linkedSessions`: Array of sessions linked to this session
- `session.workspaces[]`: Array of connected workspaces, each with:
  - `id`: Workspace ID
  - `name`: Workspace name
  - `defaultBranch`: Default branch (e.g., `main`)
  - `vcsConfiguration.repositoryFullName`: Full repo name (e.g., `org/repo`)
  - `vcsConfiguration.provider`: VCS provider (e.g., `GITHUB`)
  - `workspaceDescription`: AI-generated description of what this workspace does (may be null)
  - `initiator`: Whether this workspace initiated the session
- `session.dependencyGraph`: Graph of workspace dependency `edges`
- `session.pullRequests[]`: Array of PRs, each with:
  - `url`: PR URL
  - `branch`: Branch name
  - `baseBranch`: Target branch
  - `title`: PR title
  - `status`: One of `DRAFT`, `OPEN`, `MERGED`, `CLOSED`
  - `workspaceId`: Associated workspace ID
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

### Session Linking

Use `link_session` to record that one Polygraph session is linked to another. The CLI equivalent is:

```
polygraph session link --targetSessionId=SESSION_ID --linkedSessionId=SESSION_ID
```

**Parameters:**

- `targetSessionId` (required): The current Polygraph session ID
- `linkedSessionId` (required): The inspected session ID that should be linked to the current session

```
link_session(
  targetSessionId: "<current-session-id>",
  linkedSessionId: "<inspected-session-id>"
)
```

When working inside a current Polygraph session and the user asks to inspect or show details for another session by session ID, always:

1. Call `show_session(sessionId: "<inspected-session-id>")` or `polygraph session show --details <inspected-session-id>` to retrieve the full details.
2. Call `link_session(targetSessionId: "<current-session-id>", linkedSessionId: "<inspected-session-id>")` or `polygraph session link --targetSessionId=<current-session-id> --linkedSessionId=<inspected-session-id>`.
3. Print the inspected session details for the user.

Repeat the link step every time a session is inspected this way. The canonical MCP parameters are `{ targetSessionId, linkedSessionId }`. There is no unlink command.

### 5. Mark PRs Ready

Once all changes are verified and ready to merge, use `mark_pr_ready` to transition PRs from DRAFT to OPEN status.

**Parameters:**

- `sessionId` (required): The Polygraph session ID
- `prUrls` (required): Array of PR URLs to mark as ready for review
- `plan` (required): High-level plan describing the session's purpose. Both `plan` and `agentSessionId` must always be provided together to enable session resuming.
- `agentSessionId` (required): The Claude CLI session ID. Both `plan` and `agentSessionId` must always be provided together to enable session resuming.

```
mark_pr_ready(
  sessionId: "<session-id>",
  plan: "Add user preferences feature: UI in frontend, API in backend",
  agentSessionId: "<claude-session-id>",
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

Provide either a `prUrl` to associate a specific PR, or a `branch` name to find and associate PRs matching that branch across session workspaces.

**Parameters:**

- `sessionId` (required): The Polygraph session ID
- `prUrl` (optional): URL of an existing pull request to associate
- `branch` (optional): Branch name to find and associate PRs for
- `plan` (required): High-level plan describing the session's purpose. Both `plan` and `agentSessionId` must always be provided together to enable session resuming.
- `agentSessionId` (required): The Claude CLI session ID. Both `plan` and `agentSessionId` must always be provided together to enable session resuming.

```
associate_pr(
  sessionId: "<session-id>",
  plan: "Add user preferences feature: UI in frontend, API in backend",
  agentSessionId: "<claude-session-id>",
  prUrl: "https://github.com/org/repo/pull/123"
)
```

Or by branch:

```
associate_pr(
  sessionId: "<session-id>",
  plan: "Add user preferences feature: UI in frontend, API in backend",
  agentSessionId: "<claude-session-id>",
  branch: "feature/my-changes"
)
```

**Returns** the list of PRs now associated with the session.

### 7. Add Repositories to a Session

Use `add_repo` to add workspaces to an existing Polygraph session after it has already started.

**Parameters:**

- `sessionId` (required): The Polygraph session ID
- `repoIds` (required): Workspace IDs or repository IDs to add. Use `list_repos` to discover available workspaces.

```
add_repo(
  sessionId: "<session-id>",
  repoIds: ["<workspace-id>"]
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
- `workspaceId` (required): Nx Cloud workspace ID (MongoDB ObjectId hex string, from `session.workspaces[].id`)
- `jobId` (required): GitHub Actions job ID (from `ciStatus[prId].externalCIRuns[].jobs[].jobId` in the `show_session` response)

**Returns:**

- On success: `{ success: true, jobId: number, logFile: string, sizeBytes: number }`
- On failure: `{ success: false, error: string }`

The tool saves the log to a local temp file and returns the path in `logFile`. Use the `Read` tool to examine the file contents. For large logs, use `offset` and `limit` parameters to read specific sections.

```
get_ci_logs(
  sessionId: "<session-id>",
  workspaceId: "<workspace-id>",
  jobId: 12345678
)
// Returns: { success: true, jobId: 12345678, logFile: "/tmp/ci-logs/job-12345678.log", sizeBytes: 152340 }
// Then: Read(logFile) to examine the log
```

**Typical flow:**

1. Use `show_session` to see PR CI status
2. Check `ciStatus[prId].cipeUrl` — if a CIPE exists, use `ci_information` for logs and skip this tool
3. If NO CIPE exists, check `ciStatus[prId].externalCIRuns` — examine runs and jobs directly from the session data
4. For a failed job, call `get_ci_logs(sessionId, workspaceId, jobId)` to save the log to a file
5. Use `Read(logFile)` to examine the log content — use `offset`/`limit` for large files

**Important:** Logs can be large (100KB+). Only fetch logs for failed or relevant jobs, and read only the sections you need.

### Session State for Resume (Required)

The `plan` and `agentSessionId` parameters are **required** on `create_pr`, `mark_pr_ready`, and `associate_pr`. You must always provide both values together. They save session state that enables resuming the Polygraph session later.

- **`plan`**: A high-level description of what this session is doing (e.g., "Add user preferences feature across frontend and backend repos"). This helps anyone resuming the session understand the context.
- **`agentSessionId`**: The Claude CLI session ID for the parent agent. This is the session ID that can be passed to `claude --continue` to resume exactly where the agent left off.

These fields are saved to the Polygraph session server-side and are available from `show_session`. The Polygraph UI also shows a "Resume Session" section with copy-able commands when these fields are present.

### Resuming a Polygraph Session

If a session has a saved `agentSessionId`, it can be resumed using:

```
claude --continue <agentSessionId>
```

This resumes the Claude CLI session that was coordinating the Polygraph work, restoring the full conversation context including which repos were involved, what work was delegated, and what remains to be done.

To check if a session is resumable, call `show_session` and look for the `agentSessionId` field in the response.

### Print Polygraph Session Details

When asked to print polygraph session details, use `show_session` or `polygraph session show --details <session-id>` and display in the following format. If you are already working inside a current Polygraph session and the requested details are for another session ID, first retrieve the requested session details, then link it with `targetSessionId` set to the current session ID and `linkedSessionId` set to the inspected session ID.

**Session:** POLYGRAPH_SESSION_URL

| Repo           | PR                 | PR Status | CI Status | Self-Healing        | CI Link          |
| -------------- | ------------------ | --------- | --------- | ------------------- | ---------------- |
| REPO_FULL_NAME | [PR_TITLE](PR_URL) | PR_STATUS | CI_STATUS | SELF_HEALING_STATUS | [View](CIPE_URL) |

If the session has a `plan` or `agentSessionId`, also display:

**Plan:** SESSION_PLAN

**Resume:** `claude --continue AGENT_SESSION_ID`

(Omit the Plan line if `plan` is null. Omit the Resume line if `agentSessionId` is null.)

**Local paths:**

- REPO_FULL_NAME: LOCAL_PATH

- REPO_FULL_NAME: from `workspaces[].vcsConfiguration.repositoryFullName` (match workspace to PR via `workspaceId`)
- LOCAL_PATH: the absolute path to the local clone of the repo. If you started the session from within a repo, that repo's path is the current working directory. All other repos' paths are available from `show_agent`.
- PR_URL, PR_TITLE, PR_STATUS: from `pullRequests[]`
- CI_STATUS: from `ciStatus[prId].status`
- SELF_HEALING_STATUS: from `ciStatus[prId].selfHealingStatus` (omit or show `-` if null)
- CIPE_URL: from `ciStatus[prId].cipeUrl`
- POLYGRAPH_SESSION_URL: from `polygraphSessionUrl`
- SESSION_PLAN: from `plan`
- AGENT_SESSION_ID: from `agentSessionId`

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
1. **Test integration** before marking PRs ready
1. **Coordinate merge order** if there are deployment dependencies
   {% if platform == "claude" %}
1. **NEVER call `spawn_agent` or `show_agent` directly**. These MUST ALWAYS go through background Task subagents (`run_in_background: true`).
   {% elsif platform == "opencode" %}
1. **NEVER call `spawn_agent` or `show_agent` directly**. These MUST ALWAYS go through `@polygraph-delegate-subagent`.
   {% elsif platform == "codex" %}
1. **NEVER call the Polygraph MCP `spawn_agent` or `show_agent` directly for routine delegation**. These MUST run inside `polygraph-delegate-subagent`.
   {% endif %}
1. **Use `stop_agent` to clean up** — Stop child agents that are stuck or no longer needed. The child's session is preserved (`sessionPreserved: true`), so a later `spawn_agent` call against the same target resumes the same agent session.
   {% if platform == "claude" %}
1. **Always provide `plan` and `agentSessionId`** — These are required on `create_pr`, `mark_pr_ready`, and `associate_pr`. Always pass both values so the session can be resumed later with `claude --continue`
   {% elsif platform == "opencode" %}
1. **Always provide `plan` and `agentSessionId`** — These are required on `create_pr`, `mark_pr_ready`, and `associate_pr`. Always pass both values so the session can be resumed later with `opencode --continue`
   {% else %}
1. **Always provide `plan` and `agentSessionId`** — These are required on `create_pr`, `mark_pr_ready`, and `associate_pr`. Always pass both values so the session can be resumed later.
   {% endif %}
1. **Only complete sessions when asked** — Only call `complete_session` when the user explicitly requests it. Completing a session seals it from further modifications. Do not automatically complete sessions.
