import { randomBytes, randomUUID } from "node:crypto";

/**
 * ULID-style identifiers: 48-bit millisecond timestamp + 80 bits of randomness,
 * Crockford base32, 26 chars. Lexicographically sortable by creation time, so
 * event ids sort in roughly the same order as they were appended — useful for
 * idempotency and debugging without consulting `seq`.
 *
 * A monotonic factory guards against two ulids in the same millisecond by
 * incrementing the random component, preserving sort order within a process.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (no I,L,O,U)
const TIME_LEN = 10;
const RAND_LEN = 16;

function encodeTime(now: number): string {
  let mod: number;
  let str = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    mod = now % 32;
    str = ENCODING[mod] + str;
    now = (now - mod) / 32;
  }
  return str;
}

function randomChars(): string {
  const bytes = randomBytes(RAND_LEN);
  let str = "";
  for (let i = 0; i < RAND_LEN; i++) str += ENCODING[bytes[i]! % 32];
  return str;
}

let lastTime = 0;
let lastRand: number[] = [];

function incrementRand(chars: string): string {
  const arr = chars.split("").map((ch) => ENCODING.indexOf(ch));
  for (let i = RAND_LEN - 1; i >= 0; i--) {
    if (arr[i]! < 31) {
      arr[i]!++;
      break;
    }
    arr[i] = 0;
  }
  return arr.map((n) => ENCODING[n]).join("");
}

/** Generate a monotonic ULID. `seedTime` lets tests pin the clock. */
export function ulid(seedTime?: number): string {
  const now = seedTime ?? Date.now();
  let randPart: string;
  if (now === lastTime) {
    const prev = lastRand.map((n) => ENCODING[n]).join("");
    randPart = incrementRand(prev);
  } else {
    lastTime = now;
    randPart = randomChars();
  }
  lastRand = randPart.split("").map((ch) => ENCODING.indexOf(ch));
  return encodeTime(now) + randPart;
}

/** A short prefixed id for derived entities (tasks, decisions, …). */
export function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

/** Current time as ISO-8601. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Calendar date (YYYY-MM-DD) from an ISO timestamp (or now). */
export function dateOf(iso?: string): string {
  return (iso ?? nowIso()).slice(0, 10);
}
