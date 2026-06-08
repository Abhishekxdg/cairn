# Stated v0.2 — Accuracy & Hardening

> Make Stated stay accurate with near-zero human/agent effort, and make its
> multi-agent coordination claims actually true. For the next agent (or human)
> who inherits a project and must trust what `.stated/` says.

This doc responds to a 32-point cold review. Its first job is to **refuse to
treat all 32 as engineering tasks.** They sort into three buckets, and only one
of them is the product.

## Problem

Stated's value is a brain that any agent can read in one shot to answer "what's
going on, what's next." That value has exactly one failure mode that kills it:
**the brain goes stale and starts lying.** A wrong "Current Task: OAuth" when
OAuth shipped three weeks ago is worse than an empty file — the next agent acts
on false structured data with false confidence.

The root cause is structural, not a bug: **the operator who must write state is
not the beneficiary who reads it.** Claude writes `create_task` / `add_decision`
/ `release_file`; _future_ Claude/Codex benefits. Productivity tools die at this
gap because the writing step is pure tax on the writer. If accuracy depends on a
disciplined operator showing up every time, it won't — agents are exactly the
operator that forgets.

Everything else in the review (locking, event growth, monorepos, parsing) is
solvable engineering. State accuracy is the thesis itself.

## The triage (what we are and aren't fixing)

**Bucket 1 — Bets, not bugs. Do NOT code.** (~11 of 32)
Positioning and market risks no commit can fix:

- Weak single-agent value, hard ROI (#4/5/6) → choose the wedge (parallel-agent
  teams on long-lived projects); accept the smaller TAM rather than diluting.
- "Looks like Mem0 / looks like Jira" (#7/8) → positioning line, not a feature:
  _not memory, not a tracker — the merge layer between agents._
- Vendor clone / standards risk (#9/30) → moat is being the open, in-repo
  standard first; ship and evangelize, don't gold-plate.
- Wrong-bottleneck / humans-don't-work-this-way (#31/32) → philosophical bets we
  take knowingly. Mitigated by Bucket 2 (if capture is automatic, the "unnatural
  structure" objection mostly evaporates — the human never fills a form).

These are decided in this doc and then left alone. Engineering effort spent here
is motion, not progress.

**Bucket 2 — The thesis. Build first.** (#1, #2, #3, #21, #26, #27)
Automatic, accurate state capture + visible staleness. The rest of this doc is
mostly about this.

**Bucket 3 — Hardening. Build to make the multi-agent claim true.** (#10–#25 eng
subset) Bounded, mechanical, listed at the end.

## Personas

| Role        | Persona                                                                                | Job-to-be-done                                                    | Doing today instead                                                                               |
| ----------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Beneficiary | **"Cold Codex"** — an agent (or dev) opening a repo with no prior context, mid-project | Load accurate context in one read and act correctly               | Re-reads the whole codebase + CLAUDE.md, guesses at current state, sometimes redoes finished work |
| Operator    | **"Working Claude"** — the agent actively editing code right now                       | Get its work _recorded_ without spending attention on bookkeeping | Forgets to log; or logs once then drifts; CLAUDE.md goes stale                                    |
| Secondary   | **"Reviewing Human"** — the dev watching two agents work a branch                      | Trust what `.stated/` says enough to not babysit                  | Reads git log + asks each agent what it's doing                                                   |

The whole design pivots on one fact: **Working Claude will not reliably operate
Stated as a separate step.** So we stop asking it to. We make recording a
_side-effect_ of the work it already does (editing, committing), and we make any
fact that _can't_ be auto-verified wear its age so it can never silently lie.

## Workflows

**Happy path — accuracy without effort:**

1. Working Claude starts a session. A `SessionStart` hook auto-runs
   `register_agent` and injects the current handoff into context. Zero prompts.
2. Claude edits `src/auth.ts`. A `PostToolUse` hook auto-claims the file for
   this agent (advisory lock + `lastVerifiedAt = now`). No `claim_file` call.
3. Claude commits. A `post-commit` path (`stated sync`) reads the diff:
   - files in the commit → released + marked touched;
   - the active task, if its target files are now all committed, is flagged
     _likely done_ (not auto-completed — proposed);
   - `lastVerifiedAt` refreshed for everything the commit corroborates.
4. Cold Codex arrives later, reads `handoff.md`. Every fact shows its age and
   confidence: `OAuth — active (verified 2m ago)` vs
   `Payments — active ⚠ (no related edits in 3 weeks — likely stale)`.
5. Codex trusts the fresh facts, treats the stale one as suspect, runs
   `stated sync` to reconcile, picks up real work.

**Unhappy paths (where the product is actually won):**

- **State contradicts git.** Task says active but its files were committed and
  untouched for N commits → `sync` surfaces it as stale and _proposes_ completion;
  it never silently rewrites. Human/agent confirms.
- **Two agents edit the same file in two processes.** Lockfile serializes the
  read-modify-write so neither claim is lost (#10/11). Second claimer sees the
  first owner and is told, not silently overwritten.
- **Conflicting decisions** ("Use BullMQ" vs "Use RabbitMQ"). Decisions get a
  lifecycle: adding a decision that contradicts an active one prompts
  supersession (`supersededBy`), so there is always exactly one _active_ answer
  plus full history (#21).
- **Human hand-edits `goals.md` with odd formatting.** Parser is tolerant and,
  on ambiguity, preserves the raw block rather than dropping it; canonical truth
  for machine-critical data moves to JSON, with Markdown rendered as output (#22).
- **Stale everywhere / abandoned repo.** Handoff leads with a freshness banner:
  "Last verified 3 weeks ago — treat as historical." Stated degrades to _honestly
  old_ instead of _confidently wrong_.

## Features

Each traced to the workflow step + persona it serves.

- **Staleness model** — serves Cold Codex (step 4) + kills the lie (#26/27). Every
  fact (`task`, `decision`, `fileOwnership`, `agent`) carries `lastVerifiedAt` and
  a derived `confidence` (`fresh | aging | stale`) computed from git activity and
  age. Handoff/state render it. _This is the single highest-leverage change._
- **`stated sync`** — serves all personas (step 3/5) + #2. Reconciles claimed
  state against git reality (branch, commits, diff, file mtimes). Proposes, never
  forces, corrections. The accuracy engine.
- **Host hooks (Claude Code first)** — serves Working Claude (steps 1–3) + #1/#3.
  `SessionStart` (register + inject handoff), `PostToolUse` (auto-claim on edit),
  `post-commit` (sync). Makes the operator step vanish. Shipped as
  `stated hooks install`.
- **Decision lifecycle** — serves Reviewing Human + #21. `status: active |
superseded`, `supersededBy`, supersession prompt. Current truth vs history.
- **File locking (real)** — serves multi-agent safety + #10/11. An atomic
  project lock serializes every local read-modify-write mutation. `--force`
  still exists for ownership overrides; visible override audit events remain a
  follow-up.
- **Event compaction** — #23/24/25. Periodic materialized snapshot +
  `events.jsonl` rotation to `snapshots/`; derived caches so ops stop being
  O(history).
- **Derived files out of git** — #16/17. `state.json` + `handoff.md` default to
  `.gitignore` (regenerated on read); opt-in to commit. Kills git churn/conflicts.
- **Scoped + monorepo `.stated`** — #17/13. Nested `.stated` per workspace;
  dir/glob-level ownership claims, not just single files.
- **Schema versioning + migrate** — `version` honored; `stated migrate` upgrades
  old `.stated` dirs.

## Product architecture

- **Entities (changed/new):**
  - `Task` += `lastVerifiedAt`, derived `confidence`; status unchanged.
  - `Decision` += `status: active|superseded`, `supersededBy?`.
  - `FileOwnership` += `lastVerifiedAt`; ownership target may be a glob/dir.
  - `Agent` += stable `id` (not just name) so "Claude #1/#2/#3" are distinct
    (#14); heartbeat reaping for the registry (#15).
  - New `SyncReport` (ephemeral) — the diff between claimed state and git reality;
    drives `stated sync` output. Not persisted.
- **Connections:** the new truth source is **git** (`git log`, `git diff`,
  `git status`, mtimes) read via the existing `Bash`/`child_process` boundary —
  no new storage. Hooks connect to the **host** (Claude Code settings.json hooks,
  git hooks) — the integration surface, not new internal machinery.
- **New machinery (where cost hides):** (1) a git-reading reconciliation layer
  (`src/core/sync.ts`) — must be robust to detached HEAD, shallow clones, no
  commits yet; (2) host-hook installers per agent (`src/hooks/`), Claude Code
  first; (3) a confidence/staleness derivation used everywhere facts render.

## Implementation plan

- **Done — Slice 1 / staleness:** add
  `lastVerifiedAt` + `confidence` to entities and the snapshot; handoff/state show
  age + a freshness banner. Even with manual writes, Stated now _visibly decays
  instead of lying._
- **Done — first `stated sync`:** git reconciliation + `SyncReport` exists and
  proposes review/release actions without auto-applying. Deeper commit/task
  heuristics remain future work.
- **Done — first hardening tranche:** project mutation lock, decision
  supersession lifecycle, derived cache gitignore defaults, and event archive
  manifests.
- **Then — Claude Code hooks:** `stated hooks install` wiring SessionStart /
  PostToolUse / post-commit. This is where the operator step disappears and the
  thesis is actually validated.
- **Then — next hardening tranche:** host hooks → stronger sync heuristics →
  override audit events → agent identity/reaping → monorepo scopes → migrations.
- **Risks / unknowns:**
  - Git reconciliation heuristics: mapping "these files committed" → "this task
    done" is fuzzy. Mitigation: **propose, never auto-apply**; require confirm.
  - Hook portability: Codex/Cursor/OpenHands hook surfaces differ and may not
    exist. Mitigation: ship Claude Code (primary persona) first; `stated sync`
    as a manual fallback everywhere else.
  - Lockfile on network filesystems is unreliable. Mitigation: document; degrade
    to advisory + visible override events.
- **Fits into:** `src/core/` (new `sync.ts`, `staleness.ts`; edits to `tasks.ts`,
  `decisions.ts`, `files.ts`, `agents.ts`, `snapshot.ts`, `io.ts` for locking),
  `src/cli/` (`sync`, `hooks`, `migrate`), `src/hooks/` (new), `src/mcp/` (expose
  `sync`, staleness in `get_state`/`get_handoff`).

## Open questions

- **Auto-apply vs propose for `sync`.** Default is propose. Is there a safe subset
  (e.g. releasing a file already committed by its owner) we can auto-apply with
  zero risk? Likely yes; decide per-rule.
- **Confidence thresholds.** What age / how many intervening commits flips
  `fresh → aging → stale`? Needs a default + per-project override. Start: fresh
  <1 commit & <1 day, stale >5 commits or >7 days.
- **Truth precedence.** When git and `.stated` disagree, git wins for _file/work
  facts_; `.stated` wins for _intent facts_ (goals, decisions) git can't know.
  Confirm this split holds (#28).
- **Hook surfaces for non-Claude agents.** Real today, or `sync`-only until they
  ship hooks? Needs research per host.

## Out of scope (for now)

- **Bucket 1 entirely** — positioning, TAM, vendor moat, "is this the right
  bottleneck." Decided above as bets, not built.
- **Auto-completing tasks without confirmation** — too dangerous; `sync` proposes.
- **CRDT / true concurrent merge of `tasks.json`** — lockfile + append-only events
  cover real cases; CRDT is over-engineering until proven needed.
- **Cloud/sync server, web UI, telemetry** — violates the in-repo, no-network
  core principle. Permanently out.
- **Embeddings / semantic search over state** — the brain is small and structured;
  no models, by design.
