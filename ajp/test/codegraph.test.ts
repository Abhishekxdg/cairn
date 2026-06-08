import { describe, it, expect, afterEach } from "vitest";
import { memStore, cleanupAll } from "./helpers.js";
import { parseModule, resolveImport, deriveCodeGraph, looksParseable, indexOneEvent } from "../src/engines/codegraph.js";

afterEach(cleanupAll);

describe("parseModule", () => {
  it("extracts imports of every form", () => {
    const { specifiers } = parseModule(`
      import a from "./a.js";
      import { b } from "../b";
      import "./side-effect";
      export { c } from "./c";
      const d = require("./d");
      const e = await import("./e");
      import x from "express";
    `);
    expect(specifiers.sort()).toEqual(
      ["../b", "./a.js", "./c", "./d", "./e", "./side-effect", "express"].sort(),
    );
  });

  it("extracts exports of every form", () => {
    const { exports } = parseModule(`
      export function foo() {}
      export async function bar() {}
      export class Baz {}
      export const QUX = 1;
      export type T = string;
      export interface I {}
      export { a, b as renamed };
      export default function () {}
    `);
    expect(exports).toContain("foo");
    expect(exports).toContain("bar");
    expect(exports).toContain("Baz");
    expect(exports).toContain("QUX");
    expect(exports).toContain("T");
    expect(exports).toContain("I");
    expect(exports).toContain("a");
    expect(exports).toContain("renamed"); // the exposed name after `as`
    expect(exports).toContain("default");
  });
});

describe("resolveImport", () => {
  const known = new Set(["src/a.ts", "src/sub/index.ts", "src/b.ts"]);
  it("resolves relative specifiers with extension + index", () => {
    expect(resolveImport("src/main.ts", "./a", known)).toBe("src/a.ts");
    expect(resolveImport("src/main.ts", "./sub", known)).toBe("src/sub/index.ts");
  });
  it("tolerates .js specifiers that map to .ts source", () => {
    expect(resolveImport("src/main.ts", "./b.js", known)).toBe("src/b.ts");
  });
  it("drops external / bare specifiers", () => {
    expect(resolveImport("src/main.ts", "express", known)).toBeNull();
    expect(resolveImport("src/main.ts", "node:fs", known)).toBeNull();
  });
});

describe("looksParseable (mid-edit guard)", () => {
  it("accepts balanced source", () => {
    expect(looksParseable(`function f() { return [1, (2)]; }`)).toBe(true);
  });
  it("ignores brackets inside strings and comments", () => {
    expect(looksParseable(`const s = "a { b ( c"; // ] ) }\n/* { ( */`)).toBe(true);
  });
  it("rejects unbalanced brackets (file being typed)", () => {
    expect(looksParseable(`function f() { return [1,`)).toBe(false);
  });
  it("rejects an unterminated string / block comment", () => {
    expect(looksParseable(`const s = "open`)).toBe(false);
    expect(looksParseable(`/* open comment`)).toBe(false);
  });
});

describe("indexOneEvent (single-file reindex)", () => {
  const known = new Set(["src/a.ts", "src/b.ts"]);
  it("returns a code.indexed event for parseable content", () => {
    const ev = indexOneEvent("src/a.ts", known, `import { x } from "./b"; export function go() {}`)!;
    expect(ev).not.toBeNull();
    expect(ev.type).toBe("code.indexed");
    expect(ev.payload!["imports"]).toEqual(["src/b.ts"]);
    expect(ev.payload!["exports"]).toEqual(["go"]);
  });
  it("returns null for mid-edit content", () => {
    expect(indexOneEvent("src/a.ts", known, `export function go() {`)).toBeNull();
  });
});

describe("deriveCodeGraph", () => {
  it("folds code.indexed events into nodes + reverse edges", () => {
    const s = memStore();
    s.appendEvent({ type: "code.indexed", payload: { path: "src/a.ts", lang: "js-ts", imports: ["src/b.ts"], exports: ["A"] } });
    s.appendEvent({ type: "code.indexed", payload: { path: "src/b.ts", lang: "js-ts", imports: [], exports: ["B"] } });
    const g = deriveCodeGraph(s);
    s.close();
    expect(g.nodes.get("src/a.ts")!.imports).toEqual(["src/b.ts"]);
    expect(g.importedBy.get("src/b.ts")).toEqual(["src/a.ts"]);
  });

  it("latest index per path wins (re-index supersedes)", () => {
    const s = memStore();
    s.appendEvent({ type: "code.indexed", payload: { path: "src/a.ts", lang: "js-ts", imports: [], exports: ["Old"] } });
    s.appendEvent({ type: "code.indexed", payload: { path: "src/a.ts", lang: "js-ts", imports: [], exports: ["New"] } });
    const g = deriveCodeGraph(s);
    s.close();
    expect(g.nodes.get("src/a.ts")!.exports).toEqual(["New"]);
  });

  it("a file.deleted drops the node and its reverse edges", () => {
    const s = memStore();
    s.appendEvent({ type: "code.indexed", payload: { path: "src/a.ts", lang: "js-ts", imports: ["src/b.ts"], exports: ["A"] } });
    s.appendEvent({ type: "code.indexed", payload: { path: "src/b.ts", lang: "js-ts", imports: [], exports: ["B"] } });
    s.appendEvent({ type: "file.deleted", payload: { path: "src/b.ts", commit: "c1" } });
    const g = deriveCodeGraph(s);
    s.close();
    expect(g.nodes.has("src/b.ts")).toBe(false);
    expect(g.importedBy.get("src/b.ts")).toBeUndefined();
  });
});
