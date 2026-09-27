# GroundTruth Guard

A verification pipeline that checks AI-generated code against real sources before it lands on disk.

## The Problem It Solves

AI coding assistants generate code that sounds plausible but isn't real. Two failure modes are common:

1. **Hallucinated methods** — the AI calls a method that does not exist on the object it names. The code compiles, linters don't flag it, and it only blows up at runtime.
2. **Hallucinated packages (slopsquatting)** — the AI invents a package name that doesn't exist on npm or PyPI. A typosquatter may have already registered that name with malicious code.

### The Flagship Example

```typescript
// AI-generated code — looks reasonable, fails at runtime
const refund = await stripe.charges.createRefund({ charge: 'ch_xxx', amount: 500 });
```

`stripe.charges.createRefund()` does not exist. The real method is `stripe.refunds.create()`.

A naive check that searches for the string `"createRefund"` in the type definitions would still miss this, because `createRefund` **does** exist — on `ApplicationFeesResource`, not on `ChargesResource`. The guard resolves the chain correctly: `stripe.charges` → property type `ChargesResource` → members of `ChargesResource` → no `createRefund`. That's what catches it.

---

## Architecture

The pipeline has two stages. Team memory is checked first; if nothing is known, four agents run in parallel.

```
                  ┌─────────────────────┐
  code + language │   Team Memory       │  node:sqlite, indexed by signature hash
  ──────────────▶ │   (checked first)   │──▶ FAILED immediately if known
                  └──────────┬──────────┘
                             │ (cache miss)
                  ┌──────────▼──────────────────────────────────────┐
                  │              4 Agents in parallel                │
                  │                                                  │
                  │  ① Package Registry   ② Type Definitions        │
                  │    npm/PyPI existence    ts-morph on real .d.ts  │
                  │                         property → type → member │
                  │  ③ Sandbox Execution  ④ Security Scan           │
                  │    isolated Docker       pattern-based checks    │
                  │    container, no net     (eval, exec, hardcoded  │
                  │                          secrets, etc.)          │
                  └──────────┬──────────────────────────────────────┘
                             │
                  ┌──────────▼──────────┐
                  │    Orchestrator     │  src/orchestrator.ts
                  │    builds report   │  confirms hallucinations
                  │    stores to DB    │  back into team memory
                  └──────────┬─────────┘
                             │
             ┌───────────────┼────────────────┐
             ▼               ▼                ▼
       POST /api/verify   Bob hook        Dashboard
       (Express API)      exit 2 blocks   localhost:3000
```

**Team memory** is a local SQLite database (`node:sqlite`, stored in `data/patterns.sqlite`). Every confirmed hallucination is stored by its minimal signature (e.g. `charges.createRefund(`). The next time any AI writes code containing that signature, the pipeline short-circuits and returns the known correction instantly, without re-running the agents.

**Agent ①: Package Registry** — extracts `import`/`require` package names and checks them against the npm registry (or PyPI). Flags packages that don't exist or whose versions are invalid.

**Agent ②: Type Definitions** — uses `ts-morph` to parse the installed `.d.ts` files in `node_modules`. It resolves `object.property` → type name → declared members. If the called method is not in the member set of the resolved type, it's a CRITICAL finding.

**Agent ③: Sandbox Execution** — starts a Docker container (`groundtruth-sandbox:latest`) with `ReadonlyRootfs`, `CapDrop ALL`, `NetworkMode none`, memory limit 256 MB, and a tmpfs `/sandbox`. The code snippet runs inside and any `TypeError`, `ReferenceError`, or `SyntaxError` is a CRITICAL finding. The container is killed and removed after every run.

**Agent ④: Security Scan** — applies regex-based checks for patterns such as `eval()`, `exec()`, hardcoded secrets, and a short list of known malicious package name patterns.

---

## IBM Bob Integration

### PreToolUse Hook — blocks hallucinated writes

[`scripts/bob-hook.mjs`](scripts/bob-hook.mjs) is registered as a Bob lifecycle hook. Every time Bob calls a file-writing tool (`write_file`, `apply_diff`, etc.), the hook:

1. Reads the file content and language from the tool input.
2. POSTs it to `http://localhost:3000/api/verify`.
3. Writes a Markdown report to `.groundtruth/last-report.md`.
4. If the verdict is `FAILED`, exits with code **2** — Bob blocks the write and shows the reason.
5. If the guard server is **down**, exits with code **0** (never blocks silently). The report is written as UNVERIFIED.

**Known limitation for diff-based edits:** if Bob writes a file via `apply_diff` or `search_and_replace`, the hook only receives the patch, not the complete file content. It cannot inspect the full file and therefore cannot block before the write — it can only report after. The `write_file` tool always provides the complete content and is fully protected.

### Custom Mode — "GroundTruth Verifier"

[`examples/checkout-demo/.bob/custom_modes.yaml`](examples/checkout-demo/.bob/custom_modes.yaml) defines a mode that:

- Requires the AI to read `.d.ts` declarations before calling any SDK method.
- Self-corrects automatically when a write is blocked (reads `last-report.md` and applies the fix).
- **Cannot edit `.bob/` or `.groundtruth/`** — the file regex restriction prevents the mode from disabling its own guard.

---

## How to Run

### Prerequisites

- Node.js ≥ 22.5.0
- Docker Desktop running

### Install

```bash
npm install
```

### Build the sandbox image

```bash
docker build -t groundtruth-sandbox:latest docker/
```

### Start the server

```bash
npm run dev
```

The API listens on `http://localhost:3000`.

### Run tests

```bash
npm test          # 52/52 must pass
npm run typecheck # zero TypeScript errors
```

### Smoke test against the live API

```powershell
$body = '{"code":"const stripe = require(\"stripe\")(\"sk_test\");\nstripe.charges.createRefund({charge:\"ch_xxx\"});","language":"javascript","projectContext":{"installedPackagesPath":"examples/checkout-demo"}}'
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/verify `
  -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 10
```

Expected: `verdict: "FAILED"`, finding from `type-definition` agent naming `ChargesResource` and suggesting `refunds.create()`.

### Dashboard

Open `dashboard/index.html` in a browser while the server is running to see live verification results.

---

## Real Bugs Found and Fixed During Development

These are problems that actually happened while building this project, stated plainly.

**a) Docker 29 rejects `putArchive` on a read-only rootfs.**  
Even after mounting a tmpfs at `/sandbox`, Docker 29 refuses `putArchive` calls when `ReadonlyRootfs: true` is set on the container. Fixed by writing the file via an `exec` call instead: a one-liner Node.js command reads the code from a `base64`-encoded environment variable and writes it with `fs.writeFileSync`.

**b) Sandbox exit code always reported 0.**  
Dockerode does not expose the exec ID on the stream object it returns from `exec.start()`. Reading `stream.id` was always undefined, so the inspect call was never made and exit code defaulted to 0. Fixed by closing over the `exec` handle created before `start()` and calling `exec.inspect()` after the stream ends.

**c) Stripe's real type is `ChargesResource` (plural), not `ChargeResource`.**  
The type name was assumed from first principles. The installed `.d.ts` files say `ChargesResource`. The agent reads the actual type declarations rather than guessing, which is how the flagship example gets caught correctly.

**d) IBM Bob 2.2.0 sends hook payloads as `{hook_event_name, tool_name, tool_input}`, not `{event, tool, input}`.**  
The hook script was initially written for an older payload shape. Fixed by making the parser try multiple candidate key names (`event | hook_event_name | hookEventName`, `tool | tool_name | toolName`, etc.) so it works regardless of which Bob version is running.

**e) JavaScript snippets failed with "require is not defined in ES module scope".**  
Node.js treated `.js` files as ESM because the project's `package.json` has `"type": "module"` in the sandbox environment. Fixed by writing snippets as `.cjs`, which forces CommonJS mode unconditionally.

**f) After fixing (e), top-level `await` broke.**  
CommonJS does not support top-level `await`. Snippets that used it at the top level threw a `SyntaxError`. Fixed by wrapping every JavaScript snippet in an async IIFE: `(async () => { <snippet> })().catch(...)`.

**g) `node:sqlite` required two non-obvious workarounds.**  
First, Vitest cannot resolve a bare `node:sqlite` import at test time. Fixed by loading it via `process.getBuiltinModule("node:sqlite")` at runtime so Vitest never sees the specifier. Second, `DatabaseSync` does not create the parent directory of the database file. Fixed by calling `mkdirSync(dirname(dbPath), { recursive: true })` before opening the database.

---

## Known Limitations

- **Diff-based edits:** when Bob writes via `apply_diff` or `search_and_replace`, the hook receives only the patch. The full file cannot be inspected before the write, so blocking is not possible for those tool calls — only post-write reporting.
- **Dashboard:** runs on `localhost:3000` only. There is no public deployment.
- **Python type verification:** the type-definition agent skips Python files. Python is out of scope.
- **Security scanner:** covers a small set of explainable patterns (eval, exec, hardcoded secrets, a few known-malicious package names). It is not a full SAST tool.

---

## License

[MIT](LICENSE) © 2026 Juan David Porras Aliano
