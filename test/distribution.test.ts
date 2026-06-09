import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/core/version.js";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
  files: string[];
};

describe("distribution metadata", () => {
  it("exports the package version from a single runtime source", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("ships required notices and excludes internal planning docs", () => {
    expect(pkg.files).toContain("NOTICE");
    expect(pkg.files).toContain("!docs/superpowers");
  });
});
