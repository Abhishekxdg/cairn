import type { Confidence } from "./types.js";
import { exists, readJson, writeJson, withProjectLock } from "./io.js";
import { statedPaths } from "./paths.js";

/**
 * Project configuration (`.stated/config.json`, optional).
 *
 * Controls how facts decay: the age thresholds that turn a fact `aging` then
 * `stale`, and the opt-in decay policy that can automatically clean decayed
 * memory. The file is optional — a missing file (or missing keys) falls back to
 * {@link DEFAULT_CONFIG}. Decay values of `0` mean "off".
 */

/** Age thresholds (in hours) for a single kind of decaying fact. */
export interface StalenessThresholds {
  /** Older than this many hours since last verify → `aging`. */
  agingHours: number;
  /** Older than this many hours since last verify → `stale`. */
  staleHours: number;
}

/** Opt-in automatic cleanup of decayed memory. All `0` values mean disabled. */
export interface DecayPolicy {
  /** Auto-release file locks older than N hours. `0` = never. */
  lockAutoReleaseHours: number;
  /** Archive completed tasks older than N days into a snapshot. `0` = never. */
  completedTaskArchiveDays: number;
  /** Keep only the most recent N events, archiving the rest. `0` = keep all. */
  eventRetention: number;
}

/** The full, resolved configuration. */
export interface StatedConfig {
  staleness: {
    task: StalenessThresholds;
    lock: StalenessThresholds;
  };
  decay: DecayPolicy;
}

/** Built-in defaults used whenever `config.json` is absent or partial. */
export const DEFAULT_CONFIG: StatedConfig = {
  staleness: {
    task: { agingHours: 24, staleHours: 168 }, // aging > 1d, stale > 7d
    lock: { agingHours: 4, staleHours: 24 }, //   aging > 4h, stale > 1d
  },
  decay: {
    lockAutoReleaseHours: 0,
    completedTaskArchiveDays: 0,
    eventRetention: 0,
  },
};

/** Which decaying kind a threshold set applies to. */
export type DecayKind = "task" | "lock";

/** Deep-merge a partial config over the defaults. */
function merge(partial: DeepPartial<StatedConfig>): StatedConfig {
  const d = DEFAULT_CONFIG;
  const s = partial.staleness ?? {};
  const decay = partial.decay ?? {};
  return {
    staleness: {
      task: { ...d.staleness.task, ...(s.task ?? {}) },
      lock: { ...d.staleness.lock, ...(s.lock ?? {}) },
    },
    decay: { ...d.decay, ...decay },
  };
}

/** Load the resolved configuration for a project (defaults if no file). */
export function loadConfig(root: string): StatedConfig {
  const path = statedPaths(root).config;
  if (!exists(path)) return DEFAULT_CONFIG;
  const raw = readJson<DeepPartial<StatedConfig>>(path, {});
  return merge(raw ?? {});
}

/** Write a configuration file (used by `stated config` / tests). */
export function writeConfig(root: string, config: StatedConfig): void {
  withProjectLock(root, () => {
    writeJson(statedPaths(root).config, config);
  });
}

/** Thresholds for a given decaying kind from a resolved config. */
export function thresholdsFor(
  config: StatedConfig,
  kind: DecayKind,
): StalenessThresholds {
  return kind === "lock" ? config.staleness.lock : config.staleness.task;
}

/** Map an age (ms) to a {@link Confidence} given thresholds. */
export function tierFor(ageMs: number, t: StalenessThresholds): Confidence {
  const hours = ageMs / 3_600_000;
  if (hours >= t.staleHours) return "stale";
  if (hours >= t.agingHours) return "aging";
  return "fresh";
}

/** Recursive `Partial` for tolerant config parsing. */
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
