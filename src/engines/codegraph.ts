import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname, relative, resolve as resolvePath } from "node:path";
import type { EventStore } from "../core/store.js";
import type { CodeNode, CodeGraph, NewEvent } from "../core/types.js";

/**
 * Static code index — the cold-start half of "task → files".
 *
 * Co-occurrence (gitsync history) answers "which files change together", but it
 * is blind on a brand-new repo. This module parses the source itself — imports
 * and exported symbols — so a task resolves to files on day one, with zero
 * commits. Deterministic, regex-level, no LLM, no embeddings: an `import` graph
 * + a symbol index, emitted as `code.indexed` events and folded into a
 * {@link CodeGraph} projection just like every other Cairn view.
 *
 * Languages: the import/export grammar is the JS/TS family today (this repo's
 * language); other files are still indexed (path + language) but contribute no
 * edges until a parser is added. Honest by construction — recall is ~symbol
 * coverage, not 100%.
 */

const JS_TS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const RESOLVE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];
// Never index these — generated, vendored, or binary noise.
const SKIP_DIR = /(^|\/)(node_modules|dist|build|out|coverage|\.git|vendor)(\/|$)/;

function langOf(path: string): string {
  const e = extname(path).toLowerCase();
  if (JS_TS.has(e)) return "js-ts";
  return e ? e.slice(1) : "unknown";
}

// --- parse -------------------------------------------------------------------

const IMPORT_RE = [
  /\bimport\s+[^"';]*?\bfrom\s*["']([^"']+)["']/g, // import x from "y"
  /\bimport\s*["']([^"']+)["']/g,                   // import "y"
  /\bexport\s+[^"';]*?\bfrom\s*["']([^"']+)["']/g,  // export … from "y"
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,           // require("y")
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,            // dynamic import("y")
];

const EXPORT_RE = [
  /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
];

/** Raw specifiers + exported symbols from one source file. */
export function parseModule(content: string): { specifiers: string[]; exports: string[] } {
  const specifiers = new Set<string>();
  for (const re of IMPORT_RE) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) specifiers.add(m[1]!);
  }
  const exports = new Set<string>();
  for (const re of EXPORT_RE) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) exports.add(m[1]!);
  }
  // `export { A, B as C }` — the names a consumer can import.
  const named = /\bexport\s*\{([^}]*)\}/g;
  let nm: RegExpExecArray | null;
  while ((nm = named.exec(content))) {
    for (const part of nm[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/i).pop()!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) exports.add(name);
    }
  }
  if (/\bexport\s+default\b/.test(content)) exports.add("default");
  return { specifiers: [...specifiers], exports: [...exports] };
}

/**
 * Resolve a relative import specifier to an actual tracked repo path. Bare
 * specifiers (`express`, `node:fs`) are external — dropped (no internal edge).
 * Returns the matching path from `known`, or null if unresolved.
 */
export function resolveImport(fromPath: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith(".")) return null; // external / bare specifier
  const baseAbs = resolvePath("/", dirname(fromPath), spec); // virtual-root join
  const base = baseAbs.slice(1); // strip leading "/"
  const candidates = [
    base,
    ...RESOLVE_EXT.map((e) => base + e),
    ...RESOLVE_EXT.map((e) => join(base, "index" + e)),
  ];
  for (const c of candidates) if (known.has(c)) return c;
  // tolerate `.js` specifiers that map to `.ts` source (TS/ESM convention).
  if (/\.[cm]?js$/.test(base)) {
    const stem = base.replace(/\.[cm]?js$/, "");
    for (const e of RESOLVE_EXT) if (known.has(stem + e)) return stem + e;
  }
  return null;
}

// --- index a repo ------------------------------------------------------------

/** List tracked, indexable files (respects .gitignore; skips vendored dirs). */
export function listSourceFiles(root: string): string[] {
  let listed: string[] = [];
  try {
    listed = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
  return listed.filter((p) => !SKIP_DIR.test(p));
}

/** Build a {@link CodeNode} from already-loaded content (pure; no disk read). */
export function nodeFromContent(path: string, content: string, known: Set<string>): CodeNode {
  const lang = langOf(path);
  const node: CodeNode = { path, lang, imports: [], exports: [] };
  if (lang !== "js-ts") return node; // parser is JS/TS today; others: path-only
  const { specifiers, exports } = parseModule(content);
  const imports = new Set<string>();
  for (const spec of specifiers) {
    const r = resolveImport(path, spec, known);
    if (r && r !== path) imports.add(r);
  }
  node.imports = [...imports];
  node.exports = exports;
  return node;
}

/** Build a {@link CodeNode} for one file (path is repo-relative). Reads disk. */
export function indexFile(root: string, path: string, known: Set<string>): CodeNode {
  if (langOf(path) !== "js-ts") return { path, lang: langOf(path), imports: [], exports: [] };
  // Prevent path traversal: ensure the resolved path stays within root.
  const abs = resolvePath(root, path);
  if (!abs.startsWith(resolvePath(root) + "/") && abs !== resolvePath(root)) {
    return { path, lang: langOf(path), imports: [], exports: [] };
  }
  let content = "";
  try {
    if (existsSync(abs) && statSync(abs).isFile()) content = readFileSync(abs, "utf8");
  } catch {
    return { path, lang: langOf(path), imports: [], exports: [] };
  }
  return nodeFromContent(path, content, known);
}

export interface IndexResult { events: NewEvent[]; files: number; edges: number; symbols: number }

/**
 * Index `paths` (default: the whole repo) into `code.indexed` events. Idempotent
 * per content: the event id carries a content hash, so re-indexing an unchanged
 * file is a no-op while a changed file supersedes its prior index. This is what
 * `sync` calls on just the changed files, and `cairn index` calls on everything.
 */
export function indexRepo(root: string, opts: { paths?: string[]; actor?: string } = {}): IndexResult {
  const all = listSourceFiles(root);
  const known = new Set(all);
  const targets = opts.paths ? opts.paths.filter((p) => known.has(p)) : all;
  const events: NewEvent[] = [];
  let edges = 0;
  let symbols = 0;
  for (const path of targets) {
    const node = indexFile(root, path, known);
    edges += node.imports.length;
    symbols += node.exports.length;
    const hash = fnv1a(`${node.imports.join(",")}|${node.exports.join(",")}|${node.lang}`);
    events.push({
      type: "code.indexed",
      id: `codeindex:${path}:${hash}`,
      ...(opts.actor ? { actor: opts.actor } : {}),
      payload: { path: node.path, lang: node.lang, imports: node.imports, exports: node.exports },
    });
  }
  return { events, files: targets.length, edges, symbols };
}

/**
 * Cheap, dependency-free "is this file mid-edit?" check: scan brackets while
 * skipping strings/comments. Unbalanced `{}`/`[]`/`()` or an unterminated
 * string/block-comment ⇒ the file is probably being typed — skip indexing it
 * and wait for the next save. Conservative: false-negatives just defer a re-index.
 */
export function looksParseable(src: string): boolean {
  let depth = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    const nx = src[i + 1];
    if (ch === "/" && nx === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (ch === "/" && nx === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      if (i >= n) return false; // unterminated block comment
      i += 2; continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch; i++;
      while (i < n && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      if (i >= n) return false; // unterminated string
      i++; continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth < 0) return false; }
    i++;
  }
  return depth === 0;
}

/** Re-index a single file's content into a `code.indexed` event (or null if the
 *  content looks mid-edit / unparseable). `known` resolves its imports. */
export function indexOneEvent(
  path: string,
  known: Set<string>,
  content: string,
  actor?: string,
): NewEvent | null {
  if (langOf(path) === "js-ts" && !looksParseable(content)) return null;
  const node = nodeFromContent(path, content, known);
  const hash = fnv1a(`${node.imports.join(",")}|${node.exports.join(",")}|${node.lang}`);
  return {
    type: "code.indexed",
    id: `codeindex:${path}:${hash}`,
    ...(actor ? { actor } : {}),
    payload: { path: node.path, lang: node.lang, imports: node.imports, exports: node.exports },
  };
}

function fnv1a(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// --- derive the graph --------------------------------------------------------

/**
 * Fold `code.indexed` events into a {@link CodeGraph}. Latest event per path
 * wins (stream is seq-ordered); a `file.deleted` drops the node. Reverse
 * `importedBy` edges are computed after, for import-proximity ranking.
 */
export function deriveCodeGraph(store: EventStore): CodeGraph {
  const nodes = new Map<string, CodeNode>();
  for (const ev of store.streamEvents({ includeArchive: true })) {
    const p = ev.payload;
    if (ev.type === "code.indexed") {
      const path = typeof p["path"] === "string" ? p["path"] : null;
      if (!path) continue;
      nodes.set(path, {
        path,
        lang: typeof p["lang"] === "string" ? p["lang"] : "unknown",
        imports: Array.isArray(p["imports"]) ? (p["imports"] as string[]).filter((x) => typeof x === "string") : [],
        exports: Array.isArray(p["exports"]) ? (p["exports"] as string[]).filter((x) => typeof x === "string") : [],
      });
    } else if (ev.type === "file.deleted") {
      const path = typeof p["path"] === "string" ? p["path"] : null;
      if (path) nodes.delete(path);
    }
  }
  const importedBy = new Map<string, string[]>();
  for (const node of nodes.values()) {
    for (const dep of node.imports) {
      if (!nodes.has(dep)) continue; // edge to a now-deleted file → drop
      const arr = importedBy.get(dep) ?? [];
      arr.push(node.path);
      importedBy.set(dep, arr);
    }
  }
  return { nodes, importedBy };
}

/** Convenience: relative-path normalizer so callers can pass abs or rel paths. */
export function toRepoRel(root: string, path: string): string {
  return path.startsWith("/") ? relative(root, path) : path;
}
