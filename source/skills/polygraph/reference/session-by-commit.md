# Finding the Session Behind a Commit or Line

Use this workflow when the user asks which Polygraph session produced, is behind, or changed a particular commit — or a particular line of code.

**Given a commit sha.** When the user names a sha, or asks what session is behind a commit, resolve it with `search_sessions` using the `sha` parameter (CLI: `polygraph session search --sha <sha>`):

- Pass **exactly one** of `query` or `sha` — they are mutually exclusive.
- `sha` accepts a full or partial sha, 7-40 hex chars.
- The lookup is exact and one-shot: it returns the session(s) linked to that commit, newest first, scoped to the current org, and only explicit sessions.

```
search_sessions(sha: "a1b2c3d")
# CLI equivalent:
polygraph session search --sha a1b2c3d
```

**Given a line number.** There is no line-number lookup — a line MUST first be resolved to a commit sha with `git blame`, then that sha is fed into the sha lookup:

1. `git blame -L <line>,<line> -- <file>` to get the commit that last touched the line.
2. Pass that sha to `search_sessions(sha: ...)` (or `polygraph session search --sha <sha>`).

**Reading the results.**

- Multiple sessions may match a sha. They come back newest first — pick the most relevant one and report the others if they matter.
- **A "no match" result does NOT prove the commit had no work behind it.** Not every commit is linked to an explicit session: commits pushed directly (rather than via an ingested PR) and gaps in ingestion metadata mean the sha may simply not be recorded, and implicit sessions are never returned. Report "no linked session found for that sha" — never assert that no work exists behind the commit.
