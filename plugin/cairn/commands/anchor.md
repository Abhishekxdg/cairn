---
description: Pin a durable fact into every future Cairn context
arguments:
  - name: fact
    description: The foundational fact to anchor (optionally end with a weight)
    required: true
---

Pin the user's fact so it rides in every future `CONTEXT.md`, ranked by weight and
never trimmed under the token budget. Run:

```bash
cairn anchor "$ARGUMENTS"
```

Use a higher weight for more critical facts (e.g. `--weight 9`). After pinning,
confirm what was anchored and show the current list with `cairn anchors`.
