# Migrations

A journal written today must still open in a decade. AJP versions the schema and
applies forward migrations automatically; it never breaks an older journal.

## Model

- `meta.schema_version` records the journal's current format version.
- `MIGRATIONS` (in `core/schema.ts`) is an ordered list of forward migrations:

  ```ts
  { version: 1, description: "...", up: (db) => { /* DDL */ } }
  ```

- On open, `EventStore` runs `migrate(db)`: it applies every migration with
  `version > current` inside a transaction, recording the new version after each.
- Migrations are **idempotent to re-run** (DDL uses `IF NOT EXISTS`) and the
  runner no-ops when already current.

## Applying

Opening any journal migrates it. Explicitly:

```bash
ajp migrate     # → "Migrated schema v0 → v1" or "Already at schema v1"
```

## Rules for authors

1. **Append, never rewrite.** Add a new migration with the next version number.
   Never edit or reorder a released migration — journals in the wild already ran
   it.
2. **Forward-only DDL.** Add tables/columns/indexes; backfill with care. Avoid
   destructive changes; events are immutable, so prefer additive schema.
3. **Payload evolution is per-event.** The event `version` field versions a
   payload shape independently of the database schema. Reducers should tolerate
   old and new payload versions of a type.
4. **Test it.** Add a case to `test/migration.test.ts` proving a blank db and an
   existing-version db both reach the new version, and that re-running is a
   no-op.

## Backward compatibility

A newer binary opening an older journal migrates it forward. An older binary
opening a newer journal will see a higher `schema_version` than it understands;
implementations SHOULD refuse to *write* in that case (to avoid corrupting a
format they don't know) while still being able to *export* events. The JSON
export (`ajp export`) is the stable interchange format across versions.
