# Publishing Changes Reference

The branch-to-PR flow: push branches, create draft PRs, mark them ready, associate PRs created outside Polygraph, and update associated PRs. `push_branch`, `create_pr`, and `associate_pr` all require a `description` following the Session Description Policy — read [`session-description.md`](session-description.md) before writing one. `update_pr` does not require a session timeline description.

## Push Branches

Once work is complete in a repository, push the branch using `push_branch`. This must be done before creating a PR.

**If `push_branch` fails, don't guess at the cause.** Report the tool's actual error to the user first. Only once the real cause is clear, offer to fall back to a manual `git push` — let the user decide, rather than falling back unprompted or asserting what a credential/token can or cannot do.

`push_branch` pushes from the local checkout: for the repo you are in, that is your current working directory with your commits; for delegated repos, it is the Polygraph-managed clone the child agent worked in. There is no separate session copy of the current repo.

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

## Create Draft PRs

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

## Mark PRs Ready

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

## Associate Existing PRs

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

## Update an Associated PR

Use the MCP `update_pr` tool to update one PR already associated with the named Polygraph session. Do not use `gh` or call Ocean HTTP directly. `mark_pr_ready` remains a separate operation.

**Parameters:**

- `sessionId` (required): The Polygraph session ID.
- `prUrl` (required): The URL of a PR already associated with the session.
- `title` (optional): Replacement PR title.
- `body` (optional): Replacement user-authored PR body. Pass an empty string to clear it. The managed Polygraph session footer remains server-owned.
- `labels` (optional): A collection update with `mode` and `values`.
- `assignees` (optional): A collection update with `mode` and `values`.

Omitted fields remain unchanged. For `labels` and `assignees`:

- `{ mode: "set", values: [...] }` replaces the complete collection. An empty `values` list clears it. Use `set` only when you intend to replace every value because it can remove labels or assignees applied by humans.
- `add` and `remove` preserve unrelated values and require a non-empty `values` list.

Set the complete label collection and clear the user-authored body:

```
update_pr(
  sessionId: "<session-id>",
  prUrl: "https://github.com/org/repo/pull/123",
  body: "",
  labels: {
    mode: "set",
    values: ["documentation", "release-note"]
  }
)
```

Add an assignee while leaving the title, body, labels, and other assignees unchanged:

```
update_pr(
  sessionId: "<session-id>",
  prUrl: "https://github.com/org/repo/pull/123",
  assignees: {
    mode: "add",
    values: ["octocat"]
  }
)
```

Metadata updates do not require a session timeline `description`.
