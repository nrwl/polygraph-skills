# Fetching Git History for Shallow Clones

Session repos are shallow (`--depth 1`) clones, and plain `git fetch --unshallow` fails on private repos (the clone-time credential is not retained).

When git fails on missing history — `bad object` from `git revert`, `git log`, `git blame`, etc. — call `git_fetch({ sessionId, repo })` (CLI: `polygraph git fetch <repo> --session <id> --json`), then retry the git command.

- Defaults fetch the default branch's full history.
- Pass `depth` for a bounded fetch, or `refs` to include extra branches.
- Safe to call redundantly — returns `alreadyComplete: true` when the history is already present.
