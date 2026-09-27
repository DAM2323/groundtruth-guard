#!/usr/bin/env node
/**
 * bob-hook.mjs — IBM Bob lifecycle hook for GroundTruth Guard.
 *
 * Bob invokes this script for every tool call.  The payload arrives on stdin
 * as a single JSON line.  Key names vary across Bob versions:
 *   event:  event | hook_event_name | hookEventName
 *   tool:   tool  | tool_name       | toolName
 *   input:  input | tool_input      | toolInput | params | arguments
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
 * Read a value from a payload object trying multiple candidate keys in order.
 */
function pick(obj, ...keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

/**
 * Normalise the input sub-object from the payload.
 * Bob 2.2.0 may send tool_input / toolInput / params / arguments.
 * If the value is a JSON string, parse it.
 */
function resolveInput(payload) {
  const raw = pick(payload, "input", "tool_input", "toolInput", "params", "arguments");
  if (raw === undefined) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (typeof raw === "object") return raw;
  return {};
}

/**
 * Extract the file path from the tool input object.
 * Falls back to the top-level payload if not found inside input.
 * Bob's internal tool names change; we inspect all plausible keys.
 */
function extractPath(input, payload) {
  for (const key of ["path", "file_path", "filePath", "target_file", "file"]) {
    if (typeof input[key] === "string" && input[key]) return input[key];
  }
  // Fallback: check top-level payload keys
  for (const key of ["path", "file_path", "filePath", "target_file", "file"]) {
    if (typeof payload[key] === "string" && payload[key]) return payload[key];
  }
  return null;
}

/**
 * Extract the file content from the tool input object.
 * Falls back to the top-level payload if not found inside input.
 */
function extractContent(input, payload) {
  for (const key of ["content", "file_text", "new_content", "contents", "text"]) {
    if (typeof input[key] === "string") return input[key];
  }
  // Fallback: check top-level payload keys
  for (const key of ["content", "file_text", "new_content", "contents", "text"]) {
    if (typeof payload[key] === "string") return payload[key];
  }
  return null;
}

// ---------------------------------------------------------------------------
// "SIN VERIFICAR" report when the server is unreachable
// ---------------------------------------------------------------------------

function writeServerDownReport(filePath) {
  const md = [
    "# GroundTruth Guard: ⚠️ UNVERIFIED",
    "",
    `**File:** \`${filePath}\`  `,
    `**Date:** ${new Date().toISOString()}  `,
    "",
    "The GroundTruth Guard server is not available (`" + GUARD_URL + "`).  ",
    "The code was **not verified**.",
    "",
    "## Instructions",
    "",
    "1. Start the server: `npm run dev` in the project root.",
    "2. Re-run the tool or run `node scripts/verify-file.mjs <file>` manually.",
    "3. Do not run unverified AI code in production.",
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

  // Tolerate different key names across Bob versions
  const event = pick(payload, "event", "hook_event_name", "hookEventName");
  const tool  = pick(payload, "tool", "tool_name", "toolName");
  const input = resolveInput(payload);

  const filePath = extractPath(input, payload);
  const content  = extractContent(input, payload);

  const logBase = {
    event,
    tool,
    inputKeys: Object.keys(input),
    topKeys:   Object.keys(payload),
    rawPreview: raw.trim().slice(0, 500),
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
  if (event === "PreToolUse" && content !== null && content !== undefined) {
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
        `[GroundTruth Guard] Write BLOCKED for ${filePath}\n` +
        `Report: ${join(LOG_DIR, "last-report.md")}\n`
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
