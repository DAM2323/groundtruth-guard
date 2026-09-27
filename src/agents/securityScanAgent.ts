import type { AgentResult, Finding, VerificationRequest } from "../types";

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

interface Pattern {
  id: string;
  test: (code: string) => RegExpExecArray | null;
  toFinding: (match: RegExpExecArray) => Omit<Finding, "agent">;
}

const PATTERNS: Pattern[] = [
  // -------------------------------------------------------------------------
  // Hardcoded secret: api_key / secret / token / password = "value 12+"
  // -------------------------------------------------------------------------
  {
    id: "hardcoded-secret",
    test: (code) => {
      const re =
        /(?:api_?key|secret|token|password)\s*(?:=|:)\s*["']([^"']{12,})["']/gi;
      return re.exec(code);
    },
    toFinding: (m) => ({
      severity: "CRITICAL",
      message: `Hardcoded secret detected: the string "${m[1].slice(0, 6)}…" looks like a real credential assigned directly in code.`,
      evidence: m[0].trim(),
      suggestedFix:
        "Move the secret to an environment variable and access it with `process.env.YOUR_VARIABLE`. " +
        "Never include real credentials in source code.",
      signature: "hardcoded-secret",
    }),
  },

  // -------------------------------------------------------------------------
  // SQL concatenated with +
  // -------------------------------------------------------------------------
  {
    id: "sql-injection",
    test: (code) => {
      // Matches: "SELECT ... " + variable  OR  variable + " WHERE ..."
      const re =
        /["'`][^"'`]*(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)[^"'`]*["'`]\s*\+/gi;
      return re.exec(code);
    },
    toFinding: (m) => ({
      severity: "CRITICAL",
      message:
        "Possible SQL injection: a SQL string is being concatenated with the `+` operator. " +
        "An attacker can manipulate the query if any operand comes from user input.",
      evidence: m[0].trim(),
      suggestedFix:
        "Use parameterized queries (prepared statements) instead of string concatenation. " +
        "Example with node-postgres: `client.query('SELECT * FROM users WHERE id = $1', [id])`.",
      signature: "sql-concatenation(+",
    }),
  },

  // -------------------------------------------------------------------------
  // eval(
  // -------------------------------------------------------------------------
  {
    id: "eval-usage",
    test: (code) => {
      const re = /\beval\s*\(/g;
      return re.exec(code);
    },
    toFinding: (m) => ({
      severity: "CRITICAL",
      message:
        "`eval()` executes arbitrary code at runtime and is an entry point for code injection attacks.",
      evidence: m[0].trim(),
      suggestedFix:
        "Remove the use of `eval()`. If you need to parse data, use `JSON.parse()`. " +
        "If you need to call functions dynamically, use a map of known functions.",
      signature: "eval(",
    }),
  },

  // -------------------------------------------------------------------------
  // await without nearby error handling (try/catch or .catch)
  // -------------------------------------------------------------------------
  {
    id: "unhandled-await",
    test: (code) => {
      // An await expression NOT preceded by try{ within a reasonable window
      // and not followed by .catch(. We look for `await ` that's not inside
      // a try block (heuristic: no `try` in the 300 chars before it) and has
      // no .catch in the 80 chars after it.
      const re = /\bawait\s+\S[^\n]*/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const before = code.slice(Math.max(0, m.index - 300), m.index);
        const after = code.slice(m.index, m.index + m[0].length + 80);
        const insideTry = /try\s*\{[^}]*$/.test(before);
        const hasCatch = /\.catch\s*\(/.test(after);
        if (!insideTry && !hasCatch) return m;
      }
      return null;
    },
    toFinding: (m) => ({
      severity: "WARNING",
      message:
        "`await` expression without nearby error handling. If the promise rejects, " +
        "the exception may go uncaught and cause a silent failure or UnhandledPromiseRejection.",
      evidence: m[0].slice(0, 80).trim(),
      suggestedFix:
        "Wrap the call in a `try { ... } catch (err) { ... }` block " +
        "or chain `.catch(err => ...)` to handle the rejection explicitly.",
      signature: "unhandled-await",
    }),
  },
];

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export async function securityScanAgent(
  request: VerificationRequest
): Promise<AgentResult> {
  const start = Date.now();
  const findings: Finding[] = [];
  const seenSignatures = new Set<string>();

  for (const pattern of PATTERNS) {
    const match = pattern.test(request.code);
    if (match) {
      const partial = pattern.toFinding(match);
      // Deduplicate by signature so the same pattern only fires once
      if (!seenSignatures.has(partial.signature ?? pattern.id)) {
        seenSignatures.add(partial.signature ?? pattern.id);
        findings.push({ agent: "security-scan", ...partial });
      }
    }
  }

  return {
    agent: "security-scan",
    passed: findings.every((f) => f.severity !== "CRITICAL"),
    findings,
    durationMs: Date.now() - start,
  };
}
