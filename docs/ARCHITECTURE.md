# GroundTruth Guard — Architecture

## Overview

GroundTruth Guard is a verification pipeline for AI-generated code. It intercepts writes via an IBM Bob lifecycle hook, checks the code against real sources, and blocks the write if a hallucination is confirmed.

---

## Pipeline Diagram

```
  Bob writes a file
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │  scripts/bob-hook.mjs  (PreToolUse hook)    │
  │                                             │
  │  1. Parse stdin payload (tolerates both     │
  │     Bob 2.1 and 2.2 key shapes)             │
  │  2. Extract file path + content             │
  │  3. POST to http://localhost:3000/api/verify│
  │  4. Write .groundtruth/last-report.md       │
  │  5. exit 2 → Bob blocks write              │
  │     exit 0 → write proceeds                │
  │     server down → exit 0 (fail open)        │
  └──────────────────┬──────────────────────────┘
                     │ POST /api/verify
                     ▼
  ┌─────────────────────────────────────────────┐
  │  src/api/routes.ts  (Express endpoint)      │
  └──────────────────┬──────────────────────────┘
                     │
                     ▼
  ┌─────────────────────────────────────────────┐
  │  src/orchestrator.ts  runVerification()     │
  │                                             │
  │  Stage 1: Team Memory                       │
  │    node:sqlite, data/patterns.sqlite        │
  │    findMatchingPatterns(code, packages)     │
  │    → FAILED immediately on cache hit        │
  │    → bumpPattern(signature) on match        │
  │                                             │
  │  Stage 2 (cache miss): 4 agents in parallel │
  │    Promise.all([registry, type, sandbox,    │
  │                 security])                  │
  │                                             │
  │  Stage 3: Persist confirmed hallucinations  │
  │    CRITICAL findings from type-definition   │
  │    and package-registry with a signature    │
  │    → recordConfirmedHallucination(...)      │
  │                                             │
  │  Stage 4: Build VerificationReport          │
  │    verdict = VERIFIED | FAILED              │
  └──────────┬───────────────────────────────────┘
             │
     ┌───────┴────────────────────────────────┐
     │                                        │
     ▼                                        ▼
  Agent ①                                  Agent ②
  Package Registry                         Type Definitions
  src/agents/packageRegistryAgent.ts       src/agents/typeDefinitionAgent.ts
                                           
  - Extracts import/require names          - ts-morph parses installed .d.ts
  - Fetches npm/PyPI registry              - Builds TypeIndex: two maps
  - Flags non-existent packages              propertyTypes: prop → type name
    or invalid version ranges                typeMembers:  type → Set<method>
                                           - Resolves stripe.charges.X:
                                             charges → ChargesResource
                                             ChargesResource.has("X") ?
                                           - Flags missing methods as CRITICAL
                                           - buildSuggestedFix: splits verbNoun,
                                             finds matching resource + verb

     ▼                                        ▼
  Agent ③                                  Agent ④
  Sandbox Execution                        Security Scan
  src/agents/sandboxExecutionAgent.ts      src/agents/securityScanAgent.ts

  - docker.createContainer({               - Regex patterns:
      ReadonlyRootfs: true,                  eval(), exec(), hardcoded keys,
      CapDrop: ["ALL"],                      known-malicious pkg names
      NetworkMode: "none",                 - No external calls
      Memory: 256 MB,
      Tmpfs: { "/sandbox": "rw" }
    })
  - writeCodeFile via exec + base64 env
  - .cjs extension (CommonJS mode)
  - async IIFE wrapper for top-level await
  - exec.inspect() for real exit code
  - classifyExecution(exitCode, output):
      exit 0          → null (pass)
      network pattern → INFO
      MODULE_NOT_FOUND→ WARNING
      TypeError etc.  → CRITICAL
  - container.kill() + container.remove()
```

---

## Team Memory (SQLite)

File: [`src/memory/patternStore.ts`](../src/memory/patternStore.ts)

The database lives at `data/patterns.sqlite` (overridable via `PATTERN_DB_PATH` env var). Schema:

```sql
CREATE TABLE IF NOT EXISTS patterns (
  hash          TEXT PRIMARY KEY,   -- SHA-256 of signature
  signature     TEXT NOT NULL UNIQUE,
  originalSnippet TEXT NOT NULL,
  problem       TEXT NOT NULL,
  correction    TEXT NOT NULL,
  timesSeen     INTEGER NOT NULL DEFAULT 1,
  lastSeenAt    TEXT NOT NULL
);
```

**Two kinds of signatures:**
- `pkg:<name>` — matches when that package name appears in the code's imports.
- Any other string — matches when the string appears verbatim in the code (whitespace-normalised).

The database must be seeded with the Stripe `charges.createRefund(` pattern before the example works from memory. After the first live detection by the type-definition agent, the pattern is stored automatically.

**`node:sqlite` loading:** Vitest cannot resolve a bare `node:sqlite` specifier at test time. The module is loaded via `process.getBuiltinModule("node:sqlite")` so only the runtime sees the specifier. `DatabaseSync` does not create parent directories — `mkdirSync(dirname(dbPath), { recursive: true })` is called before every `new DatabaseSync(...)`.

---

## Type-Definition Agent — Property-to-Type-to-Member Resolution

File: [`src/agents/typeDefinitionAgent.ts`](../src/agents/typeDefinitionAgent.ts)

This is the agent that catches the flagship Stripe example.

**Why string search alone fails:**  
`createRefund` exists in Stripe's types — on `ApplicationFeesResource`. A grep for the method name would find it and conclude the method exists. The agent instead:

1. Locates the package's `.d.ts` files via the `types`/`typings` field in `package.json`, then `types/` subdirectory, then package root.
2. Builds a `TypeIndex` with `ts-morph`:
   - `propertyTypes`: maps every property name on every class to its resolved type (e.g. `charges` → `ChargesResource`).
   - `typeMembers`: maps every class/interface name to the set of its declared member names.
3. For each `object.method(` call in the code, looks up `propertyTypes.get(object)` to get the type name, then checks `typeMembers.get(typeName).has(method)`.
4. On a miss, calls `buildSuggestedFix`: splits `createRefund` into verb `create` + noun `Refund`, finds a property whose type name starts with `Refund` (`RefundsResource`) that declares `create`, and emits `Did you mean: refunds.create()`.

The `TypeIndex` is cached in memory per package directory so `.d.ts` files are only parsed once per process.

---

## Sandbox Execution Agent

File: [`src/agents/sandboxExecutionAgent.ts`](../src/agents/sandboxExecutionAgent.ts)

**Container configuration:**

| Option | Value | Reason |
|---|---|---|
| `ReadonlyRootfs` | `true` | Prevents code from modifying the container image |
| `CapDrop` | `["ALL"]` | Removes all Linux capabilities |
| `NetworkMode` | `"none"` | No outbound network access |
| `Memory` | 256 MB | Limits resource consumption |
| `PidsLimit` | 64 | Prevents fork bombs |
| `SecurityOpt` | `["no-new-privileges"]` | Prevents privilege escalation |
| `Tmpfs["/sandbox"]` | `rw,noexec,nosuid,size=64m` | Writable scratch space |

**File injection:** `putArchive` is rejected by Docker 29 when `ReadonlyRootfs` is true, even for tmpfs mounts. The workaround: run a Node.js one-liner via `exec` as root (still sandboxed by all the above), passing the code as a `base64`-encoded environment variable `GT_CODE`, and writing it with `fs.writeFileSync`. Root inside this container has no meaningful privileges.

**Exit code:** Dockerode does not set `stream.id` after `exec.start()`. The `execHandle` reference is captured before calling `start()`, and `execHandle.inspect()` is called after the stream ends to get the real `ExitCode`.

**JavaScript mode:** `.cjs` extension forces CommonJS so `require` works and `"type": "module"` in any parent `package.json` is ignored. Top-level `await` is unsupported in CommonJS, so every JavaScript snippet is wrapped in `(async () => { ... })().catch(...)`.

---

## Bob Integration

### Hook — `scripts/bob-hook.mjs`

Registered as both a `PreToolUse` and `PostToolUse` handler.

**Payload tolerance:** Bob 2.2.0 sends `{hook_event_name, tool_name, tool_input}`. Older versions sent `{event, tool, input}`. The hook tries multiple candidate keys for each field (`event | hook_event_name | hookEventName`, `tool | tool_name | toolName`, `input | tool_input | toolInput | params | arguments`) so it works with both shapes.

**Fail-open policy:** if the guard server is not reachable, the hook exits 0 and writes an UNVERIFIED report. It never silently blocks a write due to infrastructure failure.

**Diff-based edits:** `apply_diff`, `search_and_replace`, and `insert_content` only pass the patch to the hook, not the complete file. The hook cannot reconstruct the full file content and therefore cannot block pre-write — it falls through to PostToolUse and reports after the fact.

### Custom Mode — `examples/checkout-demo/.bob/custom_modes.yaml`

The `groundtruth-verifier` mode:

- Requires reading `.d.ts` before calling SDK methods.
- Self-corrects: reads `last-report.md` on a block and applies the `Fix:` section.
- Permission constraint: `fileRegex: '^(?!\.bob[\/\\]|\.groundtruth[\/\\]).*'` — the mode cannot edit `.bob/` or `.groundtruth/`. It cannot disable or bypass its own guard configuration.

---

## Real Bugs Found and Fixed

### a) Docker 29 rejects `putArchive` on read-only rootfs

**Symptom:** `container.putArchive(tarStream, { path: "/sandbox" })` threw a Docker API error with status 403 even though `/sandbox` was a tmpfs mount explicitly set to `rw`.  
**Root cause:** Docker 29 enforces `ReadonlyRootfs` at the daemon level before checking mount overrides for `putArchive`. The restriction doesn't apply to `exec`.  
**Fix:** `writeCodeFile()` in [`src/agents/sandboxExecutionAgent.ts`](../src/agents/sandboxExecutionAgent.ts) runs a `node -e "require('fs').writeFileSync(...)"` exec call with `GT_CODE` set to the base64-encoded content. The write runs as root but the container has `CapDrop ALL` and `no-new-privileges`.

### b) Exit code always 0

**Symptom:** Even when a snippet threw `TypeError: stripe.charges.createRefund is not a function`, the sandbox agent reported a pass.  
**Root cause:** `exec.start()` returns a stream object. Dockerode does not set `.id` on this stream. The code was doing `execStream.id` to get the exec ID for `inspect()` — that was always `undefined`, so `inspect()` was never called and the exit code defaulted to 0.  
**Fix:** Capture the exec handle from `container.exec(...)` in a closure variable (`execHandle`) before calling `.start()`. After the stream ends, call `execHandle.inspect()` to read `ExitCode`. See [`runExec()`](../src/agents/sandboxExecutionAgent.ts).

### c) Stripe type is `ChargesResource`, not `ChargeResource`

**Symptom:** The type-definition agent couldn't find `ChargesResource` in its index because the code was looking for `ChargeResource` (singular).  
**Root cause:** The type name was assumed from the API surface name (`stripe.charges`). The installed Stripe `.d.ts` declares it as `ChargesResource` (plural).  
**Fix:** The agent derives the type name from the actual installed `.d.ts` files via `ts-morph`, not from inference. `cleanTypeName()` strips qualified prefixes (`Stripe.`, `import(...).`) so the bare name is found in the `typeMembers` map regardless of how the declaration is qualified in source.

### d) IBM Bob 2.2.0 hook payload shape changed

**Symptom:** The hook script was receiving payloads where `event`, `tool`, and `input` were all `undefined`. No files were being verified; the hook silently exited 0 on every call.  
**Root cause:** Bob 2.2.0 changed the payload keys from `{event, tool, input}` to `{hook_event_name, tool_name, tool_input}`.  
**Fix:** The `pick()` helper in [`scripts/bob-hook.mjs`](../scripts/bob-hook.mjs) tries all known key names in priority order. `resolveInput()` additionally handles the case where the value is a JSON string rather than an already-parsed object.

### e) "require is not defined in ES module scope"

**Symptom:** JavaScript snippets submitted for verification failed with `ReferenceError: require is not defined in ES module scope` even though they used `const stripe = require('stripe')`.  
**Root cause:** The sandbox image's base Node.js environment treated `.js` files as ESM because a parent directory had `"type": "module"` in its `package.json`.  
**Fix:** [`resolveExecPlan()`](../src/agents/sandboxExecutionAgent.ts) writes JavaScript snippets as `snippet.cjs`. The `.cjs` extension unconditionally forces CommonJS mode in Node.js, regardless of any `package.json` `type` field.

### f) Top-level `await` broke after switching to `.cjs`

**Symptom:** Snippets using top-level `await` (common in async SDK examples) threw `SyntaxError: await is only valid in async functions` after the `.cjs` fix.  
**Root cause:** CommonJS does not support top-level `await`.  
**Fix:** [`resolveExecPlan()`](../src/agents/sandboxExecutionAgent.ts) wraps every JavaScript snippet in an async IIFE: `(async () => {\n<snippet>\n})().catch(err => { console.error(err); process.exit(1); })`. The wrapper is applied server-side before the code is written to the container; the submitted code is never modified in the report.

### g) `node:sqlite` required two non-obvious workarounds

**Symptom 1:** Vitest tests that imported `patternStore.ts` failed at collection time: `Error: Cannot find module 'node:sqlite'`.  
**Root cause:** Vitest's module resolver does not recognise `node:` built-in specifiers that were added in Node.js 22 when it encounters them as static imports.  
**Fix:** Load the module lazily via `process.getBuiltinModule("node:sqlite")` so the specifier is only evaluated at runtime, never by Vitest's static analyser.

**Symptom 2:** Opening the database at `data/patterns.sqlite` threw `SQLITE_CANTOPEN` when the `data/` directory didn't exist.  
**Root cause:** `DatabaseSync` (and SQLite in general) does not create the parent directory of the database file.  
**Fix:** Call `mkdirSync(dirname(dbPath), { recursive: true })` in `getDb()` before every `new DatabaseSync(dbPath)`.
