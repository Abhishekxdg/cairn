import { join } from "node:path";
import type { Framework } from "./types.js";
import { exists, readJson, readText } from "./io.js";

/**
 * Best-effort, dependency-free framework detection.
 *
 * Detection is purely file/heuristic based — no network, no models. It inspects
 * `package.json` dependencies (JS ecosystem) and a handful of well-known marker
 * files (PHP/Python ecosystems). Results are cached into `state.json` so agents
 * can read the project's stack in a single load.
 */

interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Detect frameworks present in the project rooted at `root`. */
export function detectFrameworks(root: string): Framework[] {
  const found = new Set<Framework>();

  // --- JavaScript / TypeScript ecosystem -------------------------------------
  const pkg = readJson<PackageJsonLike>(join(root, "package.json"), {});
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);

  if (has("next")) found.add("Next.js");
  if (has("react") || has("react-dom")) found.add("React");
  if (has("vue") || has("nuxt")) found.add("Vue");
  if (has("@angular/core")) found.add("Angular");
  if (has("express")) found.add("Express");
  if (has("fastify")) found.add("Fastify");

  // --- PHP / Python ecosystems via marker files ------------------------------
  if (exists(join(root, "artisan"))) found.add("Laravel");

  if (exists(join(root, "manage.py"))) found.add("Django");

  const requirements = readText(join(root, "requirements.txt")).toLowerCase();
  const pyproject = readText(join(root, "pyproject.toml")).toLowerCase();
  const pyDeps = `${requirements}\n${pyproject}`;
  if (/(^|[^a-z])django([^a-z]|$)/.test(pyDeps)) found.add("Django");
  if (/(^|[^a-z])flask([^a-z]|$)/.test(pyDeps)) found.add("Flask");

  const composer = readJson<{ require?: Record<string, string> }>(
    join(root, "composer.json"),
    {},
  );
  if (composer.require && composer.require["laravel/framework"]) {
    found.add("Laravel");
  }

  return [...found];
}
