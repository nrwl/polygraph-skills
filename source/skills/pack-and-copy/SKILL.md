---
name: pack-and-copy
description: Validate a publisher package change against consumer repos by building + packing the publisher and installing the tarballs into each consumer, so consumer CI can run against the unmerged change. USE WHEN a publisher repo (e.g. a design system, shared library, SDK) has a pending change that needs to be tested in downstream repos before its version is merged and published. TRIGGER when user says "pack and copy", "pre-release test in consumers", "test this package change in <consumer>", "install the unreleased version into the apps", or "validate this change against <consumer repo>".
{% if platform == "claude" %}
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Task
  - AskUserQuestion
{% endif %}
---

# Pack and Copy

Validate a publisher package change against its consumer repos **before** the publisher's version bump is merged and published. The flow is:

1. Build the publisher package(s) — repo-specific, not automatable.
2. Run `polygraph _pack-and-copy` to pack them and install the tarballs into each consumer, rewriting `package.json` to a `file:` dependency.
3. Commit the consumer changes to a branch, open a PR, and let consumer CI validate the change.

This skill covers **steps 1 and 2**. PR creation / CI monitoring is left to the `polygraph` and `await-polygraph-ci` skills.

## Prerequisites

- An active Polygraph session that includes the publisher repo and one or more consumer repos. If you don't have a session yet, run the `polygraph` skill first to create one.
- The publisher repo's built artifacts are **packable** — i.e. running `npm pack` in the package directory produces a tarball that, when installed, Just Works. If the publisher needs to be built first, you'll need to do that explicitly.

## Phase 1: Identify Publishers and Consumers

Determine which packages are being changed in the publisher, and which consumer repos need to validate the change.

**If the user specified them**, skip to Phase 2.

**Otherwise**, inspect the session and the publisher's change:

1. Call `show_session(sessionId)` to enumerate the repos in the session and their local paths.
2. The **publisher** is usually the current repo (where the change is being made). Look at its `package.json` files to find the packages being shipped — the one being changed, or all packages in a monorepo workspace.
3. The **consumers** are the other repos in the session. Only repos that actually depend on one of the publisher's packages are relevant — the command will auto-skip the rest, but listing them up front keeps the user informed.

Before proceeding, print a short table:

| Publisher package | Publisher path          | Consumer repo | Consumer path     |
| ----------------- | ----------------------- | ------------- | ----------------- |
| @org/tokens       | /path/to/ds/packages/tokens | web-app       | /path/to/web-app |
| @org/button       | /path/to/ds/packages/button | web-app       | /path/to/web-app |

and confirm with the user using `AskUserQuestion` if anything is ambiguous.

## Phase 2: Build the Publisher Packages

**This step is not automatable.** Build commands vary per repo and per package. Ask the user how to build, or inspect the repo for conventions.

Common hints to surface to the user:

- A root-level `package.json` with a `build` script that builds all packages (e.g. `npm run build`, `nx run-many -t build`, `pnpm -r build`).
- Per-package `build` scripts (check each publisher's `package.json`).
- A `prepack` script — if one exists, `npm pack` will run it automatically and you don't need a separate build step.

Run the build. Verify the `dist/` or equivalent output exists in each publisher package directory before proceeding.

**If the build fails**, surface the error to the user and stop. Do not attempt to pack a broken package.

## Phase 3: Pack and Copy

Run the `_pack-and-copy` CLI command, passing a `--pair` for every (publisher, consumer) combination the user wants to test. The command is deterministic: it computes a unique pre-release version, runs `npm pack` in each publisher, copies the tarballs into each consumer's `.polygraph-packages/` directory, rewrites the consumer's `package.json` deps to point at the tarballs via `file:`, and POSTs a summary of published and consumed packages to the Polygraph session so the UI reflects what was packed where.

```bash
polygraph _pack-and-copy \
  --session <session-id> \
  --pair <publisher-path>=<consumer-path> \
  [--pair <publisher-path>=<consumer-path> ...] \
  --json
```

**Notes:**

- `<publisher-path>` is the directory containing the publisher package's `package.json` (not necessarily the repo root — for monorepos, this is `packages/<name>/`).
- `<consumer-path>` is the consumer repo's root (where its `package.json` lives).
- If a consumer doesn't declare a dependency on a publisher's package, that pair is silently skipped for that consumer — the tarball is still produced but not installed there.
- The command is idempotent across reruns within a session: each run produces a new unique version (suffix includes a timestamp) so npm won't serve a cached tarball.
- Consumers' `.polygraph-packages/` dirs are added to `.gitignore` automatically. The `package.json` edits **are** tracked and should be committed on the consumer's branch.

Parse the JSON output to get the `published` and `consumed` summaries. Print them back to the user:

```
Packed:
- @org/tokens  1.4.2 -> 1.4.3-pg.<session>.<timestamp>
- @org/button  2.1.0 -> 2.1.1-pg.<session>.<timestamp>

Installed into:
- web-app: @org/tokens, @org/button
- docs:    @org/tokens
```

## Phase 4: Install in Consumers and Commit

For each consumer that received a tarball:

1. Run `npm install` (or the consumer's package manager equivalent) in the consumer's directory so the lockfile and `node_modules/` reflect the `file:` dep.
2. Commit the `package.json` and lockfile changes on a dedicated branch.
{% if platform == "claude" %}
3. Push the branch and open a draft PR using the `polygraph` skill's `push_branch` + `create_pr` flow — **not** directly. The PR description should explain that this is validating an unmerged publisher change.
{% else %}
3. Push the branch and open a draft PR with a description that explains this is validating an unmerged publisher change.
{% endif %}
4. Once CI results come in (see the `await-polygraph-ci` skill), report back. Do **not** merge any consumer PR opened via this flow — these PRs are for validation only and should be closed once the publisher's real version lands.

## Common Pitfalls

- **Forgetting to build**: `npm pack` packs whatever the package's `files` field points at. If `dist/` is stale or missing, the tarball will be broken. Always rebuild before packing unless a `prepack` script does it.
- **Peer dependency mismatches**: if the publisher bumps a peer dep, consumers that don't satisfy it may fail to install. Surface this to the user.
- **Lockfile churn**: `npm install` after a `file:` swap will change the lockfile. That's expected and should be committed alongside the `package.json` change.
- **Multiple publishers in one repo**: pass one `--pair` per publisher package, using the same consumer path. They'll all be bundled into the same `.polygraph-packages/` dir.

## Related Skills

- `polygraph` — session setup, branch push, PR creation.
- `await-polygraph-ci` — monitor consumer CI after the PRs are opened.
