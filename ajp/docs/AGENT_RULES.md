# Agent Rules

This is the exact ruleset AJP injects into your coding agents' instruction files
(`AGENTS.md`, `CLAUDE.md`, etc.) during `npm install` / `ajp setup`. It teaches
any agent how and when to use the shared journal — no MCP, just the `ajp` CLI.

It is written into each file inside a managed block:

```text
<!-- AJP:BEGIN (managed by agent-journal-protocol — do not edit between markers) -->
…rules…
<!-- AJP:END -->
```

Your own content in those files is preserved; only the block between the markers
is managed. Re-running `ajp setup` updates the block in place (idempotent — no
duplication, no churn).

## The rules (verbatim)

### At the start of every session
1. Load context (cheap, one read): `ajp context --level small`
2. Announce yourself (use YOUR name as the actor everywhere):
   `ajp append --type agent.registered --payload '{"name":"<you>"}' --actor "<you>"`

### As you work, record each real action as one event
- Create a task:  `ajp append --type task.created --payload '{"id":"t1","title":"...","priority":"high"}' --actor "<you>"`
- Start a task:   `ajp append --type task.started --payload '{"id":"t1"}' --actor "<you>"`
- Finish a task:  `ajp append --type task.completed --payload '{"id":"t1"}' --actor "<you>"`
- Block a task:   `ajp append --type task.blocked --payload '{"id":"t1","reason":"..."}' --actor "<you>"`
- Record a decision (with a reason): `ajp append --type decision.made --payload '{"id":"d1","title":"Use X","rationale":"why"}' --actor "<you>"`
- Learn a durable fact: `ajp append --type knowledge.learned --payload '{"statement":"..."}' --actor "<you>"`
- Note a changed file: `ajp append --type file.modified --payload '{"path":"src/..."}' --actor "<you>"`

### Reading the journal anytime
- `ajp status` — current goal, active tasks, decisions, agents
- `ajp context --level small|medium|large|full` — compact context for the prompt
- `ajp timeline` — human-readable "what happened"

### The rules
1. **Read before you write.** Run `ajp context` first; never duplicate an active task.
2. **Record decisions immediately**, always with a `rationale`. A decision not in
   the journal does not exist.
3. **One event per real action.** Keep payloads small and factual.
4. **Never edit `.agent/` by hand.** Append-only; to change something, append an event.
5. **Supersede, don't contradict.** Replace an old decision via `decision.made`
   with `"supersedes":"<oldId>"`.
6. **Always pass `--actor "<your name>"`** so the journal knows who did what.
7. End of session: `ajp append --type session.ended --actor "<you>"`.

## Why this works without MCP

Coding agents already read `AGENTS.md` / `CLAUDE.md` / `.cursorrules` / Copilot
instructions automatically at the start of a task. By putting the rules there,
every agent is "onboarded" to the journal for free — and they all coordinate
through the same append-only source of truth.
