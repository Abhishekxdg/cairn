# Event Model

Every change to a project is an event. This is the canonical catalogue. All
payload fields are JSON. `id` in a payload sets the derived entity's id; when
omitted the event's own ULID is used (keeping replay deterministic).

## Agents

| Type | Payload | Effect |
|---|---|---|
| `agent.registered` | `{ name, type?, version?, capabilities?, session? }` | Adds/updates an agent; liveness → active |
| `agent.heartbeat` | `{ name, session? }` | Refreshes `lastSeen` |
| `agent.disconnected` | `{ name }` | Liveness → offline |

## Goals

| Type | Payload | Effect |
|---|---|---|
| `goal.created` | `{ id?, title, description? }` | Adds a goal (status active) |
| `goal.updated` | `{ id, title?, description? }` | Edits a goal |
| `goal.archived` | `{ id }` | Status → archived |

## Tasks

| Type | Payload | Effect |
|---|---|---|
| `task.created` | `{ id?, title, description?, priority?, owner?, dependencies?, createdBy? }` | Adds a task (status todo) |
| `task.started` | `{ id, owner? }` | Status → active; sets owner |
| `task.blocked` | `{ id, reason? \| blocker? }` | Status → blocked; appends blocker |
| `task.completed` | `{ id, completedBy? }` | Status → completed |
| `task.archived` | `{ id }` | Status → archived |

## Decisions

| Type | Payload | Effect |
|---|---|---|
| `decision.made` | `{ id?, title, rationale?, supersedes?, madeBy? }` | Adds an active decision; if `supersedes`, flips that decision to superseded |
| `decision.superseded` | `{ id, by? }` | Marks a decision superseded |
| `decision.reverted` | `{ id }` | Status → reverted |
| `decision.archived` | `{ id }` | Status → archived |

## Files

| Type | Payload | Effect |
|---|---|---|
| `file.read` | `{ path }` | Recorded (no state change) |
| `file.created` | `{ path, owner? }` | Ownership set to actor |
| `file.modified` | `{ path, owner? }` | Ownership = last writer |
| `file.deleted` | `{ path }` | Ownership removed |

## Artifacts

| Type | Payload |
|---|---|
| `artifact.created` / `artifact.updated` / `artifact.deleted` | `{ id, path?, kind? }` |

Artifacts are large outputs stored under `.agent/artifacts/` and referenced by
events rather than embedded in the journal.

## Knowledge

| Type | Payload | Effect |
|---|---|---|
| `knowledge.learned` | `{ id?, statement, source? }` | Adds valid knowledge |
| `knowledge.invalidated` | `{ id }` | Marks knowledge invalid |

## Memory

| Type | Payload | Effect |
|---|---|---|
| `memory.recorded` | `{ id?, content, tags? }` | Adds a memory entry |
| `memory.archived` | `{ id }` | Hides the memory from `deriveMemory` |

## Sessions / context / messages / snapshots

| Type | Payload |
|---|---|
| `session.started` / `session.ended` | `{ reason? }` |
| `context.generated` | `{ level, asOfSeq }` |
| `message.sent` / `message.received` | `{ to?, from?, content? }` |
| `snapshot.created` | `{ seq, snapshotId }` |

## Extensions

Any `custom.*` (or otherwise namespaced) type is valid and is stored verbatim.
Consumers MUST ignore unknown types. Add a payload schema under `.agent/schemas/`
to document a custom type for collaborators.
