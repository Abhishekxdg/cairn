<!-- CAIRN:BEGIN (managed by cairn — do not edit between markers) -->
## Cairn — shared project memory

This project has a shared, append-only memory journal in `.agent/`. It is the
source of truth for goals, tasks, decisions and what every agent has done. Use the
`cairn` command-line tool to read and write it. **Always keep it up to date** so work
survives across sessions and so other agents never duplicate or undo your work.

> NOTE: if `cairn: command not found`, run it as `node /Users/abhishek/Desktop/Cairn/bin/cairn.js` instead
> (substitute that for `cairn` in every command below).

### At the start of every session — instant recall
1. **Fastest:** read `.agent/CONTEXT.md` — a tiny, always-current summary (goal,
   current task, decisions, recent activity, next steps). No tool needed.
   Equivalent command: `cairn recall`.
2. Announce yourself (use YOUR name as the actor everywhere):
   `cairn append --type agent.registered --payload '{"name":"<you>"}' --actor "<you>"`

### As you work, record INTENT — the things git cannot know
You do NOT need to log file edits: Cairn captures `file.created/modified/deleted`
automatically from git commits (a post-commit hook runs `cairn sync`). Spend your
effort only on intent:
- Create a task:  `cairn append --type task.created   --payload '{"id":"t1","title":"...","priority":"high"}' --actor "<you>"`
- Start a task:   `cairn append --type task.started   --payload '{"id":"t1"}' --actor "<you>"`
- Finish a task:  `cairn append --type task.completed --payload '{"id":"t1"}' --actor "<you>"`
- Block a task:   `cairn append --type task.blocked   --payload '{"id":"t1","reason":"..."}' --actor "<you>"`
- Record a decision (with a reason): `cairn append --type decision.made --payload '{"id":"d1","title":"Use X","rationale":"why"}' --actor "<you>"`
- Learn a durable fact: `cairn append --type knowledge.learned --payload '{"statement":"..."}' --actor "<you>"`

### Reading the journal anytime
- `cairn recall` — the fastest, smallest "where were we" (same as `.agent/CONTEXT.md`)
- `cairn status`   — current goal, active tasks, decisions, agents
- `cairn context --level small|medium|large|full` — compact context for your prompt
- `cairn timeline` — human-readable "what happened"

### Before reading code — find the RIGHT files (save tokens)
Instead of grepping blind or reading the whole repo, ask which files a task needs.
It fuses git history (files that change together) with a static code graph
(imports + exported symbols), so it works on a fresh repo too.
- `cairn relevant "<task>"` — ranked files the task most likely touches (`--k N`)
- `cairn context --task "<task>"` — project context + those files + related decisions
- `cairn index` — (re)build the static code graph; runs on `init` and `sync` already
- `cairn watch` — keep the graph fresh on every save (optional long-running)

### Rules (follow these)
1. **Read before you write.** Read `.agent/CONTEXT.md` (or `cairn recall`) first. Do
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
7. At the end of a session: `cairn append --type session.ended --actor "<you>"`.

The `.agent/` journal is committed with the repo (its derived caches are
git-ignored automatically). Treat it like shared team memory.

(Reminder: if `cairn` isn't found, run it as `node /Users/abhishek/Desktop/Cairn/bin/cairn.js`.)
<!-- CAIRN:END -->
