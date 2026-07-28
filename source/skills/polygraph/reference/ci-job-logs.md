# Retrieving CI Job Logs

Use `get_ci_logs` to retrieve the full plain-text log for a specific CI job. This is the drill-in tool for investigating CI failures after identifying a failed job from the session's CI status.

**ONLY use this tool when NO CIPE (CI Pipeline Execution) exists for the PR.** When a CIPE exists (`ciStatus[prId].cipeUrl` is non-null), logs and failure data are available through the CIPE system (Nx Cloud) via the Nx MCP `ci_information` tool — do NOT call `get_ci_logs`, and do NOT fetch or poll the `cipeUrl` over HTTP (it is a browser link for the user, not an API). This tool is specifically for PRs where only external CI runs exist (e.g., GitHub Actions runs without an Nx Cloud CIPE).

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
