# Session Description Reference

## Session Description Policy

`description` is user-facing Polygraph session context.

`description` is required for `push_branch`, `create_pr`, and `associate_pr`, and is the primary input to `update_session` (which takes `title` and/or `description`). Metadata updates through `update_pr` do not require a session timeline description, and `mark_pr_ready` does not take one. The Polygraph web app renders the description as Markdown, so use real Markdown headings — not flat `Label:` lines. Use the canonical structured format:

```markdown
## Goal

<what the session is trying to accomplish>

## Current progress

<what has been completed so far, including PR/session state when relevant>

## What worked

<important decisions, approaches, or constraints that future agents should preserve>

## Next steps

<clear next implementation steps>
```

- Do not use a one-line feature summary for final handoff or PR creation in a multi-repo session.
- Keep it concise but durable for a future resumed agent.
- Prefer high-level state over file-by-file changelogs.
- Mention unresolved decisions or risks when they matter.
- In `Next steps`, include only next implementation steps. Do not list routine operational steps such as pushing branches, watching CI, or marking PRs ready.

## Dual audience: humans now, agents later

The description has two readers, and you must write for both:

1. **Humans, in the web UI** — this is the primary surface. The app renders the description as Markdown for people scanning session state.
2. **Agents, later** — the description is also read back by agents reconstructing session history (for example, on resume). They may not have the original working tree, branch, or local environment available.

Because of the second audience, write **durably**:

- Avoid ephemeral or local references (paths, ports, in-progress scratch state) that won't mean anything to a later reader.
- Don't assume the original working tree is available — describe *what* changed and *why* at a level that survives without the diff in front of you.
- Capture decisions and constraints, not just a snapshot of the current terminal.

## Formatting building blocks

Plain text (headings + prose + lists) remains the norm. The blocks below are available when they genuinely add clarity — reach for them only when they earn their place.

### Headings, emphasis, lists

Use the `##` headings from the canonical template. Use **bold**/*italic* for emphasis, and bullet or numbered lists for enumerations. Keep nesting shallow.

### Callouts (GitHub alert syntax)

The app maps each callout to a status color, so pick the right type:

- `> [!WARNING]` / `> [!CAUTION]` — risky migrations, destructive operations, or **required manual steps** a reader must not miss.
- `> [!NOTE]` / `> [!IMPORTANT]` — context, rationale, or a key constraint worth highlighting.
- `> [!TIP]` — an optional helpful pointer.

```markdown
> [!WARNING]
> The auth migration must run before deploying the API repo, or existing sessions are invalidated.
```

### Tables (GFM)

Use a GitHub-Flavored Markdown table only for genuinely tabular data. The polygraph UI already shows per-PR state so avoid that. 

```markdown
| Repo        |  Change Type        |
| ----------- |  ------------------ |
| org/api     |  api functionality  |
| org/web     |  text-only          |
```

### Mermaid diagrams

The app renders fenced ` ```mermaid ` blocks as diagrams. Use one only when it genuinely clarifies session state. Good uses:

- Control or data flow between logic pieces across repos or system components.
- A sequence of changes, or migration order.
- A state machine.

> [!IMPORTANT]
> Do NOT redraw the cross-repo dependency / repository graph. The app already renders the repo-relationship graph for every session, so a repo-relationship diagram in the description is redundant.

Plain text remains the norm; diagrams are optional and never required.

### Code blocks and task lists

Use fenced code blocks for commands, signatures, or short snippets. Use task lists (`- [ ]` / `- [x]`) when tracking discrete remaining work items.

### Links

- Prefer durable external URLs (e.g. GitHub PRs/issues, Linear tickets).
- Do NOT put local or dev links in the description: `localhost`, `127.0.0.1`, and `file://` URLs do not resolve in the UI and are useless to later readers.
- Do NOT put repo-relative file paths (`./foo.ts`, `../bar`) as links — they don't resolve in the UI.
- To attach supplementary references (PRs, issues, other Polygraph sessions, Linear tickets), use the `link_reference` tool instead of inline links. `link_reference` is **supplementary** to the description, not a replacement for it.

## Updating the session description

Before writing:

- Read the current session details.
- Consider the current conversation, child-agent results, PRs, pushed branches, validation, and unresolved decisions.
- If appending a new item, read the current/latest description first and write the full replacement description with the existing items plus the new item.
- If updating or replacing the existing last item, write the resulting state directly.

Write the description using the canonical structured format above. Then call `update_session` or one of the other tools like `create_pr` that take a description as input.
