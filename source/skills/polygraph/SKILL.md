---
name: polygraph
description: Guidance for working with Polygraph sessions, shared/resumable agent context, repository graph visibility, linked PR/CI state, and cross-repo expansion when needed. Use when starting, joining, resuming, inspecting, or sharing a Polygraph session; handing off progress; discovering related repositories; coordinating changes/branches/PRs across repos; delegating tasks to child agents in different repos; checking CI status and logs; fetching missing git history in a shallow session clone; or tracing a commit or line of code back to the session that produced it. TRIGGER when user mentions "polygraph", resuming or sharing a session, "other repos", "other repositories", "who uses this", "what uses this", "cross-repo", "multi-repo", "consuming this API/endpoint", "dependent repositories", asks about what other repos are doing with shared code/APIs/endpoints, or asks about a "commit sha", "session behind this commit", "which session changed this line", "find session by sha", "git blame", "shallow clone", "missing commit", "bad object", "unshallow", "fetch history".
{% if platform == "claude" %}
allowed-tools:
  - mcp__plugin_polygraph_polygraph-mcp
{% endif %}
---

{% assign has_subagents = false %}
{% if platform == "claude" or platform == "opencode" or platform == "codex" %}
{% assign has_subagents = true %}
{% endif %}

# Working with Polygraph

**IMPORTANT:** Polygraph keeps local clones only for *other* repositories in the session. NEVER `cd` into those clones or access their files directly — work in other repositories ALWAYS happens through the Polygraph MCP `spawn_agent` tool, invoked {% if platform == "codex" %}via Codex Polygraph subagents{% elsif platform == "claude" %}via background `polygraph-delegate-subagent` Tasks{% elsif platform == "opencode" %}via `@polygraph-delegate-subagent`{% else %}directly{% endif %}.

{% if platform == "codex" %}
## Critical Routing Rule (Codex Parent Conversation)

Read this before the tool table below — it determines which tools are yours to call directly.

- Codex `spawn_agent` ≠ Polygraph MCP `spawn_agent`. Codex `spawn_agent` launches the local custom subagents (`polygraph-init-subagent`, `polygraph-delegate-subagent`). The Polygraph MCP `spawn_agent` runs work inside another repository and must only be invoked from inside those subagents.
- **For new sessions:** call Codex `spawn_agent` with `agent_type: "polygraph-init-subagent"`. Do NOT call Polygraph MCP `list_repos` or `start_session` directly from this conversation.
- **For explicit repo additions to an existing session:** if the user gives exact refs by ID, short name, full name, GitHub `owner/repo` slug, or URL-like slug, call Polygraph MCP `add_repo` directly with those refs. Do NOT call `list_repos` or launch candidate discovery first.
- **For repo work:** call Codex `spawn_agent` with `agent_type: "polygraph-delegate-subagent"`. Do NOT call Polygraph MCP `spawn_agent` or `show_agent` directly from this conversation; collect results with `wait_agent` when needed.
- Do NOT pass `fork_context: true` to Codex `spawn_agent` when `agent_type` is a custom agent — Codex rejects it.
{% endif %}

Polygraph connects repos and the agent work happening across them. Its central artifact is the session, which groups the repos, branches, PRs, and CI status for one piece of work and can be shared and resumed: use it to coordinate changes across multiple repos or in a single repoto share the session URL with collaborators, hand off progress via the session description, resume prior work, and watch CI across the session's PRs.

**Polygraph operates on the current repo in place.** Starting or joining a session never clones or modifies the repository you are in — you keep working in your real working directory, and `push_branch` pushes your local commits from that checkout. Only *other* repos are worked on in separate Polygraph-managed clones via `spawn_agent`.

{% if platform == "claude" or platform == "codex" %}

## Sandboxing in Polygraph Sessions

Polygraph **may** run an agent session inside an OS-level sandbox, but not every session is sandboxed — whether it is on depends on the user's config. When it is on, writes are limited to the repository working tree and session root, network access is restricted to allowlisted hosts, and binding a listening socket (dev servers) fails with `EPERM`. The user may not know whether this session is sandboxed.

**When something fails in a sandbox-shaped way** — `EPERM` binding a port, a blocked network host, a denied write to an ordinary path — the sandbox blocked it. Do NOT retry variations, work around it, or route the command through `!`-prefixed user commands (those run in the same sandbox); one failure is enough evidence. Stop, and read [`reference/sandboxing.md`](reference/sandboxing.md) for how to warn the user, the two remediation options (allow the specific operation via committed harness settings, or turn sandboxing off), and the exact per-harness config snippets. Never conclude the repo, tool, or framework is broken based on a sandboxed failure.

{% endif %}

## Available Tools

Polygraph functionality is available via both MCP tools and CLI commands. Use whichever is available in your current environment.

| MCP Tool | CLI Equivalent | Description |
| --- | --- | --- |
| `list_repos` | `polygraph repo list` | Discover candidate repositories. Candidate entries do not include repository descriptions; use `semanticQuery` for natural-language discovery. |
| `start_session` | `polygraph session start --repo <ids>` | Initialize a Polygraph session with selected repositories |
| `spawn_agent` | — | Start a child task, or send a follow-up to an active task, in another repository. A repeat call for the same (repo, role) is delivered to that task as a follow-up; otherwise a new child starts. Roles and resume behavior are under "Multi-turn tasks". |
| `show_agent` | — | Poll one repo's child status (one repo per call; `role` narrows to that agent). Status enum and the poll/state-machine flow are under "Multi-turn tasks". |
| `stop_agent` | — | Cancel an in-progress child; its session is preserved for later read-only context restoration. |
| `push_branch` | — | Push a local git branch to the remote repository. For the repo you are in, this pushes from your current checkout. Requires a session description. |
| `create_pr` | — | Create draft PRs with session metadata linking related PRs |
| `show_session` | `polygraph session show <id> [--details]` | Query status of the current session. Use details when session summary, repo IDs, PR URLs, and PR descriptions are needed. |
| `update_session` | `polygraph session update --session <id> [--title] [--description]` | Update the session title and/or description (at least one required); metadata only, independent of PR creation or mark-ready. |
| `link_reference` | — | Link an external reference to a session. |
| `mark_pr_ready` | — | Mark draft PRs as ready for review |
| `associate_pr` | — | Associate an existing PR with a session |
| `add_repo` | — | Add repositories to a running session (pass exact refs directly, skipping `list_repos`). See "Add Repositories to a Session". |
| `archive_session` | `polygraph session archive <id>` | Archive a session, hiding it from active lists (it can still be resumed) |
| `get_ci_logs` | — | Retrieve full plain-text log for a specific CI job |
| `git_fetch` | `polygraph git fetch` | Fetch git history for a shallow session clone when git fails with "bad object" or missing-commit errors. See "Fetching Git History for Shallow Clones". |
| `login` | `polygraph auth login [--token]` | Authenticate with Polygraph (use `--token` for headless/CI) |
| `logout` | `polygraph auth logout` | Log out of Polygraph |
| `list_sessions` | `polygraph session list` | List sessions. By default only active sessions created by the current git user; pass `recommendedFilters: false` for all sessions. |
| `search_sessions` | `polygraph session search` | Find sessions by free-text `query` OR by commit `sha` — pass exactly one. See "Finding the Session Behind a Commit or Line". |
| `list_accounts` | `polygraph account list` | List available organizations |
| `select_account` | `polygraph account select` | Select the organization that future commands run against |
| `whoami` | `polygraph whoami` | Show current auth status and org |

{% if platform == "claude" or platform == "opencode" %}

**Delegation rules:** `list_repos` and `start_session` MUST be called via the `polygraph-init-subagent` as described in the "Initialize or Join Polygraph Session" section. Direct `add_repo` is allowed only when the user provides exact repo refs for an existing session. `spawn_agent` and `show_agent` MUST ALWAYS be called via {% if platform == "claude" %}background Task subagents (`run_in_background: true`){% else %}`@polygraph-delegate-subagent`{% endif %} as described in the delegation sections below — NEVER call them directly in the main conversation.{% if platform == "claude" %} The subagents are plugin-namespaced: pass `subagent_type: "polygraph:polygraph-init-subagent"` / `"polygraph:polygraph-delegate-subagent"`; fall back to the bare name only if the namespaced form is not found.{% endif %}
{% elsif platform == "codex" %}

**Routing reminder:** Per the Critical Routing Rule above, the parent conversation must use Codex `spawn_agent` with `agent_type: "polygraph-init-subagent"` for new sessions and `agent_type: "polygraph-delegate-subagent"` for repo work — not the Polygraph MCP tools shown in the table. `wait_agent` collects results when needed.
{% endif %}

## CLI Statefulness

The Polygraph CLI (`polygraph`) is **stateful**. When you select an organization — via `polygraph account select` or the equivalent MCP tool — that selection is saved globally and all subsequent CLI commands and MCP tool calls operate against it. You do not need to pass the org on every command.

## Setup

Before using Polygraph tools, ensure the CLI is authenticated and an organization is selected.

### Check Authentication

Use `polygraph whoami` (or the `whoami` MCP tool) before session work to check if the user is currently logged in and which organization is active.

- If the user **is logged in** and an org is selected → proceed to the workflow.
- If auth is **missing, expired, or no org is selected** → stop session work. Do not keep trying session creation, repository discovery, delegation, or CI checks.
- Facilitate user reauth through the browser-based login flow, such as `polygraph auth login` (or the `login` MCP tool). In interactive desktop clients, browser reauth is usually user-driven; surface the need clearly and wait for the user to complete it.
- After login, an organization must be selected. Use `polygraph account select` (or MCP equivalent) when needed.
- Re-run `polygraph whoami` (or `whoami`) after reauth and org selection. Continue only after it confirms a valid login and selected organization.

### Select Organization

After logging in (or if logged in but no org is selected), use `polygraph account select` (or MCP equivalent) to choose the organization that future commands will run against.

## Workflow Overview

The delegate/monitor/stop steps apply only when working across repos. A single-repo session skips them and still benefits from shared progress, resume, and CI visibility.

{% if has_subagents %}

0. **Initialize or join Polygraph session** - If you were spawned inside an existing session (the startup banner names a session ID), reuse it. Call `show_session` first; if it already has repos and the user did not ask to add more, you're done. If the user asks to add exact repo refs, call `add_repo` directly and skip candidate discovery. If the session has no repos and no exact refs were provided, launch the `polygraph-init-subagent` with that `sessionId` so it discovers candidates and uses `add_repo` (NOT `start_session`). Only when there is no session ID at all should the init subagent create a new session.
1. **Delegate work to each repo** - Use the `polygraph-delegate-subagent` to start child agents. With the default role, delegate only to *other* repos — never to the repo you are in; work on it directly (your regular subagents are fine for local work — only Polygraph delegation is reserved for other repos). Delegating into the repo you are in is allowed only with an explicit non-default `role`. Parallel delegation across repos is encouraged. Choose the Simple (fire-and-forget) or Multi-turn (interactive) pattern described below based on whether the child may need clarification.
   {% else %}
2. **Initialize or join Polygraph session** - If you already have a session ID, call `show_session` to fetch details. If the user asks to add exact repo refs, call `add_repo` directly and skip candidate discovery. Otherwise, discover candidate repos, select relevant repositories, and create a new session via `list_repos` and `start_session`.
3. **Delegate work to each repo** - Use `spawn_agent` to start child agents in other repositories (returns immediately). With the default role, delegate only to *other* repos — never to the repo you are in; work on it directly. Delegating into the repo you are in is allowed only with an explicit non-default `role`. Parallel delegation across repos is encouraged. Choose the Simple (fire-and-forget) or Multi-turn (interactive) pattern described below.
   {% endif %}
4. **Monitor child agents** - Use `show_agent` to poll one repo's children (`repo` is required; pass `role` to narrow to one agent) and read each entry's `status` and `lastOutputLines` from the `children[]` array.
5. **Stop child agents** (if needed) - Use `stop_agent` (with `role` when targeting a non-default agent) to cancel an in-progress child agent. The agent's session is preserved for later read-only context restoration; after a resume, wait for explicit user instructions before making changes.
6. **Push branches** - Use `push_branch` after making commits. A required `description` must follow the Session Description Policy.
7. **Create draft PRs** - Use `create_pr` to create linked draft PRs. Always pass `description` following the Session Description Policy.
8. **Associate existing PRs** (optional) - Use `associate_pr` to link PRs created outside Polygraph.
9. **Query PR status** - Use `show_session` to check progress.
10. **Mark PRs ready** - Use `mark_pr_ready` when work is complete.
11. **Archive session** - Use `archive_session` to archive the session when the user requests it.

## Step-by-Step Guide

### Initialize or Join Polygraph Session

There are three cases. Pick exactly one before calling any tool. The case labels are internal routing shorthand — never mention them in anything you show the user.

**Hard rule: if a session ID is already in scope (e.g., the startup banner says "You're in Polygraph session …", or the user passed one or you are provided one by a reminder hook), that session ID is authoritative for this entire conversation. NEVER call `start_session` — doing so creates a brand-new session and orphans the one the parent harness is pointed at. Reuse the existing session via `show_session` and, if needed, `add_repo`.**

**Case A — Existing session, already has repos.** Call `show_session` directly with the known session ID. Skip the init subagent entirely, show the session details (format below), and proceed.

**Case B — Existing session, no repos yet (or user wants to add more).** If the user gives exact repo refs by ID, short name, full name, GitHub `owner/repo` slug, or URL-like slug, call `add_repo(sessionId, repoIds: [...])` directly with those refs. Do NOT call `list_repos`, do NOT ask for candidates, and do NOT launch the init subagent just to resolve those refs. If the user wants discovery/filtering instead, launch the `polygraph-init-subagent`, passing both the existing `sessionId` and `userContext`. The subagent will discover candidates, select relevant repositories, and call `add_repo` against the existing session — it will NOT call `start_session`.

**Case C — No session at all.** Launch the `polygraph-init-subagent` with only `userContext` (no `sessionId`). The subagent will discover candidates and call `start_session` to create a new session.

{% if has_subagents %}

In case B, call `add_repo` yourself when exact repo refs were provided; otherwise the subagent handles discovery and attachment. In case C the subagent handles session creation. In case A you call `show_session` yourself.
{% else %}

In case B, direct exact repo refs go straight to `add_repo`; use `list_repos` only when discovery/filtering is needed. In case C, discover candidate repos using `list_repos`, select relevant repositories, and call `start_session`. In case A, just call `show_session`.
{% endif %}

**Session ID handling:**

- For a new session (case C), `start_session` auto-generates a unique session ID. You do NOT need to pass one.
- For cases A and B, the session ID already exists; reuse it everywhere
- The parent conversation is responsible for detecting an existing session ID from current context, the startup banner, or a user-provided session URL/ID, then passing it explicitly to `polygraph-init-subagent`. The init subagent cannot infer parent session context by itself.
- For a fresh Codex Desktop conversation started with `/polygraph:session-start`, no `sessionId` is expected; launch `polygraph-init-subagent` without `sessionId` so it creates a new session.

The subagent will:

1. Use exact repo refs directly when provided for an existing session; otherwise call `list_repos` to discover available repositories
2. Select relevant repos based on the user context (or include all if uncertain)
3. Either call `start_session` (case C, no `sessionId`) or call `add_repo` against the existing session (case B). It will never call `start_session` when a `sessionId` was provided.
4. Call `show_session` to retrieve session details
5. Return a summary with session URL and repo info

**When the init subagent has just created a brand-new session,** render the session welcome card instead of the session-details block below. Prefer the `session_intro` MCP tool (or the hidden `polygraph session intro -s <sessionId>` via the CLI) — call it with the session ID; it returns the card as markdown. Print the result to the user verbatim as markdown — do NOT wrap it in a code block or reformat it (the logo is pre-fenced; the rest is live markdown). It needs no other input, and you do not need to call `show_session` first. Then continue.

**For an existing session — after `show_session` returns or the init subagent's summary arrives — show the session details:**

**Session:** POLYGRAPH_SESSION_URL

**Repositories in this session:**

- REPO_FULL_NAME

- REPO_FULL_NAME: from the session repository entries
- POLYGRAPH_SESSION_URL: from `polygraphSessionUrl`

### Explore an Existing Session

Use this workflow when the user gives a Polygraph session ID and asks to understand, resume, inspect, or investigate prior work.

**Resume is not a work command.** If the user's intent is to resume, reconnect, or reconstruct a prior Polygraph session, fetch and summarize the restored context, then stop. Do not edit files, push branches, add repos, delegate new work, or continue previous changes until the user explicitly asks for changes. Treat "resume" as context restoration followed by waiting for user instructions.

1. Fetch detailed session context:
   - Prefer `show_session` with `details: true` 
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
7. If the repo to investigate is already part of the session, delegate directly to that repo (unless it is the repo you are in — investigate that one directly).
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

### Finding the Session Behind a Commit or Line

Use this workflow when the user asks which Polygraph session produced, is behind, or changed a particular commit — or a particular line of code. 
**Read [`reference/session-by-commit.md`](reference/session-by-commit.md) before running any lookup.** That reference file holds clear, reliable steps for answering questions related to this.

## Agent roles

A repository in a session can host multiple child agents at once, distinguished by **role**:

- **Omit by default.** Set a `role` only when the user very explicitly asked for a named one, or when a skill the user invoked prescribes one (e.g. `adversarial-review` uses `reviewer`). Never pick one yourself.
- **Purpose.** Roles let independent streams of work run concurrently in one repo — e.g. a default agent implementing a feature while a `reviewer` or `ci-investigator` runs alongside. Each (repo, role) pair has at most one active child.
- **Default role.** An omitted `role` means the default role: `spawn_agent` without `role` starts or follows up with the repo's default-role agent.
- **Logs.** Only default-role agents upload logs to the cloud and appear in the multiplexed log stream (`polygraph session logs`). Inspect non-default agents locally with `polygraph agent attach --role <role>`.

## Simple tasks (fire-and-forget)

Use this pattern when the task is well-defined and the child is not expected to need clarification. It is a single-round delegation: kick it off, poll until terminal, then push branch + create PR.

{% if platform == "claude" %}

Delegate through a background `Task` subagent rather than calling `spawn_agent`/`show_agent` in the main conversation — direct calls flood the context with polling noise. This is a hard requirement, not a suggestion.

1. Launch one background `Task` per repo with `subagent_type: "polygraph:polygraph-delegate-subagent"` and `run_in_background: true`, passing `sessionId`, `repo`, `instruction`, and optional `role`/`context`. The subagent calls `spawn_agent`, then polls `show_agent` via chained `waitForTransitionMs` long-poll calls until terminal.
2. Delegate to several repos in parallel by launching multiple background Tasks at once — one delegation per (repo, role). Read their output files later for progress.
3. Each subagent watches `child.status` on its `children[]` entry (matching its repo and role) and exits at a terminal status — `'completed'`, `'failed'`, or `'cancelled'`.
4. Once all report terminal, continue to `push_branch` + `create_pr`.

To debug a stuck subagent you can call `show_agent` as a one-off, but routine polling belongs in the background subagents.

{% elsif platform == "opencode" %}

**CRITICAL:** `spawn_agent` and `show_agent` MUST ALWAYS be called via `@polygraph-delegate-subagent`, NEVER directly from the main conversation. Direct calls flood the context window with polling noise and degrade the user experience. This is a hard requirement, not a suggestion.

1. For each repo, invoke `@polygraph-delegate-subagent` with `sessionId`, `repo`, `instruction`, optional `role`, and optional `context`. The subagent calls `spawn_agent`, then polls `show_agent` via chained `waitForTransitionMs` long-poll calls until terminal.
2. Delegate to multiple repos in parallel by launching multiple `@polygraph-delegate-subagent` invocations — one delegation per (repo, role) at a time.
3. The subagent watches `child.status` on its delegation's `children[]` entry — the one matching its repo and role — and exits when it sees a terminal status — typically `'completed'` or `'failed'` (and `'cancelled'` if it was stopped).
4. Once all subagents report a terminal status, continue to `push_branch` + `create_pr`.

To debug a stuck subagent you can call `show_agent` as a one-off, but routine polling belongs in the background subagents.

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
    - role: "<optional role>"
    - context: "<optional context>"

    Call the Polygraph MCP spawn_agent for the repo, then poll show_agent via chained waitForTransitionMs long-poll calls until terminal. Return a structured summary with repo, status, session ID, and result text.
  """
)
```

{% endraw %}

2. Delegate to multiple repos in parallel by launching multiple `polygraph-delegate-subagent` instances before waiting for results — one delegation per (repo, role) at a time.
3. The subagent watches `child.status` on its delegation's `children[]` entry — the one matching its repo and role — and exits when it sees a terminal status — typically `'completed'` or `'failed'` (and `'cancelled'` if it was stopped).
4. Collect completed results with `wait_agent` when the main flow needs them, then continue to `push_branch` + `create_pr`.

To debug a stuck subagent you can call `show_agent` as a one-off, but routine polling belongs in the background subagents.

{% else %}

1. Call `spawn_agent` with `sessionId`, `repo`, `instruction`, and optionally `role` for each repo. The call returns immediately.
2. Poll `show_agent` via chained `waitForTransitionMs` long-poll calls (one call per repo — `repo` is required; pass `role` to narrow to one agent); watch `child.status` on the `children[]` entry for your delegation until it reaches a terminal status — typically `'completed'` or `'failed'` (and `'cancelled'` if it was stopped).
3. Review `child.lastOutputLines` for the final log tail.
4. Continue to `push_branch` + `create_pr`.

{% endif %}

Use Simple when the task is well-defined and the child will not need clarification.

## Multi-turn tasks (interactive)

Use this pattern when the child may need clarification, the task is exploratory, or interactive collaboration is desired. The orchestrator exposes paused children via the `'input-required'` status.

1. Call `spawn_agent` with the initial `instruction` (and optionally `role`). Parse the response:

   ```json
   { "taskId": "…", "message": "…", "status": "delegated" }
   ```

2. Poll `show_agent` via chained `waitForTransitionMs` long-poll calls (`repo` is required; pass the same `role` you spawned with to narrow to that agent). The response shape is `{ children: PolygraphChildStatusItem[] }` with one entry per matching agent in that repo. On your delegation's entry, inspect:

   - `child.status` — one of `'created'`, `'in-progress'`, `'input-required'`, `'permission-required'`, `'completed'`, `'failed'`, `'cancelled'` (British double-L on `'cancelled'`).
   - `child.inputRequiredQuestion` — populated only when `child.status === 'input-required'`.
   - `child.lastOutputLines` — recent log tail.
   - `child.repoFullName` — which repo is talking.

   Drive the state machine:

   - `child.status === 'in-progress'` or `'created'` — continue polling.
   - `child.status === 'input-required'` — read `child.inputRequiredQuestion`, surface it to the user verbatim (e.g. "The child agent in `{child.repoFullName}` needs input: {child.inputRequiredQuestion}"), get the answer, then call `spawn_agent` again with the same `repo`, the same `role`, and `instruction: <answer>` — it is routed to that (repo, role)'s active task automatically. Continue polling.
   - `child.status === 'completed'` — read `child.lastOutputLines`, proceed to `push_branch` + `create_pr`.
   - `child.status === 'failed'` — read `child.lastOutputLines`, surface the failure.
   - `child.status === 'cancelled'` — the child was stopped via `stop_agent`; see below.
   - `child.status === 'permission-required'` — the child is waiting on a permission decision; see "Handling permission requests" below.

3. To abort mid-flight, call `stop_agent` with `{ sessionId, repo, role? }`. The response is:

   ```json
   {
     "taskId": "…",
     "state": "cancelled",
     "sessionPreserved": true,
     "output": "…",
     "message": "…"
   }
   ```

   Because `sessionPreserved: true`, the stopped agent's session can be restored later for context. After resuming, do not make changes or continue prior work until the user explicitly asks for changes.

Use Multi-turn when the child may need clarification, the task is exploratory, or interactive collaboration is desired. Otherwise use Simple.

{% if platform == "opencode" %}
<!-- opencode-only gate. Claude and Codex parents handle permission gates via the native
     MCP elicitation dialog and never see permission-required tasks in the polling loop —
     these instructions are noise for them. This gate can be removed once opencode's MCP
     client gains elicitation capability upstream. -->
## Handling permission requests

Child agents running in other repositories may pause and ask the parent agent whether a specific action is permitted. Polygraph exposes this via two wire paths.

**Native path (MCP permission dialog):** If your MCP client supports the permission dialog UI, the user picks directly in that dialog — you (the agent) won't see `permission-required` tasks in that flow.

**Structured fallback path:** When `cloud_polygraph_child_status` reports a task in `permission-required` state, read the `pendingPermission` object on that task, then call `allow_agent` (to grant the requested action) or `deny_agent` (to refuse it) with the `{sessionId, repo, role?}` of the child agent.

### Answering a permission request

The three decisions:

- `allow_agent` with `scope: 'one-time'` — permits the single action only; the child must ask again for the next action of the same type.
- `allow_agent` with `scope: 'session'` — permits the action and remembers that grant for the rest of the child's session; the child will not ask again.
- `deny_agent` — rejects the request; child continues without performing the action.

You always pass the sessionId, repo, optional role, optional reason to the allow/deny tool.

**Fail-closed default:** When you see a task in `permission-required` state, you MUST call either `allow_agent` or `deny_agent`. Failing to call one leaves the gate held open until the child's idle timer fires; the child cannot make progress until you decide.

> **OpenCode caveat:** *OpenCode children sometimes request permissions without specific command/path (target is empty). Dialog says 'session' grant covers ALL `${action}` calls this session — read carefully before granting session scope.*

### Polling for permission-required in the fallback path

When polling `show_agent`, treat `permission-required` like `input-required`:

1. Read `child.pendingPermission` — inspect `harness`, `action`, `target`, `repoFullName`, and `scope`.
2. Surface the request to the user: "Child agent in `{repoFullName}` requests `{scope}` permission to run `{action}` on `{target}`."
3. Obtain the user's decision.
4. Call `allow_agent` (to grant) or `deny_agent` (to refuse) with `{ sessionId, repo, role? }`.
5. Resume polling.
{% else %}
<!-- Claude and Codex parents handle permission gates via the native MCP elicitation dialog
     rendered by polygraph-mcp's show_agent handler. The dialog targets the parent harness's
     own UI, NOT this agent. From the agent's vantage point the gate is transient: a
     `show_agent` poll may briefly see `permission-required` between the child opening the
     gate and the user picking in the dialog. The agent must NOT resolve it itself. -->
## Handling permission requests

Your MCP client supports the native permission dialog. When a child agent requests permission, the dialog renders directly in your UI and the user picks — the decision routes back through `polygraph-mcp` automatically.

**Critical: do NOT call `allow_agent` or `deny_agent` yourself.** If `show_agent` briefly reports a child in `permission-required` state with `pendingPermission` populated, that is a transient state the dialog is in the middle of resolving. Your job is to keep polling — the next poll will see the child back in `in-progress` (or `failed` / `cancelled` if the user denied or dismissed).

If you call `allow_agent` while the dialog is already open, you create a race: the user's pick lands first and the explicit allow fails with `Task <id> is in state 'completed', not 'permission-required'`. The child receives the user's choice; your call is wasted work.

The `allow_agent` and `deny_agent` tools exist for parents whose MCP clients do NOT advertise elicitation capability (opencode TUI today). They are not part of your flow.
{% endif %}

## Publishing and Session Management

### Publish Changes (Push Branches, Create PRs, Mark Ready)

Publishing covers the branch-to-PR flow: `push_branch` (push local commits; must precede PR creation), `create_pr` (linked draft PRs, including fork PRs via `targetRepository`), `mark_pr_ready` (transition drafts to OPEN), and `associate_pr` (link PRs created outside Polygraph).

**Whenever you push a branch, create or associate a PR, or mark PRs ready, read [`reference/publish-changes.md`](reference/publish-changes.md) first.** That reference file holds the full flow.

### Session Description Policy

`description` is user-facing Polygraph session context. It is required for `push_branch`, `create_pr`, and `associate_pr`, and is the primary input to `update_session` (`mark_pr_ready` does not take a description).

**Whenever you write or update a session description, read [`reference/session-description.md`](reference/session-description.md) first.** That reference file holds the full policy.

Use `update_session` directly when the user asks to summarize progress, update the session description, or capture the current state.
Be liberal about updating the session description when you make changes that affect the scope of the session, how logic flows between repos, or anything else important for posterity. Avoid updating it for small implementation details that are not relevant outside of this session. An up-to-date session description matters for maintainability.

### Linked References

Use `link_reference` to link an external reference to the current Polygraph session.

**Parameters:**

- `sessionId` (required): The Polygraph session receiving the linked reference
- `reference` (required): Reference metadata with `type`, `url`, and `label`
- `reference.sessionId` (session references only): The referenced Polygraph session ID when `reference.type` is `session`

When an external resource is mentioned during a Polygraph session and appears relevant to the current work, the parent agent should record it with `link_reference({ sessionId, reference })`. This applies to relevant external resources such as pull requests, GitHub issues, other Polygraph sessions, and Linear issues.

The canonical MCP parameters are `{ sessionId, reference }`. There is no unlink command; `show_session` returns a session's existing links as `session.linkedReferences`.

### Add Repositories to a Session

Use `add_repo` to add repositories to an existing Polygraph session after it has already started.

**Direct-add rule:** When the user provides exact repo refs by ID, short name, full name, GitHub `owner/repo` slug, or URL-like slug, pass those refs directly to `add_repo` and do not call `list_repos` first. Candidate discovery is only for cases where the user does not know the exact repo.

**Not limited to your organization:** repos outside the org — including public open-source repos — can be added by GitHub `owner/repo` slug or URL. Only `list_repos` discovery is org-scoped, so a repo missing from `list_repos` can still be added directly.

### Archive Session

**IMPORTANT: Only call this tool when the user explicitly asks to archive or close the session.** Do not archive sessions automatically as part of the workflow.

Use `archive_session` (CLI: `polygraph session archive <id>`) to archive the session. Archiving only hides the session from active lists — it can still be resumed and interacted with afterwards. It is idempotent — archiving an already-archived session returns success. Pass the optional `clean` flag to also remove the local clones Polygraph created for delegated repos.

**When to call:** all work is finished, PRs are created and marked ready, and the user explicitly confirms they are done with the session.

## Other Capabilities

### Retrieving CI Job Logs

`get_ci_logs` retrieves the full plain-text log for a specific CI job — the drill-in tool for investigating a failed job. **ONLY use it when NO CIPE (CI Pipeline Execution) exists for the PR** (`ciStatus[prId].cipeUrl` is null); when a CIPE exists, use the Nx MCP `ci_information` tool instead, and do NOT fetch or poll the `cipeUrl` over HTTP.

When you need to fetch and read a failed job's log, read [`reference/ci-job-logs.md`](reference/ci-job-logs.md) for the parameters, return shape, and the full flow (identify the job from `externalCIRuns`, call `get_ci_logs`, then `Read` the saved log file).

### Fetching Git History for Shallow Clones

Session repos are shallow (`--depth 1`) clones. When git fails on missing history (`bad object` from `git revert`, `git log`, `git blame`, etc.), call `git_fetch({ sessionId, repo })` and retry. Read [`reference/shallow-clone-history.md`](reference/shallow-clone-history.md) for the CLI form, the `depth`/`refs` options, and the redundant-call behavior.

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
- CIPE_URL: from `ciStatus[prId].cipeUrl` (null if no CIPE — omit the CI Link cell) — a human-facing Nx Cloud link: render it for the user, never fetch, curl, or poll it. CIPE data is only reachable via the Nx MCP `ci_information` tool.
- POLYGRAPH_SESSION_URL: from `polygraphSessionUrl`
- SESSION_DESCRIPTION: from the latest/current item in `description`

## Best Practices

{% if platform == "claude" %}

1. **Delegate via background subagents** — run every `spawn_agent`/`show_agent` through `Task(run_in_background: true)`; direct calls flood the context with polling noise.
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
1. **Always pass `description`** when calling `create_pr`, `associate_pr`, or `update_session` — it is required and must follow the Session Description Policy
1. **Test integration** before marking PRs ready
1. **Coordinate merge order** if there are deployment dependencies
   {% if platform == "opencode" %}
1. **NEVER call `spawn_agent` or `show_agent` directly**. These MUST ALWAYS go through `@polygraph-delegate-subagent`.
   {% elsif platform == "codex" %}
1. **NEVER call the Polygraph MCP `spawn_agent` or `show_agent` directly for routine delegation**. These MUST run inside `polygraph-delegate-subagent`.
   {% endif %}
1. **Use `stop_agent` to clean up** — Stop child agents that are stuck or no longer needed (pass `role` to target a non-default agent). The child's session is preserved (`sessionPreserved: true`) so the context can be restored later, but after resuming you must wait for explicit user instructions before making changes.
