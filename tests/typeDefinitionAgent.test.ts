import { describe, it, expect } from "vitest";
import * as path from "path";
import {
  buildTypeIndex,
  extractMethodCalls,
  typeDefinitionAgent,
} from "../src/agents/typeDefinitionAgent";
import type { VerificationRequest } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STRIPE_TYPES_DIR = path.join(
  process.cwd(),
  "node_modules",
  "stripe",
  "types"
);

function makeRequest(code: string): VerificationRequest {
  return { code, language: "typescript" };
}

// ---------------------------------------------------------------------------
// extractMethodCalls
// ---------------------------------------------------------------------------
describe("extractMethodCalls", () => {
  it("extracts simple object.method() calls", () => {
    const calls = extractMethodCalls(`stripe.charges.createRefund("ch_123");`);
    // Note: regex extracts consecutive pairs — stripe.charges and charges.createRefund
    const pair = calls.find(
      (c) => c.object === "charges" && c.method === "createRefund"
    );
    expect(pair).toBeDefined();
  });

  it("deduplicates repeated calls", () => {
    const code = `foo.bar(); foo.bar(); foo.bar();`;
    const calls = extractMethodCalls(code);
    const matches = calls.filter((c) => c.object === "foo" && c.method === "bar");
    expect(matches).toHaveLength(1);
  });

  it("ignores property access without call parens", () => {
    const code = `const x = obj.prop;`;
    const calls = extractMethodCalls(code);
    expect(calls.find((c) => c.object === "obj" && c.method === "prop")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildTypeIndex — against real stripe types
// ---------------------------------------------------------------------------
describe("buildTypeIndex (stripe)", () => {
  it(
    "maps 'charges' property to ChargesResource",
    () => {
      const idx = buildTypeIndex(STRIPE_TYPES_DIR);
      expect(idx.propertyTypes.get("charges")).toBe("ChargesResource");
    },
    30_000
  );

  it(
    "maps 'refunds' property to RefundsResource",
    () => {
      const idx = buildTypeIndex(STRIPE_TYPES_DIR);
      expect(idx.propertyTypes.get("refunds")).toBe("RefundsResource");
    },
    30_000
  );

  it(
    "maps 'applicationFees' property to ApplicationFeesResource",
    () => {
      const idx = buildTypeIndex(STRIPE_TYPES_DIR);
      expect(idx.propertyTypes.get("applicationFees")).toBe("ApplicationFeesResource");
    },
    30_000
  );

  it(
    "ChargesResource declares 'create' but NOT 'createRefund'",
    () => {
      const idx = buildTypeIndex(STRIPE_TYPES_DIR);
      const members = idx.typeMembers.get("ChargesResource")!;
      expect(members).toBeDefined();
      expect(members.has("create")).toBe(true);
      expect(members.has("createRefund")).toBe(false);
    },
    30_000
  );

  it(
    "RefundsResource declares 'create'",
    () => {
      const idx = buildTypeIndex(STRIPE_TYPES_DIR);
      const members = idx.typeMembers.get("RefundsResource")!;
      expect(members).toBeDefined();
      expect(members.has("create")).toBe(true);
    },
    30_000
  );

  it(
    "ApplicationFeesResource declares 'createRefund'",
    () => {
      const idx = buildTypeIndex(STRIPE_TYPES_DIR);
      const members = idx.typeMembers.get("ApplicationFeesResource")!;
      expect(members).toBeDefined();
      expect(members.has("createRefund")).toBe(true);
    },
    30_000
  );
});

// ---------------------------------------------------------------------------
// typeDefinitionAgent — integration against real stripe types
// ---------------------------------------------------------------------------
describe("typeDefinitionAgent (stripe integration)", () => {
  it(
    "FAILS: charges.createRefund() — method does not exist on ChargesResource",
    async () => {
      const result = await typeDefinitionAgent(makeRequest(
        `import Stripe from "stripe";\n` +
        `const stripe = new Stripe("sk_test_xxx");\n` +
        `await stripe.charges.createRefund("ch_123");`
      ));

      expect(result.passed).toBe(false);
      expect(result.findings).toHaveLength(1);

      const f = result.findings[0];
      expect(f.severity).toBe("CRITICAL");
      expect(f.message).toMatch(/ChargeResource|ChargesResource/);
      expect(f.message).toMatch(/createRefund/);
      expect(f.signature).toBe("charges.createRefund(");
      // Should suggest refunds.create()
      expect(f.suggestedFix).toMatch(/refunds\.create/i);
      // Should mention applicationFees.createRefund exists
      expect(f.suggestedFix).toMatch(/applicationFees\.createRefund/i);
    },
    30_000
  );

  it(
    "PASSES: refunds.create() — valid method on RefundsResource",
    async () => {
      const result = await typeDefinitionAgent(makeRequest(
        `import Stripe from "stripe";\n` +
        `const stripe = new Stripe("sk_test_xxx");\n` +
        `await stripe.refunds.create({ charge: "ch_123" });`
      ));

      expect(result.passed).toBe(true);
      // No CRITICAL findings for refunds.create
      const criticals = result.findings.filter((f) => f.severity === "CRITICAL");
      expect(criticals).toHaveLength(0);
    },
    30_000
  );

  it(
    "PASSES: applicationFees.createRefund() — valid method on ApplicationFeesResource",
    async () => {
      const result = await typeDefinitionAgent(makeRequest(
        `import Stripe from "stripe";\n` +
        `const stripe = new Stripe("sk_test_xxx");\n` +
        `await stripe.applicationFees.createRefund("fee_123");`
      ));

      expect(result.passed).toBe(true);
      const criticals = result.findings.filter((f) => f.severity === "CRITICAL");
      expect(criticals).toHaveLength(0);
    },
    30_000
  );

  it(
    "PASSES: Python code is out of scope",
    async () => {
      const result = await typeDefinitionAgent({
        code: `stripe.charges.createRefund("ch_123")`,
        language: "python",
      });
      expect(result.passed).toBe(true);
      expect(result.findings).toHaveLength(0);
    },
    5_000
  );
});
