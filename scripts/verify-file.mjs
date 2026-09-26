#!/usr/bin/env node
/**
 * verify-file.mjs — CLI wrapper for CI / manual use.
 *
 * Usage:  node scripts/verify-file.mjs <file>
 *
 * Exit codes:
 *   0  VERIFIED
 *   1  FAILED
 *   2  Error (missing arg, unreadable file, server unreachable, etc.)
 */

import { readFileSync } from "fs";
import { resolve, relative } from "path";
import { languageFor, verifyCode, renderReport, writeReport } from "./guard-client.mjs";

const [,, filePath] = process.argv;

if (!filePath) {
  process.stderr.write("Usage: node scripts/verify-file.mjs <file>\n");
  process.exit(2);
}

const absPath  = resolve(filePath);
const relPath  = relative(process.cwd(), absPath);
const language = languageFor(absPath);

if (!language) {
  process.stderr.write(`Not a supported code file: ${filePath}\n`);
  process.exit(2);
}

let code;
try {
  code = readFileSync(absPath, "utf8");
} catch (err) {
  process.stderr.write(`Cannot read file: ${err.message}\n`);
  process.exit(2);
}

let report;
try {
  report = await verifyCode(code, language, process.cwd());
} catch (err) {
  process.stderr.write(`Guard server error: ${err.message}\n`);
  process.exit(2);
}

const md = renderReport(report, relPath);
writeReport(md);

// Print report to stdout
process.stdout.write(md + "\n");

process.exit(report.verdict === "VERIFIED" ? 0 : 1);
