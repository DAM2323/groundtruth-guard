import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { rmSync, existsSync } from "fs";

// ---------------------------------------------------------------------------
// Redirect the DB to a temp file BEFORE importing patternStore, so every test
// run uses an isolated database.
// ---------------------------------------------------------------------------
const TEST_DB = path.join(process.cwd(), "data", "test-patterns.sqlite");
process.env.PATTERN_DB_PATH = TEST_DB;

// Now import (the module reads PATTERN_DB_PATH at call time via getDbPath())
import {
  recordConfirmedHallucination,
  findMatchingPatterns,
  bumpPattern,
  listKnownPatterns,
  _resetDb,
} from "../src/memory/patternStore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanDb() {
  _resetDb();
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("patternStore", () => {
  beforeEach(cleanDb);
  afterEach(cleanDb);

  // -------------------------------------------------------------------------
  it("inserts a new pattern and retrieves it", () => {
    recordConfirmedHallucination(
      "charges.createRefund(",
      "stripe.charges.createRefund('ch_123')",
      "ChargesResource no declara createRefund",
      "Usa stripe.refunds.create()"
    );

    const patterns = listKnownPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].signature).toBe("charges.createRefund(");
    expect(patterns[0].timesSeen).toBe(1);
  });

  // -------------------------------------------------------------------------
  it("same signature recorded twice → single row with timesSeen = 2", () => {
    recordConfirmedHallucination(
      "charges.createRefund(",
      "stripe.charges.createRefund('ch_123')",
      "ChargesResource no declara createRefund",
      "Usa stripe.refunds.create()"
    );
    // Call again with different arguments — same signature
    recordConfirmedHallucination(
      "charges.createRefund(",
      "stripe.charges.createRefund('ch_456', { amount: 500 })",
      "ChargesResource no declara createRefund",
      "Usa stripe.refunds.create()"
    );

    const patterns = listKnownPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].timesSeen).toBe(2);
  });

  // -------------------------------------------------------------------------
  it("different signatures → two separate rows", () => {
    recordConfirmedHallucination("sig:A", "code A", "problem A", "fix A");
    recordConfirmedHallucination("sig:B", "code B", "problem B", "fix B");

    const patterns = listKnownPatterns();
    expect(patterns).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  it("findMatchingPatterns: code signature matches when it appears in code", () => {
    recordConfirmedHallucination(
      "charges.createRefund(",
      "stripe.charges.createRefund('ch_123')",
      "problem",
      "fix"
    );

    const matches = findMatchingPatterns(
      `await stripe.charges.createRefund('ch_999')`,
      []
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].signature).toBe("charges.createRefund(");
  });

  // -------------------------------------------------------------------------
  it("findMatchingPatterns: code signature does NOT match unrelated code", () => {
    recordConfirmedHallucination(
      "charges.createRefund(",
      "stripe.charges.createRefund('ch_123')",
      "problem",
      "fix"
    );

    const matches = findMatchingPatterns(
      `await stripe.refunds.create({ charge: 'ch_123' })`,
      []
    );
    expect(matches).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  it("findMatchingPatterns: pkg: signature matches when package is imported", () => {
    recordConfirmedHallucination(
      "pkg:zod-lite",
      "import { z } from 'zod-lite'",
      "zod-lite no existe en npm",
      "Usa 'zod' en su lugar"
    );

    const matches = findMatchingPatterns(
      `import { z } from 'zod-lite'`,
      ["zod-lite"]
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].signature).toBe("pkg:zod-lite");
  });

  // -------------------------------------------------------------------------
  it("findMatchingPatterns: pkg:zod-lite does NOT match when zod-lite is NOT imported", () => {
    recordConfirmedHallucination(
      "pkg:zod-lite",
      "import { z } from 'zod-lite'",
      "zod-lite no existe en npm",
      "Usa 'zod' en su lugar"
    );

    const matches = findMatchingPatterns(
      `import { z } from 'zod'`,
      ["zod"] // zod-lite not in list
    );
    expect(matches).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  it("bumpPattern increments timesSeen", () => {
    recordConfirmedHallucination("some-sig", "snippet", "problem", "fix");

    bumpPattern("some-sig");
    bumpPattern("some-sig");

    const patterns = listKnownPatterns();
    expect(patterns[0].timesSeen).toBe(3); // 1 initial + 2 bumps
  });

  // -------------------------------------------------------------------------
  it("listKnownPatterns respects limit", () => {
    for (let i = 0; i < 10; i++) {
      recordConfirmedHallucination(`sig:${i}`, `code${i}`, `prob${i}`, `fix${i}`);
    }
    expect(listKnownPatterns(3)).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  it("listKnownPatterns orders by timesSeen DESC", () => {
    recordConfirmedHallucination("sig:rare", "code", "prob", "fix");
    recordConfirmedHallucination("sig:common", "code", "prob", "fix");
    // Bump common pattern several times
    for (let i = 0; i < 4; i++) bumpPattern("sig:common");

    const patterns = listKnownPatterns();
    expect(patterns[0].signature).toBe("sig:common");
  });
});
