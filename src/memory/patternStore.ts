import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { KnownPattern } from "../types";

// ---------------------------------------------------------------------------
// SQLite — loaded at runtime via process.getBuiltinModule so Vitest never
// tries to resolve the bare "node:sqlite" specifier (which it can't handle).
// ---------------------------------------------------------------------------

type NodeSqlite = typeof import("node:sqlite");

let _sqlite: NodeSqlite | null = null;

function getSqlite(): NodeSqlite {
  if (!_sqlite) {
    _sqlite = (process as NodeJS.Process & {
      getBuiltinModule(id: "node:sqlite"): NodeSqlite;
    }).getBuiltinModule("node:sqlite");
  }
  return _sqlite;
}

// ---------------------------------------------------------------------------
// DB path — can be overridden via env for tests
// ---------------------------------------------------------------------------

export function getDbPath(): string {
  return process.env.PATTERN_DB_PATH ?? "./data/patterns.sqlite";
}

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _db: any = null;

function getDb() {
  if (_db) return _db;

  const dbPath = getDbPath();
  // node:sqlite does NOT create parent directories — do it manually.
  mkdirSync(dirname(dbPath), { recursive: true });

  const { DatabaseSync } = getSqlite();
  _db = new DatabaseSync(dbPath);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS patterns (
      hash          TEXT PRIMARY KEY,
      signature     TEXT NOT NULL UNIQUE,
      originalSnippet TEXT NOT NULL,
      problem       TEXT NOT NULL,
      correction    TEXT NOT NULL,
      timesSeen     INTEGER NOT NULL DEFAULT 1,
      lastSeenAt    TEXT NOT NULL
    )
  `);

  return _db;
}

/** Reset the cached DB handle — used by tests to force a fresh connection. */
export function _resetDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------

function hashSignature(signature: string): string {
  return createHash("sha256").update(signature).digest("hex");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a confirmed hallucination.  
 * If the signature is already known, increments `timesSeen` and updates
 * `lastSeenAt` — the snippet/problem/correction from the first sighting are
 * kept to avoid noisy drift.
 */
export function recordConfirmedHallucination(
  signature: string,
  snippet: string,
  problem: string,
  correction: string
): void {
  const db = getDb();
  const hash = hashSignature(signature);
  const now = new Date().toISOString();

  // Check if already exists
  const existing = db
    .prepare("SELECT hash FROM patterns WHERE hash = ?")
    .get(hash) as { hash: string } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE patterns SET timesSeen = timesSeen + 1, lastSeenAt = ? WHERE hash = ?"
    ).run(now, hash);
  } else {
    db.prepare(
      `INSERT INTO patterns
         (hash, signature, originalSnippet, problem, correction, timesSeen, lastSeenAt)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).run(hash, signature, snippet, problem, correction, now);
  }
}

/**
 * Deterministic pattern matching:
 *  - `pkg:<name>` signatures match when `<name>` appears in `importedPackages`
 *  - Other signatures match when the signature string appears verbatim in `code`
 *    (after stripping spaces from both, to catch argument variations)
 */
export function findMatchingPatterns(
  code: string,
  importedPackages: string[]
): KnownPattern[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM patterns ORDER BY timesSeen DESC")
    .all() as KnownPattern[];

  return rows.filter((row) => {
    if (row.signature.startsWith("pkg:")) {
      const pkgName = row.signature.slice(4);
      return importedPackages.includes(pkgName);
    }
    // For method/code signatures: match if the signature text appears in code
    // ignoring whitespace differences (e.g. "charges.createRefund(" matches
    // "charges.createRefund ( " too)
    const normalizedCode = code.replace(/\s+/g, "");
    const normalizedSig = row.signature.replace(/\s+/g, "");
    return normalizedCode.includes(normalizedSig);
  });
}

/**
 * Increment the `timesSeen` counter and refresh `lastSeenAt` for a signature.
 */
export function bumpPattern(signature: string): void {
  const db = getDb();
  const hash = hashSignature(signature);
  db.prepare(
    "UPDATE patterns SET timesSeen = timesSeen + 1, lastSeenAt = ? WHERE hash = ?"
  ).run(new Date().toISOString(), hash);
}

/**
 * List known patterns, most-seen first.
 */
export function listKnownPatterns(limit = 50): KnownPattern[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM patterns ORDER BY timesSeen DESC, lastSeenAt DESC LIMIT ?"
    )
    .all(limit) as KnownPattern[];
}
