/**
 * guard-client.mjs — shared helpers for GroundTruth Guard scripts.
 * No external dependencies; requires Node 18+.
 */

import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, extname, join } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const GUARD_URL =
  process.env.GROUNDTRUTH_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/** Map file extension → language recognised by the Guard API. */
const EXT_MAP = {
  ".js":  "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts":  "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py":  "python",
};

/**
 * Return the language string for a given file path, or null if the file is
 * not a code file we verify.
 * @param {string} filePath
 * @returns {"javascript"|"typescript"|"python"|null}
 */
export function languageFor(filePath) {
  const ext = extname(filePath).toLowerCase();
  return EXT_MAP[ext] ?? null;
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

/**
 * Verify a code snippet against the running Guard server.
 *
 * @param {string} code
 * @param {"javascript"|"typescript"|"python"} language
 * @param {string|undefined} projectRoot  Absolute path to the project root
 *        (its node_modules will be mounted in the sandbox).
 * @returns {Promise<import("../src/types.js").VerificationReport>}
 */
export async function verifyCode(code, language, projectRoot) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  try {
    const body = {
      code,
      language,
      ...(projectRoot ? { projectContext: { installedPackagesPath: projectRoot } } : {}),
    };

    const res = await fetch(`${GUARD_URL}/api/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Guard API returned ${res.status}: ${text}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

/**
 * Render a VerificationReport as a Markdown string.
 *
 * @param {import("../src/types.js").VerificationReport} report
 * @param {string} filePath  The file that was verified.
 * @returns {string}
 */
export function renderReport(report, filePath) {
  const isVerified = report.verdict === "VERIFIED";
  const title = isVerified
    ? "GroundTruth Guard: ✅ VERIFICADO"
    : "GroundTruth Guard: ❌ RECHAZADO";

  const lines = [
    `# ${title}`,
    "",
    `**Archivo:** \`${filePath}\`  `,
    `**ID:** \`${report.id}\`  `,
    `**Fecha:** ${report.createdAt}  `,
    `**Duración:** ${report.totalDurationMs}ms  `,
    ...(report.fromMemory ? ["**Fuente:** memoria del equipo  "] : []),
    "",
  ];

  // Collect critical findings (blockers) and non-critical (notes)
  const criticals = [];
  const notes = [];

  for (const result of report.agentResults) {
    for (const finding of result.findings) {
      if (finding.severity === "CRITICAL") {
        criticals.push({ finding, agent: result.agent });
      } else {
        notes.push({ finding, agent: result.agent });
      }
    }
  }

  if (criticals.length > 0) {
    lines.push("## 🚫 Hallazgos bloqueantes", "");
    criticals.forEach(({ finding, agent }, i) => {
      lines.push(`### Prueba ${String.fromCharCode(65 + i)} (${agent})`, "");
      lines.push(`**Problema:** ${finding.message}`, "");
      if (finding.evidence) {
        lines.push("**Evidencia:**", "```", finding.evidence, "```", "");
      }
      if (finding.suggestedFix) {
        lines.push(`**Corrección:** ${finding.suggestedFix}`, "");
      }
    });
  }

  if (notes.length > 0) {
    lines.push("## ℹ️ Notas no bloqueantes", "");
    for (const { finding, agent } of notes) {
      lines.push(`- **[${finding.severity}] ${agent}:** ${finding.message}`);
      if (finding.evidence) {
        lines.push(`  > ${finding.evidence.replace(/\n/g, " ").slice(0, 200)}`);
      }
    }
    lines.push("");
  }

  if (isVerified && criticals.length === 0) {
    lines.push("_El código pasó todos los agentes de verificación._", "");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Write report to disk
// ---------------------------------------------------------------------------

/**
 * Write the rendered Markdown report to `.groundtruth/last-report.md`.
 *
 * @param {string} markdown
 * @param {string} [cwd]  Defaults to process.cwd().
 */
export function writeReport(markdown, cwd = process.cwd()) {
  const dir = join(cwd, ".groundtruth");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "last-report.md"), markdown, "utf8");
}
