import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Active-team membership is SESSION-LOCAL, not journal state: it records which
 * team an agent is currently acting as. Stored as one tiny JSON file per actor
 * under `<root>/.agent/run/chat/`, NOT in the append-only journal (CLAUDE.md
 * rule 4 — the journal is for durable intent, not transient session state).
 */
function dir(root: string): string {
  return join(root, ".agent", "run", "chat");
}
function file(root: string, actor: string): string {
  // Sanitize actor into a safe filename.
  const safe = actor.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(dir(root), `team-${safe}.json`);
}

export function setActiveTeam(root: string, actor: string, team: string): void {
  mkdirSync(dir(root), { recursive: true });
  writeFileSync(file(root, actor), JSON.stringify({ team }), "utf8");
}

export function getActiveTeam(root: string, actor: string): string | undefined {
  const f = file(root, actor);
  if (!existsSync(f)) return undefined;
  try {
    const team = (JSON.parse(readFileSync(f, "utf8")) as { team?: string }).team;
    return team || undefined;
  } catch {
    return undefined;
  }
}

export function clearActiveTeam(root: string, actor: string): void {
  rmSync(file(root, actor), { force: true });
}

/** Path to the per-actor inbox-cooldown timestamp file. */
function cooldownFile(root: string, actor: string): string {
  const safe = actor.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(dir(root), `cooldown-${safe}.json`);
}

/**
 * Returns true if an inbox check is allowed now (last check older than `ms`),
 * and if so records the new check time. Returns false to skip (within cooldown).
 * A zero/absent `ms` always allows.
 */
export function inboxCooldownOk(root: string, actor: string, ms: number): boolean {
  if (!ms || ms <= 0) return true;
  const f = cooldownFile(root, actor);
  const now = Date.now();
  if (existsSync(f)) {
    try {
      const last = (JSON.parse(readFileSync(f, "utf8")) as { ts?: number }).ts ?? 0;
      if (now - last < ms) return false;
    } catch { /* corrupt file → treat as allowed */ }
  }
  mkdirSync(dir(root), { recursive: true });
  writeFileSync(f, JSON.stringify({ ts: now }), "utf8");
  return true;
}

/** Distinct teams that any actor has joined in this repo (from membership files). */
export function listMembershipTeams(root: string): string[] {
  const d = dir(root);
  if (!existsSync(d)) return [];
  const teams = new Set<string>();
  for (const f of readdirSync(d)) {
    if (!f.startsWith("team-") || !f.endsWith(".json")) continue;
    try {
      const team = (JSON.parse(readFileSync(join(d, f), "utf8")) as { team?: string }).team;
      if (team) teams.add(team);
    } catch { /* skip unreadable membership file */ }
  }
  return [...teams];
}
