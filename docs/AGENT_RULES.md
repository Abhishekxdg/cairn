# Agent Rules

This is the exact ruleset Cairn injects into your coding agents' instruction files
(`AGENTS.md`, `CLAUDE.md`, etc.) during `npm install` / `cairn setup`. It teaches
any agent how and when to use the shared journal — no MCP, just the `cairn` CLI.

It is written into each file inside a managed block:

```text
<!-- CAIRN:BEGIN (managed by cairn — do not edit between markers) -->
…rules…
<!-- CAIRN:END -->
```

Your own content in those files is preserved; only the block between the markers
is managed. Re-running `cairn setup` updates the block in place (idempotent — no
duplication, no churn).

## The rules (verbatim)

### At the start of every session
1. Load context (cheap, one read): `cairn context --level small`
2. Announce yourself (use YOUR name as the actor everywhere):
   `cairn append --type agent.registered --payload '{"name":"<you>"}' --actor "<you>"`

### As you work, record each real action as one event
- Create a task:  `cairn append --type task.created --payload '{"id":"t1","title":"...","priority":"high"}' --actor "<you>"`
- Start a task:   `cairn append --type task.started --payload '{"id":"t1"}' --actor "<you>"`
- Finish a task:  `cairn append --type task.completed --payload '{"id":"t1"}' --actor "<you>"`
- Block a task:   `cairn append --type task.blocked --payload '{"id":"t1","reason":"..."}' --actor "<you>"`
- Record a decision (with a reason): `cairn append --type decision.made --payload '{"id":"d1","title":"Use X","rationale":"why"}' --actor "<you>"`
- Learn a durable fact: `cairn append --type knowledge.learned --payload '{"statement":"..."}' --actor "<you>"`
- Note a changed file: `cairn append --type file.modified --payload '{"path":"src/..."}' --actor "<you>"`

### Reading the journal anytime
- `cairn status` — current goal, active tasks, decisions, agents
- `cairn context --level small|medium|large|full` — compact context for the prompt
- `cairn timeline` — human-readable "what happened"

### The rules
1. **Read before you write.** Run `cairn context` first; never duplicate an active task.
2. **Record decisions immediately**, always with a `rationale`. A decision not in
   the journal does not exist.
3. **One event per real action.** Keep payloads small and factual.
4. **Never edit `.agent/` by hand.** Append-only; to change something, append an event.
5. **Supersede, don't contradict.** Replace an old decision via `decision.made`
   with `"supersedes":"<oldId>"`.
6. **Always pass `--actor "<your name>"`** so the journal knows who did what.
7. End of session: `cairn append --type session.ended --actor "<you>"`.

## Why this works without MCP

Coding agents already read `AGENTS.md` / `CLAUDE.md` / `.cursorrules` / Copilot
instructions automatically at the start of a task. By putting the rules there,
every agent is "onboarded" to the journal for free — and they all coordinate
through the same append-only source of truth.
