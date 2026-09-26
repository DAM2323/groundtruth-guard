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
  // Secreto hardcodeado: api_key / secret / token / password = "valor 12+"
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
      message: `Secreto hardcodeado detectado: la cadena "${m[1].slice(0, 6)}…" parece una credencial real asignada directamente en el código.`,
      evidence: m[0].trim(),
      suggestedFix:
        "Mueve el secreto a una variable de entorno y accede a él con `process.env.TU_VARIABLE`. " +
        "Nunca incluyas credenciales reales en el código fuente.",
      signature: "hardcoded-secret",
    }),
  },

  // -------------------------------------------------------------------------
  // SQL concatenado con +
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
        "Posible inyección SQL: se está concatenando una cadena SQL con el operador `+`. " +
        "Un atacante puede manipular la consulta si algún operando proviene de entrada del usuario.",
      evidence: m[0].trim(),
      suggestedFix:
        "Usa consultas parametrizadas (prepared statements) en lugar de concatenación de cadenas. " +
        "Ejemplo con node-postgres: `client.query('SELECT * FROM users WHERE id = $1', [id])`.",
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
        "`eval()` ejecuta código arbitrario en tiempo de ejecución y es una puerta de entrada para ataques de inyección de código.",
      evidence: m[0].trim(),
      suggestedFix:
        "Elimina el uso de `eval()`. Si necesitas parsear datos usa `JSON.parse()`. " +
        "Si necesitas ejecutar funciones dinámicamente, usa un mapa de funciones conocidas.",
      signature: "eval(",
    }),
  },

  // -------------------------------------------------------------------------
  // await sin manejo de errores cercano (try/catch o .catch)
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
        "Expresión `await` sin manejo de errores cercano. Si la promesa es rechazada, " +
        "la excepción podría no capturarse y causar un fallo silencioso o un UnhandledPromiseRejection.",
      evidence: m[0].slice(0, 80).trim(),
      suggestedFix:
        "Envuelve la llamada en un bloque `try { ... } catch (err) { ... }` " +
        "o encadena `.catch(err => ...)` para manejar el rechazo explícitamente.",
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
