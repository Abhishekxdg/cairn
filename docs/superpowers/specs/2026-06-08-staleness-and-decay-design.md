# Staleness signal + customizable memory decay — design

> Make `.stated/` facts wear their age so the brain can never silently lie, and
> let projects opt into automatic cleanup of decayed memory. Slice 1 of the
> "State Rot" thesis (see `docs/product/stated-accuracy-and-hardening.md`).

## Scope (decided)

- **Staleness signal only** for accuracy — no git verification, no host hooks yet.
- **Freshness clock** (`lastVerifiedAt`) resets on **mutation + explicit `verify`**.
- **Only active/claimed tasks and file locks decay.** Decisions/goals are durable
  intent (no decay); agents already have `liveStatus` (reused, untouched).
- **Thresholds:** hardcoded defaults + optional `.stated/config.json` override.
- **Confidence is display-only everywhere** — never reorders or blocks.
- **Decay = opt-in mutation, default OFF.** Configurable; runs on `stated decay`
  (and is *suggested* by `doctor`), never automatically on writes.

## Data model

- `Task` gains `lastVerifiedAt: string` (ISO-8601). Absent on legacy data → falls
  back to `updatedAt` at read time (zero migration).
- `FileOwnership` gains `lastVerifiedAt: string`. Fallback → `claimedAt`.
- Canonical `tasks.json` / `files.json` store only the timestamp — **no**
  `confidence` field on disk (it is always derived from *now*).
- New `Confidence = "fresh" | "aging" | "stale"`.
- `State.activeTasks[]` / `State.lockedFiles[]` rendered entries gain derived
  `confidence` + `ageMs`. New `State.freshness = { overall, counts, lastActivityAt }`.

## Config (`.stated/config.json`, optional)

```json
{
  "staleness": {
    "task": { "agingHours": 24, "staleHours": 168 },
    "lock": { "agingHours": 4,  "staleHours": 24 }
  },
  "decay": {
    "lockAutoReleaseHours": 0,
    "completedTaskArchiveDays": 0,
    "eventRetention": 0
  }
}
```

- Missing file → all defaults. Missing keys → per-key defaults (deep-merged).
- `decay` values of `0` mean **off**. Not scaffolded on `init` (keep `.stated`
  clean); documented in README.

## Modules

- `src/core/config.ts` — `StatedConfig` type, `DEFAULT_CONFIG`, `loadConfig(root)`
  (deep-merge over defaults), `writeConfig`.
- `src/core/staleness.ts` — `confidenceFor(kind, lastVerifiedAt, now, cfg)`,
  `lastVerifiedOf(task|file)` (with fallback), `ageLabel(ms)`, `summarize(...)`
  for the freshness banner. Pure, `now`-injectable for deterministic tests.
- `src/core/decay.ts` — `applyDecay(root, { apply, now })` → `DecayReport`
  (`{ actions: DecayAction[], applied: boolean }`). Dry-run by default; `apply`
  mutates (auto-release stale locks, archive old completed tasks to
  `snapshots/archive-*`, truncate old events). Emits a `memory_decayed` event.

## Surfaces

- **state.json:** confidence + ageMs per active task / locked file; `freshness`.
- **handoff.md:** top banner (`Freshness: ⚠ 2 stale, 1 aging — last activity
  3 weeks ago` / `✓ all fresh`); inline age on each active task + locked file.
- **status (CLI):** colorize by confidence (stale=red, aging=yellow), dim age.
- **doctor:** one `warn` per stale fact + a hint to `stated verify` / `stated decay`.
- **CLI:** `stated verify <taskId|path>`, `stated decay [--apply]`.
- **SDK:** `verifyTask`, `verifyFile`, `verify(idOrPath)`, `decay({apply})`,
  `getConfig`.
- **MCP:** `verify_fact` tool, `run_decay` tool (dry-run unless `apply: true`).

## Refresh points for `lastVerifiedAt`

- `addTask` / `claimFile` → now (= create time).
- `tasks.mutate()` (claim/start/complete/block/update) and `claimFile` reclaim → now.
- `verifyTask(id)` / `verifyFile(path)` → now, with **no other change**; emit
  `task_updated` / `file_claimed`-style `verified` event.

## New event types

`memory_verified`, `memory_decayed` added to `EventType`.

## Testing

- `staleness.test.ts`: tier boundaries (fresh/aging/stale) per kind; config
  override flips a tier; `ageLabel` formatting; legacy fallback (task w/o
  `lastVerifiedAt` uses `updatedAt`).
- `decay.test.ts`: dry-run reports actions but mutates nothing; `apply` releases a
  stale lock / archives an old completed task; `0` = off = no actions; emits event.
- additions: mutation refreshes `lastVerifiedAt`; `verify` refreshes without
  editing; `buildState` carries `freshness` + per-item confidence; handoff banner
  text; doctor flags a backdated-stale fact.
- Determinism via injected `now`; backdated timestamps written directly.

## Out of scope

- Git verification, host hooks (next slices).
- Auto-decay on write (explicitly rejected — surprise mutation).
- Decay of decisions/goals (durable; lifecycle/supersession is Bucket 3).
