# Bob Session Screenshots

This folder contains screenshots taken during the IBM Bob sessions used to build GroundTruth Guard. Each screenshot was captured at a meaningful point in a task to document what Bob produced or what problem was encountered.

There is no screenshot for task 10.

---

## File Map

| File | Task | What it shows |
|---|---|---|
| `groundtruthguard_task01_base.png` | **Task 01 — Project scaffold** | Bob creates the initial project structure: `package.json`, `tsconfig.json`, `src/` layout, and the Express entry point `src/index.ts`. |
| `groundtruthguard_task02_registro.png` | **Task 02 — Package Registry agent** | Bob implements `src/agents/packageRegistryAgent.ts`. The screenshot shows the agent extracting `import`/`require` names and fetching the npm registry to verify they exist. |
| `groundtruthguard_task03_tipos.png` | **Task 03 — Type Definition agent** | Bob implements `src/agents/typeDefinitionAgent.ts` with `ts-morph`. The screenshot captures the property-to-type-to-member resolution logic and the `buildSuggestedFix` function being written. |
| `groundtruthguard_task04_seguridad_memoria.png` | **Task 04 — Security Scan agent + Team Memory** | Bob implements `src/agents/securityScanAgent.ts` and `src/memory/patternStore.ts`. The screenshot shows the SQLite schema and the `findMatchingPatterns` / `recordConfirmedHallucination` functions. |
| `groundtruthguard_task05_sandbox.png` | **Task 05 — Sandbox Execution agent (initial)** | Bob's first implementation of `src/agents/sandboxExecutionAgent.ts` using `container.putArchive()` to inject the code file. This is the version that broke on Docker 29 with `ReadonlyRootfs: true`. |
| `groundtruthguard_task05b_sandbox_fix.png` | **Task 05b — Sandbox fix (exec + base64)** | Bob fixes the `putArchive` failure by rewriting `writeCodeFile()` to use a Node.js `exec` call with the code in a base64 environment variable. Also shows the `exec.inspect()` fix for the exit code always reporting 0. |
| `groundtruthguard_task06_orquestador.png` | **Task 06 — Orchestrator** | Bob implements `src/orchestrator.ts`: the two-stage pipeline (team memory first, then four agents in parallel via `Promise.all`), verdict building, and persisting confirmed hallucinations back to the database. |
| `groundtruthguard_task07_dashboard.png` | **Task 07 — Dashboard** | Bob creates `dashboard/index.html`. The screenshot shows the live dashboard connected to the running API, displaying the pipeline result for the Stripe `charges.createRefund()` example. |
| `groundtruthguard_task08_hook.png` | **Task 08 — Bob hook** | Bob implements `scripts/bob-hook.mjs`. The screenshot shows the hook being tested by piping a representative Bob 2.2.0 payload into it on stdin, confirming it extracts `hook_event_name`, `tool_name`, and `tool_input` correctly. |
| `groundtruthguard_task09_demo.png` | **Task 09 — End-to-end demo** | Bob opens the `examples/checkout-demo` workspace in the GroundTruth Verifier mode and writes a file containing `stripe.charges.createRefund()`. The screenshot captures the hook blocking the write (exit code 2) and the `last-report.md` report. |
| `groundtruthguard_task11_demo.png` | **Task 11 — Full demo re-run** | Bob re-runs the end-to-end demonstration after all fixes are in place. The screenshot shows a clean VERIFIED result for correct Stripe code (`stripe.refunds.create()`) and a FAILED result for the hallucinated call. |
| `groundtruthguard_task11_hook_fix.png` | **Task 11 — Hook payload shape fix** | Bob fixes the hook parser after discovering that Bob 2.2.0 changed the payload keys. The `pick()` helper and `resolveInput()` function are updated to try multiple candidate key names. |
| `groundtruthguard_task11_translate.png` | **Task 11 — Documentation translation** | Bob translates inline comments and log messages in `scripts/bob-hook.mjs` and `scripts/guard-client.mjs` from Spanish to English for the public repository. |
| `hooks-panel.png` | **Reference — Bob Hooks UI** | Screenshot of the Bob Settings > Hooks panel showing the two global hooks (PreToolUse and PostToolUse) as inactive, and "Workspace hooks for checkout-demo (0 active)". Used to diagnose the incorrect settings format in `examples/checkout-demo/.bob/settings.json` and confirm the correct nested schema from the global settings file. |
