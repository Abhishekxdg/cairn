// Naive-markdown concurrency worker: the way agents coordinate WITHOUT AJP.
// Each writer reads the shared handoff file, appends its line, writes it back —
// a classic unlocked read-modify-write. Run many of these at once and updates
// clobber each other. Usage: node eval-worker-naive.mjs <file> <actor> <count>
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [file, actor, countStr] = process.argv.slice(2);
const count = Number(countStr);

for (let i = 0; i < count; i++) {
  // read-modify-write, no lock — exactly what hand-maintained .md memory does
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, cur + `${actor} note ${i}\n`);
}
process.exit(0);
