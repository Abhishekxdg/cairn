---
description: Set up a Cairn memory journal in the current repo
---

If this repo has no `.agent/` journal yet, set one up so memory persists across
sessions and agents. Run:

```bash
cairn setup --yes
```

(`--yes` skips the interactive wizard, which can't run inside an agent.) This creates
the `.agent/` journal, teaches the coding agents, installs the git post-commit hook,
and builds the code graph. Then run `cairn recall` to confirm.
