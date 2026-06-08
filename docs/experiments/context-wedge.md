# Experiment: does `.agent/CONTEXT.md` make a cold agent materially better?

**The wedge question** (verbatim from review): *Can Claude Code, Codex, Cursor and
OpenHands all become materially better after reading only `.agent/CONTEXT.md`?*

This doc separates three kinds of answer honestly:

1. **Real evidence** — a natural A/B that already happened on an external agent.
2. **Proxy measurement** — orientation token cost, computable now.
3. **Reproducible protocol** — how to get hard behavioral numbers on real agents.

We do **not** A/B an agent against itself and call it evidence; that's theater.

---

## 1. Real evidence — the Codex natural experiment

Same external agent (Codex), same repo, same prompt ("where were we?"), two runs
that differed only in whether it could read the journal / `CONTEXT.md`:

| | Run A — no journal access | Run B — with CONTEXT.md (+ path fallback) |
|---|---|---|
| Time to orient | **24 s** | **17 s** |
| What it did | `cairn` missing → "scanning docs/tests to infer", explored 6 files | "Using Cairn project memory. Reading current context" |
| Orientation result | **WRONG** — reconstructed the *Stated v0.2* work from the dirty tree (not this project) | **CORRECT** — "Ship Cairn v0.1", the SQLite-WAL decision *with its reason*, the next step |
| Duplicate/wrong-work risk | High — it was about to act on the wrong project | None — it joined cleanly and registered itself |

**Finding:** without the journal, a capable agent oriented to the *wrong project*
and burned more time doing it. With `CONTEXT.md`, it oriented correctly and
faster. That is the wedge working on a real third-party agent — the strongest
signal we have.

## 2. Proxy measurement — orientation token cost

`npm run wedge` (or `node scripts/wedge-eval.mjs`) measures, on the current repo,
the tokens to orient **with** `CONTEXT.md` (one ~1 KB read) versus the blind
reconstruction a cold agent does **without** it (git log + the recently-changed
files — mirroring the observed Codex behavior).

Measured on this repo:

```
WITH .agent/CONTEXT.md   136 tokens   (1 file read)
WITHOUT (reconstruct)    13,965 tokens (git log + 6 files)
ratio                    ~103x cheaper with CONTEXT.md
```

And the decisive part isn't the ratio — it's that `CONTEXT.md` carries the
**goal, active decisions + their rationale, and the recommended next action**,
which a cold agent **cannot reliably reconstruct from code at any token cost**
(git log shows *what* changed, never *why it was decided*).

Caveat: this is a cost/coverage proxy, not a behavioral outcome. It bounds the
"cheaper + more complete" claim; it does not by itself prove "materially better."

## 3. Reproducible protocol — the real behavioral A/B

Run this on real agents (Codex, Claude Code, Cursor, OpenHands) to get hard
numbers. Each agent, fresh session, **one** task, two arms:

- **Arm Control:** open the repo, no hint. Prompt: *"Continue this project."*
- **Arm Treatment:** same, but first line: *"Read `.agent/CONTEXT.md`, then
  continue this project."*

Use a repo with a **planted, knowable state**: an in-progress task, a recorded
decision with a reason, and one already-finished piece of work.

**Score each run (blind, by a human) on:**

| Metric | How to measure | Wedge wins if Treatment… |
|---|---|---|
| Time / tokens to first correct action | wall clock or token meter | lower |
| Oriented to the right goal? | yes/no | more often yes |
| Respected the recorded decision? | did it re-litigate or contradict it? | respected it |
| Duplicated finished work? | did it redo the done piece? | did not |
| First action correct? | matches the planted next step | more often yes |

**Decision rule:**
- Treatment materially better on ≥3 of 5 across ≥3 agents → **wedge validated**;
  build the knowledge-capture layer next.
- No consistent lift → orientation isn't the problem; fix `CONTEXT.md`'s content
  (what facts, how ranked) before building any more infrastructure.

**Sample size:** 3 agents × 3 tasks × 2 arms = 18 runs. A weekend, not a quarter.

---

## Status

- ✅ Real evidence (Codex natural A/B): wedge worked once, on a third-party agent.
- ✅ Proxy (token cost): ~100× cheaper + carries facts code can't.
- ⏳ Behavioral A/B (protocol above): **not yet run** — this is the validation
  that turns "promising" into "proven." Run it before building v2.
