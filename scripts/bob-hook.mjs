#!/usr/bin/env node
/**
 * bob-hook.mjs — IBM Bob lifecycle hook for GroundTruth Guard.
 *
 * Bob invokes this script for every tool call.  The payload arrives on stdin
 * as a single JSON line: { event, session_id, tool, input }.
 *
 * PreToolUse  + content present  → verify BEFORE the write; exit 2 to block.
 * PostToolUse + no content        → read file from disk, verify; can't block.
 * All other cases                 → exit 0 silently.
 *
 * Server down → exit 0 (never block), write "SIN VERIFICAR" report.
 *
 * Bob ignores stdout from PreToolUse hooks; the blocking reason is
 * communicated via the report file only.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { join, extname, dirname, resolve } from "path";
import { languageFor, verifyCode, renderReport, writeReport, GUARD_URL } from "./guard-client.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CWD = process.cwd();
const LOG_DIR  = join(CWD, ".groundtruth");
const LOG_FILE = join(LOG_DIR, "hook-log.jsonl");

function ensureLogDir() {
  mkdirSync(LOG_DIR, { recursive: true });
}

function log(entry) {
  ensureLogDir();
  appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
}

/**
 * Extract the file path from the tool input object.
 * Bob's internal tool names change; we inspect all plausible keys.
 */
function extractPath(input) {
  for (const key of ["path", "file_path", "filePath", "target_file", "file"]) {
    if (typeof input[key] === "string" && input[key]) return input[key];
  }
  return null;
}

/**
 * Extract the file content from the tool input object.
 */
function extractContent(input) {
  for (const key of ["content", "file_text", "new_content", "contents", "text"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return null;
}

// ---------------------------------------------------------------------------
// "SIN VERIFICAR" report when the server is unreachable
// ---------------------------------------------------------------------------

function writeServerDownReport(filePath) {
  const md = [
    "# GroundTruth Guard: ⚠️ SIN VERIFICAR",
    "",
    `**Archivo:** \`${filePath}\`  `,
    `**Fecha:** ${new Date().toISOString()}  `,
    "",
    "El servidor de GroundTruth Guard no está disponible (`" + GUARD_URL + "`).  ",
    "El código **no fue verificado**.",
    "",
    "## Instrucciones",
    "",
    "1. Arranca el servidor: `npm run dev` en la raíz del proyecto.",
    "2. Vuelve a ejecutar la herramienta o ejecuta `node scripts/verify-file.mjs <archivo>` manualmente.",
    "3. No ejecutes código de IA sin verificar en producción.",
    "",
  ].join("\n");

  writeReport(md);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Read stdin
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  let payload;
  try {
    payload = JSON.parse(raw.trim());
  } catch {
    // Malformed payload — don't interfere
    process.exit(0);
  }

  const { event, tool, input = {} } = payload;

  const filePath = extractPath(input);
  const content  = extractContent(input);

  const logBase = {
    event,
    tool,
    inputKeys: Object.keys(input),
  };

  // --- Ignore non-code files and files inside .groundtruth -----------------
  if (!filePath) {
    log({ ...logBase, action: "ignored", reason: "no-path" });
    process.exit(0);
  }

  const normalised = filePath.replace(/\\/g, "/");
  if (normalised.includes("/.groundtruth/") || normalised.startsWith(".groundtruth/")) {
    log({ ...logBase, filePath, action: "ignored", reason: "groundtruth-dir" });
    process.exit(0);
  }

  const language = languageFor(filePath);
  if (!language) {
    log({ ...logBase, filePath, action: "ignored", reason: "not-code" });
    process.exit(0);
  }

  // --- PreToolUse with content: verify BEFORE writing ----------------------
  if (event === "PreToolUse" && content !== null) {
    const projectRoot = resolve(CWD);
    let report;

    try {
      report = await verifyCode(content, language, projectRoot);
    } catch (err) {
      // Server down or timeout
      writeServerDownReport(filePath);
      log({ ...logBase, filePath, action: "server-down", error: String(err) });
      process.exit(0);
    }

    const md = renderReport(report, filePath);
    writeReport(md);

    if (report.verdict === "FAILED") {
      // Print reason to stderr (Bob shows stderr in the UI for blocked tools)
      process.stderr.write(
        `[GroundTruth Guard] Escritura BLOQUEADA para ${filePath}\n` +
        `Reporte: ${join(LOG_DIR, "last-report.md")}\n`
      );
      log({ ...logBase, filePath, action: "blocked", verdict: "FAILED" });
      process.exit(2);
    }

    log({ ...logBase, filePath, action: "verified", verdict: "VERIFIED" });
    process.exit(0);
  }

  // --- PostToolUse without content: read from disk and verify ---------------
  if (event === "PostToolUse") {
    const absolutePath = resolve(CWD, filePath);

    if (!existsSync(absolutePath)) {
      log({ ...logBase, filePath, action: "skipped", reason: "file-not-found" });
      process.exit(0);
    }

    let code;
    try {
      code = readFileSync(absolutePath, "utf8");
    } catch {
      log({ ...logBase, filePath, action: "skipped", reason: "read-error" });
      process.exit(0);
    }

    const projectRoot = resolve(CWD);
    let report;

    try {
      report = await verifyCode(code, language, projectRoot);
    } catch (err) {
      writeServerDownReport(filePath);
      log({ ...logBase, filePath, action: "server-down", error: String(err) });
      process.exit(0);
    }

    const md = renderReport(report, filePath);
    writeReport(md);

    const action = report.verdict === "FAILED" ? "failed-after-write" : "verified";
    log({ ...logBase, filePath, action, verdict: report.verdict });
    process.exit(0);
  }

  // --- All other events (PreToolUse without content, etc.) ------------------
  log({ ...logBase, filePath, action: "skipped", reason: "no-content-or-unhandled-event" });
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[GroundTruth Guard] Unexpected error: ${err}\n`);
  process.exit(0); // never block Bob on unexpected errors
});
