import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractPackageNames,
  packageRegistryAgent,
} from "../src/agents/packageRegistryAgent";
import type { VerificationRequest } from "../src/types";

// ---------------------------------------------------------------------------
// extractPackageNames — JS/TS
// ---------------------------------------------------------------------------
describe("extractPackageNames – JS/TS", () => {
  it("extracts a named ES import", () => {
    const code = `import express from "express";`;
    expect(extractPackageNames(code, "typescript")).toEqual(["express"]);
  });

  it("extracts a side-effect ES import", () => {
    const code = `import "reflect-metadata";`;
    expect(extractPackageNames(code, "javascript")).toContain("reflect-metadata");
  });

  it("extracts a require call", () => {
    const code = `const path = require("path"); const fs = require("fs-extra");`;
    expect(extractPackageNames(code, "javascript")).toContain("fs-extra");
  });

  it("ignores relative imports", () => {
    const code = `
      import foo from "./foo";
      import bar from "../bar";
      const baz = require("./baz");
    `;
    expect(extractPackageNames(code, "typescript")).toEqual([]);
  });

  it("preserves scoped packages as a single token", () => {
    const code = `import { Project } from "@tsomorph/ts-morph";`;
    expect(extractPackageNames(code, "typescript")).toEqual(["@tsomorph/ts-morph"]);
  });

  it("strips sub-path from scoped package", () => {
    const code = `import "@org/pkg/internals";`;
    expect(extractPackageNames(code, "typescript")).toEqual(["@org/pkg"]);
  });

  it("strips sub-path from unscoped package", () => {
    const code = `import "lodash/fp";`;
    expect(extractPackageNames(code, "typescript")).toEqual(["lodash"]);
  });

  it("deduplicates repeated imports", () => {
    const code = `
      import a from "axios";
      const b = require("axios");
    `;
    expect(extractPackageNames(code, "typescript")).toEqual(["axios"]);
  });
});

// ---------------------------------------------------------------------------
// extractPackageNames — Python
// ---------------------------------------------------------------------------
describe("extractPackageNames – Python", () => {
  it("extracts a bare import", () => {
    const code = `import requests`;
    expect(extractPackageNames(code, "python")).toContain("requests");
  });

  it("extracts a from-import", () => {
    const code = `from flask import Flask`;
    expect(extractPackageNames(code, "python")).toContain("flask");
  });

  it("handles multiple imports", () => {
    const code = `
import os
import sys
from pathlib import Path
from numpy import array
    `;
    const pkgs = extractPackageNames(code, "python");
    expect(pkgs).toContain("os");
    expect(pkgs).toContain("sys");
    expect(pkgs).toContain("pathlib");
    expect(pkgs).toContain("numpy");
  });
});

// ---------------------------------------------------------------------------
// packageRegistryAgent — network mocks
// ---------------------------------------------------------------------------
describe("packageRegistryAgent", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeRequest = (code: string): VerificationRequest => ({
    code,
    language: "typescript",
  });

  it("returns CRITICAL finding when npm registry responds 404", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, { status: 404 }) as Response
    );

    const result = await packageRegistryAgent(
      makeRequest(`import { foo } from "totally-fake-pkg-xyz";`)
    );

    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding.severity).toBe("CRITICAL");
    expect(finding.signature).toBe("pkg:totally-fake-pkg-xyz");
    expect(finding.suggestedFix).toMatch(/slopsquatting/i);
  });

  it("passes when npm registry responds 200", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("{}", { status: 200 }) as Response
    );

    const result = await packageRegistryAgent(
      makeRequest(`import express from "express";`)
    );

    expect(result.passed).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it("returns WARNING (not CRITICAL) on network error", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Network failure"));

    const result = await packageRegistryAgent(
      makeRequest(`import express from "express";`)
    );

    expect(result.passed).toBe(true); // no CRITICAL → passed
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("WARNING");
  });

  it("handles multiple packages: one 404 and one 200", async () => {
    vi.mocked(fetch).mockImplementation((url: RequestInfo | URL) => {
      const u = url.toString();
      if (u.includes("fake-hallucinated-pkg")) {
        return Promise.resolve(new Response(null, { status: 404 }) as Response);
      }
      return Promise.resolve(new Response("{}", { status: 200 }) as Response);
    });

    const result = await packageRegistryAgent(
      makeRequest(`
        import express from "express";
        import { x } from "fake-hallucinated-pkg";
      `)
    );

    expect(result.passed).toBe(false);
    expect(result.findings.filter((f) => f.severity === "CRITICAL")).toHaveLength(1);
    expect(result.findings[0].signature).toBe("pkg:fake-hallucinated-pkg");
  });
});
