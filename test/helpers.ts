import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a fresh temp directory to act as a project root. */
export function tempProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "stated-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

/** Recursively delete a temp project directory. */
export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
