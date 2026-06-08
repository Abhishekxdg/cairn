<!-- AJP:BEGIN (managed by agent-journal-protocol — do not edit between markers) -->
## Agent Journal Protocol (AJP) — shared project memory

This project has a shared, append-only memory journal in `.agent/`. It is the
source of truth for goals, tasks, decisions and what every agent has done. Use the
`ajp` command-line tool to read and write it. **Always keep it up to date** so work
survives across sessions and so other agents never duplicate or undo your work.

> NOTE: if `ajp: command not found`, run it as `node /Users/abhishek/Desktop/AgentMem/ajp/bin/ajp.js` instead
> (substitute that for `ajp` in every command below).

### At the start of every session — instant recall
1. **Fastest:** read `.agent/CONTEXT.md` — a tiny, always-current summary (goal,
   current task, decisions, recent activity, next steps). No tool needed.
   Equivalent command: `ajp recall`.
2. Announce yourself (use YOUR name as the actor everywhere):
   `ajp append --type agent.registered --payload '{"name":"<you>"}' --actor "<you>"`

### As you work, record INTENT — the things git cannot know
You do NOT need to log file edits: AJP captures `file.created/modified/deleted`
automatically from git commits (a post-commit hook runs `ajp sync`). Spend your
effort only on intent:
- Create a task:  `ajp append --type task.created   --payload '{"id":"t1","title":"...","priority":"high"}' --actor "<you>"`
- Start a task:   `ajp append --type task.started   --payload '{"id":"t1"}' --actor "<you>"`
- Finish a task:  `ajp append --type task.completed --payload '{"id":"t1"}' --actor "<you>"`
- Block a task:   `ajp append --type task.blocked   --payload '{"id":"t1","reason":"..."}' --actor "<you>"`
- Record a decision (with a reason): `ajp append --type decision.made --payload '{"id":"d1","title":"Use X","rationale":"why"}' --actor "<you>"`
- Learn a durable fact: `ajp append --type knowledge.learned --payload '{"statement":"..."}' --actor "<you>"`

### Reading the journal anytime
- `ajp recall` — the fastest, smallest "where were we" (same as `.agent/CONTEXT.md`)
- `ajp status`   — current goal, active tasks, decisions, agents
- `ajp context --level small|medium|large|full` — compact context for your prompt
- `ajp timeline` — human-readable "what happened"

### Rules (follow these)
1. **Read before you write.** Read `.agent/CONTEXT.md` (or `ajp recall`) first. Do
   not create a task that already exists and is active.
2. **Record decisions immediately**, always with a `rationale`. A decision not in
   the journal does not exist.
3. **One event per real action.** Keep payloads small and factual.
4. **Never edit `.agent/` by hand.** It is append-only; history is the source of
   truth. To change something, append a new event.
   (File changes are captured from git automatically — don't log them yourself.)
5. **Supersede, don't contradict.** When a new decision replaces an old one, use
   `decision.made` with `"supersedes":"<oldId>"` so consumers see one active answer.
6. **Always pass `--actor "<your name>"`** so the journal knows who did what.
7. At the end of a session: `ajp append --type session.ended --actor "<you>"`.

The `.agent/` journal is committed with the repo (its derived caches are
git-ignored automatically). Treat it like shared team memory.

(Reminder: if `ajp` isn't found, run it as `node /Users/abhishek/Desktop/AgentMem/ajp/bin/ajp.js`.)
<!-- AJP:END -->
