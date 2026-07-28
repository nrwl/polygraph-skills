# Sandboxing in Polygraph Sessions

Polygraph launches agent sessions inside an OS-level sandbox by default. Writes are limited to the repository working tree, the session root (`~/.polygraph/sessions/<session-id>/`), the system temp directory, and a few allowlisted directories; network access is restricted to allowlisted hosts. In practice: binding a listening socket is denied (dev servers fail with `EPERM`), localhost servers are unreachable, and writes outside the allowlist are rejected. The user may not know the session is sandboxed.

**Recognize sandbox denials — do not retry or work around them.** When a command fails in a sandbox-shaped way (`EPERM` binding a port, a blocked network host, a denied write to an ordinary path), the sandbox blocked it. Do NOT retry variations, escalate through workarounds, or route the command through `!`-prefixed user commands — those run inside the same sandbox. One failure is enough evidence; stop and inform the user.

**Warn before attempting known-blocked operations.** Before starting a dev server, anything else that listens on a port, or an operation that needs writes or network access outside the allowlist, tell the user up front that it will not work while sandboxing is on and offer the options below instead of attempting it.

**What to tell the user.** Explain that Polygraph runs this session in a sandbox, then present both options. Each takes effect on the next agent launch, so the Polygraph session must be relaunched afterwards:

1. **Keep the sandbox on and allow the specific operation** (preferred). The sandbox belongs to the agent harness, so exceptions live in harness settings committed to the repository; array settings merge with Polygraph's generated allowlist rather than replacing it.

   **If you are the Claude parent** — add writable paths to `.claude/settings.json` (or `.claude/settings.local.json`):

   ```json
   { "sandbox": { "filesystem": { "allowWrite": ["<path>"] } } }
   ```

   The `.claude/` directory is read-only inside the sandbox, so give the user the exact snippet to commit — you cannot apply it yourself.

   **If you are the Codex parent** — add writable roots or network access to `.codex/config.toml`:

   ```toml
   [sandbox_workspace_write]
   network_access = true
   writable_roots = ["<path>"]
   ```

   The `.codex/` directory is read-only inside the sandbox, so give the user the exact snippet to commit — you cannot apply it yourself.

2. **Turn sandboxing off.** The user quits the agent, runs `polygraph config`, toggles **Agent Options → Claude** (or **→ Codex**) **→ sandbox** off (or per-repo under **Repo Options**), and relaunches the Polygraph session. Non-interactive alternative: set `agentOptions.claude.sandbox: false` (or `agentOptions.codex.sandbox: false`, or `repoOptions."org/repo".sandbox: false`) in `~/.polygraph/config.json`. Warn that this removes filesystem isolation — the agent can then write anywhere the OS user can.

**Never blame the tooling.** A sandbox denial means the environment blocked the operation — not that the repo, tool, or framework is broken. Do not record conclusions like "X is unusable" in memory, session descriptions, or messages based on sandboxed failures.
