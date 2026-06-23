---
name: await-polygraph-ci
description: Wait for CI to settle across all repos in a Polygraph session, then report results and investigate failures. USE WHEN user says "await polygraph", "wait for polygraph ci", "polygraph ci status", "check polygraph ci", "watch polygraph session", "monitor polygraph".
{% if platform == "claude" %}
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Task
  - AskUserQuestion
  - mcp__plugin_polygraph_polygraph-mcp
  - mcp__plugin_nx_nx-mcp
{% endif %}
---

# Await Polygraph CI

Wait for all CI pipelines in a Polygraph session to reach a stable state (succeeded, failed, etc.), then produce a unified summary. If any pipelines failed, investigate via child agents and present fix options.

Some Polygraph tools have both MCP and CLI equivalents — use whichever is available in your environment. See the polygraph skill's tool table for the full mapping.

## CI status source

CI polling uses the polygraph-mcp `get_ci_status` tool, which returns per-PR CI status directly:

```
get_ci_status(sessionId: "<session-id>")
```

It returns `{ sessionId, prs: [...] }`, where each `prs[]` entry has `prId`, `repositoryId`, `branch`, `url`, `prStatus`, and a `ci` object (`status`, `cipeUrl`, `completedAt`, `selfHealingStatus`, `externalCIRuns`). Use this — **not** `show_session` — for all CI polling. `show_session` remains available for session metadata (e.g., mapping `repositoryId` to a human-readable repo name for display).

## Prerequisite: Nx MCP server (CIPE deep-dive + self-healing)

CIPE failure investigation (`ci_information`) and applying/rejecting self-healing fixes (`update_self_healing_fix`) are **not** polygraph-mcp tools — they are provided by the **Nx MCP server** (`mcp__plugin_nx_nx-mcp`). Before relying on the Phase 4 CIPE deep-dive or the Phase 5 self-healing actions, install the Nx MCP server and verify it is available.

If the Nx MCP server is **not** available, this skill can still:

- Monitor CI to a terminal state (Phases 1–3) via `get_ci_status`, and
- Download and inspect **external-CI** job logs via `get_ci_logs` (a polygraph-mcp tool).

But it **cannot** perform CIPE deep-dives (`ci_information`) or apply self-healing fixes (`update_self_healing_fix`) without the Nx MCP server. If nx-mcp is missing, state this limitation to the user explicitly.

## Phase 1: Session Setup

Fetch per-PR CI status using `get_ci_status`. (Optionally call `show_session` once to map `repositoryId` → human-readable repo name for display.)

**Parameters:**

- `sessionId` (required): The Polygraph session ID

```
get_ci_status(sessionId: "<session-id>")
```

1. Record `monitorStartedAt` = current timestamp (epoch millis).
2. Build a tracking table from the response's `prs[]`. For each entry, map:
   - `repo`: repository display name (from `show_session`, keyed by `repositoryId`; fall back to `branch` if unavailable)
   - `repoId`: `repositoryId` (pass straight to `get_ci_logs`)
   - `prUrl`: `url`
   - `prStatus`: `prStatus` (DRAFT / OPEN / MERGED / CLOSED)
   - `ciStatus`: `ci.status` (may already be a terminal status from a previous run)
   - `cipeUrl`: `ci.cipeUrl` (null if none → external CI or no CI)
   - `cipeCompletedAt`: `ci.completedAt` (epoch millis, null if CIPE is active or absent)
   - `selfHealingStatus`: `ci.selfHealingStatus` (null if none)
   - `jobs`: `ci.externalCIRuns[].jobs` (external-CI job list, used in Phase 4)
   - `firstSeenAt`: current timestamp
3. If `prs[]` is empty, report "No PRs in session" and exit.
4. **Stale detection**: For each PR, determine if its CI status is **stale** — meaning it reflects a previous run, not a current one. A PR's CI status is stale if:
   - `cipeCompletedAt` is non-null AND `cipeCompletedAt < monitorStartedAt` (the CIPE finished before the monitor started)
   - Mark these PRs as `stale: true`
5. Display the initial status table, annotating stale PRs:
   ```
   backend: SUCCEEDED (stale) | frontend: SUCCEEDED (stale) | shared-lib: NOT_STARTED
   ```

## Phase 2: Polling Loop

**Configuration:**

- Timeout: 30 minutes total
- Backoff: 60s → 90s → 120s (cap)
- Circuit breaker: exit after 5 consecutive polls with no status change

**Each poll iteration:**

1. Call `get_ci_status(sessionId: <session-id>)`
2. Update each tracked PR from its matching `prs[]` entry (by `prId` / `repositoryId`): `ciStatus` ← `ci.status`, `cipeUrl` ← `ci.cipeUrl`, `cipeCompletedAt` ← `ci.completedAt`, `selfHealingStatus` ← `ci.selfHealingStatus`, `prStatus`, and `jobs` ← `ci.externalCIRuns[].jobs`
3. **Clear stale flag**: If a PR was marked `stale: true` and its `cipeCompletedAt` has changed (or become null, meaning a new CIPE is active), clear the stale flag — this PR now has fresh CI data.
4. Display status update:
   ```
   [await-polygraph-ci] Poll #N | Elapsed: Xm | Repos: Y total, Z completed
    backend: SUCCEEDED | frontend: FAILED (self-healing: PENDING) | shared-lib: SUCCEEDED (stale)
   ```
   Include `selfHealingStatus` inline when non-null. Annotate stale PRs.
5. Check exclusion rule: if a PR has `prStatus: DRAFT` and `ciStatus: NOT_STARTED` for more than 5 minutes since `firstSeenAt`, mark it as `EXCLUDED` (DRAFT PRs may not trigger CI)
6. Check terminal conditions — a PR is terminal when:
   - It is NOT stale, AND:
     - CI status is `SUCCEEDED`, `CANCELED`, or `TIMED_OUT`, OR
     - CI status is `FAILED` AND there is no active self-healing (i.e., `selfHealingStatus` is null or a final state like `APPLIED`, `REJECTED`, `FAILED`)
   - A `FAILED` PR with `selfHealingStatus` indicating an in-progress fix (e.g., `PENDING`, `IN_PROGRESS`) is NOT terminal — keep polling to track the self-healing outcome
   - A **stale** PR is NOT terminal — keep polling until it gets a fresh CIPE or is excluded
7. **Stale timeout**: If a stale PR remains stale for more than 5 minutes, assume no new CI is expected for it. Clear the stale flag and treat its current status as final.
8. If all non-excluded PRs are terminal → proceed to Phase 3
9. If timeout or circuit breaker hit → proceed to Phase 3 with partial results
10. Otherwise → wait with backoff, then poll again

## Phase 3: Results Analysis

Categorize repos into: succeeded, failed, canceled, timed_out, excluded, in_progress (if timed out).

Display final summary table. When showing self-healing status, distinguish clearly between these states:

- `COMPLETED` = a fix was **generated and verified**, but **NOT yet applied**. Display as `fix available`.
- `APPLIED` = the fix was **applied** by the user or agent. Display as `fix applied, awaiting re-run`.
- `IN_PROGRESS` / `PENDING` = the fix is still being generated. Display as `in progress`.
- `REJECTED` = the fix was rejected. Display as `fix rejected`.
- `FAILED` = self-healing failed to produce a fix. Display as `fix failed`.

```
[await-polygraph-ci] Final Results | Elapsed: Xm
 SUCCEEDED: backend, shared-lib
 FAILED: frontend (self-healing: fix available)
 EXCLUDED: docs (DRAFT, no CI)
```

Include self-healing status for any repo that has one.

- If all succeeded → report success and exit
- If any failed with `selfHealingStatus: APPLIED`, inform the user that the fix was applied and a CI re-run may be in progress or needed
- If any failed with `selfHealingStatus: COMPLETED`, inform the user that a fix is **available but not yet applied**, and offer to apply it
- If any failed → proceed to Phase 4

## Phase 4: Failure Investigation (Child Agent Delegation)

For each repo with `ciStatus: FAILED`, branch on the entry's `ci` object from `get_ci_status`:

- **If `ci.cipeUrl` is non-null** → CIPE is authoritative. Delegate investigation using the Nx MCP `ci_information` tool (requires the Nx MCP server — see the prerequisite note above; if nx-mcp is unavailable, report the CIPE URL but note the deep-dive can't run).
- **If `ci.cipeUrl` is null but `ci.externalCIRuns` exists** → external CI only. Examine failed jobs from `ci.externalCIRuns[].jobs` and use `get_ci_logs(sessionId, repositoryId, jobId)` (a polygraph-mcp tool) for log retrieval, passing `repositoryId` and `jobId` straight from the entry.
{% if platform == "codex" %}

**Codex subagent wrapper:** Use `polygraph-delegate-subagent` to keep the Polygraph MCP `spawn_agent` / `show_agent` polling loop out of the main conversation. For each failed repo, launch a Codex `spawn_agent` with `agent_type: "polygraph-delegate-subagent"` and instructions to perform steps 2-4 below for that repo, then collect completed summaries with `wait_agent` when the main flow needs them. In the steps below, `spawn_agent` and `show_agent` refer to the Polygraph MCP tools that belong inside the Codex subagent.
{% endif %}

1. Display known info from the `get_ci_status` entry before delegating:

   ```
   Repository: frontend
   CI Source: <CIPE or External CI (GitHub Actions)>
   CI Pipeline: <ci.cipeUrl, or GitHub Actions run URL>
   Self-healing: <ci.selfHealingStatus, or "None">
   Investigating failure details...
   ```

2. **Delegate investigation** (non-blocking) — call `spawn_agent` for each failed repo:

   - `sessionId`: the session ID
   - `repo`: the repository name
   - `instruction` (when CIPE exists): Use the Nx MCP `ci_information` tool to investigate the CI failure on this branch (the Nx MCP server must be installed). Return a structured summary with: (1) list of failed task IDs with a one-line error summary each, (2) failure category (Build / Test / Lint / E2E / Infra / Other).
   - `instruction` (when no CIPE, external CI only): The `get_ci_status` entry shows external CI failures with these failed jobs: [list `jobId` + `name` from `ci.externalCIRuns[].jobs` where `conclusion` is `failure`]. Use `get_ci_logs(sessionId, repositoryId, jobId)` to save the log for each failed job to a local file, then use the `Read` tool to examine the log file contents. Return a structured summary with: (1) one-line error summary per failed job, (2) failure category (Build / Test / Lint / E2E / Infra / Other), (3) relevant log excerpts.
   - `context`: Polygraph session monitoring — investigating CI failure for unified summary. The repository ID for this repo is the entry's `repositoryId`.

   Since `spawn_agent` is non-blocking, you can delegate to multiple failed repos in parallel.

3. **Monitor investigation progress** — poll `show_agent` to wait for each child agent to complete:

   ```
   show_agent(sessionId: "<session-id>", repo: "frontend")
   ```

   Poll until the child agent's status indicates completion. Use the `tail` parameter to retrieve recent output lines containing the investigation results.

4. Collect each child agent's response from the status output. If a child agent fails or gets stuck, use `stop_agent` to terminate it and skip that repo.

5. Display failure summary for each repo:

   ```
   Repository: frontend
   CI Pipeline: <cipeUrl>
   Failed Tasks (2):
     - frontend:build → TypeScript error in src/app.tsx:42
     - frontend:test  → 3 test suites failed
   Category: Build + Test failures
   Self-healing: <selfHealingStatus>
   Job Logs: <number of logs retrieved, if any>
   ```

   If CI job logs were retrieved via `get_ci_logs`, include relevant excerpts (error messages, stack traces) in the summary. Keep excerpts concise — only the most relevant lines.

## Phase 5: Fix Planning

1. Group failures by category (Build, Test, Lint, E2E, Infra)
2. Identify cross-repo dependency issues (e.g., shared-lib build failure blocking frontend)
3. Suggest fix order based on dependency graph (upstream repos first)
4. Present next actions to the user based on self-healing status:
   - If any repo has `selfHealingStatus` with an available fix → offer to **apply self-healing** via `update_self_healing_fix(action: "APPLY")` or **reject** it. `update_self_healing_fix` is an **Nx MCP** tool (`mcp__plugin_nx_nx-mcp`) — it requires the Nx MCP server. If nx-mcp is unavailable, report that a fix is available but cannot be applied from here.
   - If self-healing was already applied → offer to **resume monitoring** to watch the re-triggered CI
   - **Delegate fixes**: use Polygraph to send fix instructions to child agents (for repos without self-healing or where self-healing was rejected/failed)
   - **Get more details**: drill into a specific repo's failure
   - **Exit**: done monitoring

## Notes

- This skill does NOT push code directly. The only write action it may take is applying/rejecting a self-healing fix via `update_self_healing_fix`, an **Nx MCP** tool that performs an Nx Cloud operation (not a local code change) and requires the Nx MCP server.
- Both `ci_information` and `update_self_healing_fix` are **Nx MCP** tools (`mcp__plugin_nx_nx-mcp`), not polygraph-mcp tools. Their responses include a `hints` array with contextual guidance (e.g., disclaimers about which CI Attempt was retrieved). Always check and surface non-empty hints.
- All heavy CI data inspection happens in child agents via `spawn_agent` to keep this context window clean.
{% if platform == "codex" %}
- On Codex, the delegate-and-poll loop should run inside `polygraph-delegate-subagent`, and the main conversation should use `wait_agent` only when it needs to collect results.
{% endif %}
- Child agents can use `get_ci_logs` to save CI job logs to local files, but ONLY when no CIPE exists for the PR (`ci.cipeUrl` is null). When a CIPE exists, logs come from the CIPE system via the Nx MCP `ci_information` tool. Job IDs come from `ci.externalCIRuns[].jobs[].jobId` in the `get_ci_status` response. The tool returns a file path (`logFile`) and size (`sizeBytes`) — use the `Read` tool to examine the log content. Logs can be large (100KB+), so only fetch logs for failed or relevant jobs.
- `spawn_agent` is **non-blocking** — it starts the child agent and returns immediately. Use `show_agent` to poll for results and `stop_agent` to terminate stuck agents.
- The `get_ci_status` response is compact and safe to poll from the main agent.
