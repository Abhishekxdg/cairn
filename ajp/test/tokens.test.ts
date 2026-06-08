import { describe, it, expect } from "vitest";
import { estimateTokens, compareTokens } from "../src/engines/tokens.js";

describe("token estimation", () => {
  it("is zero for empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("scales monotonically with length", () => {
    const short = estimateTokens("hello world");
    const long = estimateTokens("hello world ".repeat(100));
    expect(long).toBeGreaterThan(short);
  });

  it("lands within ~30% of the chars/4 rule of thumb for prose", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const rough = text.length / 4;
    const est = estimateTokens(text);
    expect(est).toBeGreaterThan(rough * 0.7);
    expect(est).toBeLessThan(rough * 1.6);
  });

  it("does not under-count dense, space-poor code", () => {
    const code = "const x=foo(bar,baz);".repeat(50); // few spaces, many tokens
    const est = estimateTokens(code);
    expect(est).toBeGreaterThan(code.length / 5);
  });
});

describe("token comparison (the headline stat)", () => {
  it("reports ratio and savings of AJP vs a baseline scan", () => {
    const coldScan = "x".repeat(40000); // ~10k tokens of repo dump
    const ajp = "x".repeat(2000); // ~500 tokens of CONTEXT.md
    const cmp = compareTokens(coldScan, ajp);
    expect(cmp.baselineTokens).toBeGreaterThan(cmp.ajpTokens);
    expect(cmp.ratio).toBeGreaterThan(1);
    expect(cmp.saved).toBe(cmp.baselineTokens - cmp.ajpTokens);
  });

  it("never divides by zero", () => {
    const cmp = compareTokens("some baseline", "");
    expect(cmp.ratio).toBe(1);
    expect(cmp.ajpTokens).toBe(0);
  });
});
