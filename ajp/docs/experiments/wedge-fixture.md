# Wedge fixture — answer key & scoring sheet

Build it: `node scripts/wedge-fixture.mjs ./wedge-fixture` (regenerates fresh).

The fixture is a small **MailMeld** email-API repo with a **planted, knowable
journal state**. It's designed so a cold agent (no `CONTEXT.md`) can plausibly
fall into traps that an oriented agent avoids.

## The planted state

| Fact | Value | Probes |
|---|---|---|
| Goal | Ship OAuth login | right goal? |
| Active decision | **Use Google OAuth** — *users already have Google accounts* | decision-adherence (don't pick GitHub/Auth0/etc.) |
| Finished task | **Set up Express server** (`t1`, completed) | duplicate-work (don't rebuild the server) |
| In-progress task | **Build `/auth/google` route** (`t2`, active) | correct next action |
| Knowledge | Google OAuth needs the **redirect URI allowlisted** in the Google console | does it know the gotcha code doesn't show? |

The code (`src/server.ts` done, `src/auth.ts` stub) deliberately does **not**
reveal *why* Google was chosen, that the server is considered finished, or the
redirect-URI constraint. Only `CONTEXT.md` carries those.

## Answer key — what "correct" looks like

A correctly-oriented agent should:
1. **Goal:** recognize it's shipping OAuth login.
2. **Next action:** implement `/auth/google` in `src/auth.ts` (finish `t2`).
3. **Decision:** use **Google** OAuth — and *not* re-debate the provider.
4. **No duplicate work:** *not* rebuild/rescaffold the Express server.
5. **Knowledge:** account for the **redirect-URI allowlist** (mentions/handles it).

A cold agent commonly: re-scaffolds the server, picks a different/arbitrary OAuth
provider, or implements Google OAuth without the redirect-URI step.

## Scoring sheet (copy one per run — grade BLIND)

```
Agent: __________   Arm: [ Control | Treatment ]   Task: [ T1 | T2 | T3 ]   Run #: __

1. Oriented to the right goal (ship OAuth login)?          [ Y / N ]
2. Used Google OAuth (respected the decision, no re-debate)? [ Y / N ]
3. Avoided rebuilding the Express server?                  [ Y / N ]
4. Started/targeted /auth/google (the real next step)?     [ Y / N ]
5. Accounted for the redirect-URI allowlist?               [ Y / N ]

Tokens / time to first correct action: __________
Notes: ______________________________________________
Score (Y count, 0–5): ____
```

## Decision rule

For each agent, compare mean Treatment score vs mean Control score across the 3
tasks. **Wedge validated** if Treatment beats Control by ≥1.5 points (of 5) on
**≥3 of the 4 agents**. If not, the orientation content — not the plumbing — is
what needs work (which facts `CONTEXT.md` surfaces, and how it ranks them).

## Why this fixture is fair

- The traps are reachable from the code alone (a cold agent isn't being set up to
  fail artificially — re-scaffolding a server or picking GitHub OAuth are normal
  cold-start moves).
- The winning facts (decision rationale, "server done", redirect-URI) are exactly
  the high-signal, low-token things `CONTEXT.md` exists to carry — so the test
  measures the wedge, not incidental repo trivia.
