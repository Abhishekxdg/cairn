/**
 * The canonical AJP usage rules injected into every coding agent's instruction
 * file. This is what teaches Claude Code / Codex / Cursor / Copilot / Gemini how
 * and when to use the journal — no MCP, just the `ajp` CLI they already can run.
 */

export const BEGIN_MARKER =
  "<!-- AJP:BEGIN (managed by agent-journal-protocol — do not edit between markers) -->";
export const END_MARKER = "<!-- AJP:END -->";

/** The rules block (without markers). */
export const RULES_BODY = `## Agent Journal Protocol (AJP) — shared project memory

This project has a shared, append-only memory journal in \`.agent/\`. It is the
source of truth for goals, tasks, decisions and what every agent has done. Use the
\`ajp\` command-line tool to read and write it. **Always keep it up to date** so work
survives across sessions and so other agents never duplicate or undo your work.

### At the start of every session
1. Load context (cheap, one read):
   \`ajp context --level small\`
2. Announce yourself (use YOUR name as the actor everywhere):
   \`ajp append --type agent.registered --payload '{"name":"<you>"}' --actor "<you>"\`

### As you work, record each real action as one event
- Create a task:  \`ajp append --type task.created   --payload '{"id":"t1","title":"...","priority":"high"}' --actor "<you>"\`
- Start a task:   \`ajp append --type task.started   --payload '{"id":"t1"}' --actor "<you>"\`
- Finish a task:  \`ajp append --type task.completed --payload '{"id":"t1"}' --actor "<you>"\`
- Block a task:   \`ajp append --type task.blocked   --payload '{"id":"t1","reason":"..."}' --actor "<you>"\`
- Record a decision (with a reason): \`ajp append --type decision.made --payload '{"id":"d1","title":"Use X","rationale":"why"}' --actor "<you>"\`
- Learn a durable fact: \`ajp append --type knowledge.learned --payload '{"statement":"..."}' --actor "<you>"\`
- Note a file you changed: \`ajp append --type file.modified --payload '{"path":"src/..."}' --actor "<you>"\`

### Reading the journal anytime
- \`ajp status\`   — current goal, active tasks, decisions, agents
- \`ajp context --level small|medium|large|full\` — compact context for your prompt
- \`ajp timeline\` — human-readable "what happened"

### Rules (follow these)
1. **Read before you write.** Run \`ajp context\` first. Do not create a task that
   already exists and is active.
2. **Record decisions immediately**, always with a \`rationale\`. A decision not in
   the journal does not exist.
3. **One event per real action.** Keep payloads small and factual.
4. **Never edit \`.agent/\` by hand.** It is append-only; history is the source of
   truth. To change something, append a new event.
5. **Supersede, don't contradict.** When a new decision replaces an old one, use
   \`decision.made\` with \`"supersedes":"<oldId>"\` so consumers see one active answer.
6. **Always pass \`--actor "<your name>"\`** so the journal knows who did what.
7. At the end of a session: \`ajp append --type session.ended --actor "<you>"\`.

The \`.agent/\` journal is committed with the repo (its derived caches are
git-ignored automatically). Treat it like shared team memory.`;

/** The full block including markers, ready to write into a file. */
export function rulesBlock(): string {
  return `${BEGIN_MARKER}\n${RULES_BODY}\n${END_MARKER}\n`;
}
