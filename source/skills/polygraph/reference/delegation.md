# Delegation Reference

Delegation is the only way to act on a repository other than the one you are in. Polygraph keeps local clones of the other repos in the session, but they are not yours to touch: never `cd` into them, read their files, or run git in them. Everything happens through `spawn_agent` and `show_agent`.

The flow is **pointer-based**. `spawn_agent` hands you a delegation id. A cheap background subagent watches that id and tells you when it stops moving. You then read the answer yourself, once. Nothing re-pastes the brief, and no log lines pass through a middleman.

## The delegation id

`spawn_agent` returns a short id (e.g. `frontend-1`) that names one child run. It is the handle for everything afterwards — polling, reading the result, following up, stopping. The id pins the repo AND the role, so once you have it you never re-specify either.

Keep every id you are given. Losing one means falling back to `repo` + `role` lookups, which are ambiguous the moment a repo hosts more than one agent.

## Spawning

Call `spawn_agent` directly from the main conversation. This is a fast, non-blocking call that returns an id — it is not polling and does not belong in a subagent.

```
spawn_agent(
  sessionId: "<sessionId>",
  repo: "<org/repo-name>",
  instruction: "<the task instruction>",
  role: "<optional role>",
  context: "<optional context>"
)
```

Write the instruction as if to a competent engineer who cannot see your conversation: state the goal, the constraints, and what "done" looks like. The child has its own repo and its own context; it inherits nothing from yours.

Delegate to several repos in parallel by calling `spawn_agent` once per repo before waiting on any of them.

**Own-repo rule.** With the default role, `repo` must be a repository other than the one you are working in — never delegate into your own repo with the default role; work on it directly (ordinary local subagents are fine for that). Delegating into your own repo IS allowed with an explicit non-default `role`, because each (repo, role) pair is a separate agent slot and the child then runs alongside your own default-role work without colliding with it.

## Waiting

For each id, launch one background poller subagent whose entire job is to block until that child stops moving. Give it the `sessionId` and the `id`, and nothing else.

- **Claude Code** — a background `Task` with `subagent_type: "polygraph:polygraph-delegate-subagent"`, `run_in_background: true`, and description `Delegate to <repo>`. Fall back to the bare agent name only if the namespaced form is not found.
- **OpenCode** — invoke `@polygraph-delegate-subagent`.
- **Codex** — launch `agent_type: "polygraph-delegate-subagent"` via Codex's own `spawn_agent`, and collect it with `wait_agent`.

The poller has exactly one tool and cannot read logs. It exits with a few lines naming the repo, the id, and the final status. That message is a doorbell, not a report — it tells you the child is worth reading, and nothing about what the child did.

**Routine polling never happens in the main conversation.** A waited `show_agent` loop run inline floods your context with status noise and is the single largest avoidable cost in a multi-repo session. That is what the poller exists to absorb.

## Reading the result

When a poller exits, read the child's answer yourself with a single **unwaited** `show_agent` — no `waitForTransitionMs`, no `tail`:

```
show_agent(sessionId: "<sessionId>", id: "<id>")
```

`result.text` is the child's final message: what it did, what it found, what it wants you to know. This is the payload. Read it once, in the main conversation, and act on it.

One-off unwaited reads like this are cheap and expected inline. It is the *waiting* that belongs in a subagent, not the reading.

## When the result is not enough

Only if `result.text` is missing, truncated, or the child failed in a way you cannot explain from it:

- Pass an explicit `tail` to `show_agent` to pull recent log lines.
- Page further back through the log with additional explicit calls.
- Attach to the run locally with `polygraph agent attach <repo>` (add `--role <role>` for a non-default agent).

These are deliberate, targeted follow-ups. None of them belongs in a polling loop, and none of them is a reason to go looking at transcript files, `~/.polygraph/sessions`, or anything a harness saved to disk because a tool result was too large. `show_agent` is the supported interface.

## Follow-ups

To send a child more work, call `spawn_agent` again with the SAME `repo` and the SAME `role`. If that (repo, role) still has a live task — working, or paused waiting on you — the orchestrator delivers your instruction to it as a follow-up instead of starting a second run. A (repo, role) pair therefore has at most one active child at a time.

A follow-up returns a **new** delegation id, linked to the previous one by a `continues` reference. The new id is the live handle: poll it, read it, follow up on it. The old id still addresses the earlier turn if you need to look back at it.

After a follow-up, launch a fresh poller subagent for the new id. The old poller has already exited; it does not resume.

## Input-required

When a child needs an answer from you, it stops and the poller exits with status `input-required` and "needs attention."

Read the child with an unwaited `show_agent` as usual. `inputRequiredQuestion` carries the child's verbatim question. Surface it to the user as the child asked it — do not paraphrase or answer on the user's behalf — then send the answer back as an ordinary follow-up `spawn_agent` for the same (repo, role). Poll the new id it returns.

`permission-required` is a different state and is not yours to resolve here; see "Handling permission requests" in the skill.

## Roles

A repository in a session can host several child agents at once, distinguished by **role**:

- **Omit by default.** Set a `role` only when the user very explicitly asked for a named one, or when a skill the user invoked prescribes one (e.g. `adversarial-review` uses `reviewer`). Never invent one.
- **Purpose.** Roles let independent streams of work run concurrently in one repo — a default agent implementing a feature while a `reviewer` or `ci-investigator` runs alongside. Each (repo, role) pair has at most one active child.
- **Default role.** An omitted `role` means the default role: `spawn_agent` without `role` starts or follows up with that repo's default-role agent.
- **Ids pin the role.** A delegation id already identifies one (repo, role) pair, so `show_agent` and `stop_agent` by id need no `role` argument. Pass `role` only when addressing an agent by `repo` instead of by id.
- **Logs.** Only default-role agents upload logs to the cloud and appear in the multiplexed stream (`polygraph session logs`). Inspect non-default agents locally with `polygraph agent attach <repo> --role <role>`.

## Stopping

Cancel a running child by id:

```
stop_agent(sessionId: "<sessionId>", id: "<id>")
```

The response reports `sessionPreserved: true`: the stopped agent's session is kept so its context can be restored later. Restoring is read-only. After a resume, do not continue the prior work or make further changes until the user explicitly asks for them.

## Before publishing

Every delegation must reach a terminal status — `completed`, `failed`, or `cancelled` — before you push branches or open PRs. A poller exiting on `input-required` is not terminal; it means the child is still waiting on you.
