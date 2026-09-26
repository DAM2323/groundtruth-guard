import { describe, it, expect } from "vitest";
import { classifyExecution } from "../src/agents/sandboxExecutionAgent";

// ---------------------------------------------------------------------------
// Real captured outputs from sandbox runs
// ---------------------------------------------------------------------------

describe("classifyExecution", () => {
  // -------------------------------------------------------------------------
  // exit 0 → null (no finding)
  it("exit 0 → null", () => {
    expect(classifyExecution(0, "")).toBeNull();
    expect(classifyExecution(0, "some output")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // TypeError: method not a function → CRITICAL (hallucination caught)
  it("TypeError: Stripe.charges.createRefund is not a function → CRITICAL", () => {
    const output =
      "/sandbox/snippet.js:3\n" +
      "TypeError: Stripe.charges.createRefund is not a function\n" +
      "    at Object.<anonymous> (/sandbox/snippet.js:3:20)";

    const result = classifyExecution(1, output);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("CRITICAL");
    expect(result!.message).toMatch(/TypeError/);
  });

  // -------------------------------------------------------------------------
  // StripeConnectionError → INFO (network reached, blocked by design)
  it("StripeConnectionError → INFO", () => {
    const output =
      "StripeConnectionError: An error occurred with our connection to Stripe. " +
      "Request was retried 2 times.\n" +
      "    at /node_modules/stripe/lib/StripeError.js:22:14";

    const result = classifyExecution(1, output);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("INFO");
    expect(result!.message).toMatch(/red|bloqueada|existen/i);
  });

  // -------------------------------------------------------------------------
  // Cannot find module → WARNING (env limitation)
  it("Error: Cannot find module 'stripe' → WARNING", () => {
    const output =
      "Error: Cannot find module 'stripe'\n" +
      "Require stack:\n" +
      "- /sandbox/snippet.js\n" +
      "    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1075:15)";

    const result = classifyExecution(1, output);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("WARNING");
  });

  // -------------------------------------------------------------------------
  // MODULE_NOT_FOUND code variant → WARNING
  it("MODULE_NOT_FOUND → WARNING", () => {
    const output = "Error: Cannot find module 'some-pkg'\nCODE: MODULE_NOT_FOUND";
    const result = classifyExecution(1, output);
    expect(result!.severity).toBe("WARNING");
  });

  // -------------------------------------------------------------------------
  // ModuleNotFoundError (Python) → WARNING
  it("ModuleNotFoundError (Python) → WARNING", () => {
    const output = "ModuleNotFoundError: No module named 'stripe'";
    const result = classifyExecution(1, output);
    expect(result!.severity).toBe("WARNING");
  });

  // -------------------------------------------------------------------------
  // "TypeError: fetch failed" is a NETWORK error → INFO, not CRITICAL
  // Network patterns must be checked BEFORE TypeError
  it("TypeError: fetch failed → INFO (network, not a hallucination)", () => {
    const output =
      "TypeError: fetch failed\n" +
      "    at node:internal/deps/undici/undici:12442:11\n" +
      "    cause: Error: connect ECONNREFUSED 54.187.174.169:443";

    const result = classifyExecution(1, output);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("INFO");
  });

  // -------------------------------------------------------------------------
  // ENOTFOUND → INFO
  it("ENOTFOUND → INFO", () => {
    const output =
      "Error: getaddrinfo ENOTFOUND api.stripe.com\n" +
      "    at GetAddrInfoReqWrap.onlookup";
    const result = classifyExecution(1, output);
    expect(result!.severity).toBe("INFO");
  });

  // -------------------------------------------------------------------------
  // ReferenceError → CRITICAL
  it("ReferenceError → CRITICAL", () => {
    const output = "ReferenceError: stripe is not defined\n    at snippet.js:1:1";
    const result = classifyExecution(1, output);
    expect(result!.severity).toBe("CRITICAL");
  });

  // -------------------------------------------------------------------------
  // SyntaxError → CRITICAL
  it("SyntaxError → CRITICAL", () => {
    const output =
      "SyntaxError: Unexpected token '}'\n" +
      "    at wrapSafe (node:internal/modules/cjs/loader:1378:18)";
    const result = classifyExecution(1, output);
    expect(result!.severity).toBe("CRITICAL");
  });

  // -------------------------------------------------------------------------
  // AttributeError (Python) → CRITICAL
  it("AttributeError (Python) → CRITICAL", () => {
    const output = "AttributeError: 'Charges' object has no attribute 'createRefund'";
    const result = classifyExecution(1, output);
    expect(result!.severity).toBe("CRITICAL");
  });

  // -------------------------------------------------------------------------
  // NameError (Python) → CRITICAL
  it("NameError (Python) → CRITICAL", () => {
    const output = "NameError: name 'createRefund' is not defined";
    const result = classifyExecution(1, output);
    expect(result!.severity).toBe("CRITICAL");
  });

  // -------------------------------------------------------------------------
  // Generic non-zero exit with no recognisable error pattern → CRITICAL
  it("exit 1 with unknown output → CRITICAL", () => {
    const output = "Process killed by OOM";
    const result = classifyExecution(1, output);
    expect(result!.severity).toBe("CRITICAL");
  });

  // -------------------------------------------------------------------------
  // exit 0 even with error-like text in output → null (exit code wins)
  it("exit 0 with error text in output → null", () => {
    expect(classifyExecution(0, "TypeError in some docs text")).toBeNull();
  });
});
