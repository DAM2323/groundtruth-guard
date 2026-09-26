# checkout-demo — GroundTruth Guard demo project

This is a minimal Stripe checkout integration used to demonstrate **GroundTruth Guard**:
an AI code verification layer that catches hallucinated API methods before they reach disk.

---

## Setup

### 1. Start the Guard server (project root)

```bash
# In the groundtruth-guard root:
npm run dev
```

The server listens on `http://localhost:3000` by default.  
Keep this terminal open while working in Bob.

### 2. Install dependencies here

```bash
# In this directory (examples/checkout-demo):
npm install
```

### 3. Open THIS folder in Bob

Open `examples/checkout-demo/` as the workspace root — **not** the parent project.  
This ensures the hooks run relative to this directory and don't accidentally verify
the Guard's own source code.

### 4. Check the Hooks tab

In Bob, open **Settings → Hooks**.  
You should see two entries pointing to `node ../../scripts/bob-hook.mjs`:
- **PreToolUse** (timeout 30s) — blocks writes of hallucinated code
- **PostToolUse** (timeout 30s) — verifies edits applied via diff

### 5. Select the mode

Switch to the **🛡️ GroundTruth Verifier** mode from the mode selector.

---

## Demo prompts

### Demo 1 — Hallucination caught before write

Paste this into Bob:

> Agrega un método `refundCharge(chargeId)` a `src/checkout.js` usando  
> `stripe.charges.createRefund({ charge: chargeId })`.

Expected flow:
1. Bob looks up `stripe.charges` in the `.d.ts` → notices `createRefund` is absent.
2. Even if Bob attempts the write, the **PreToolUse hook** blocks it (exit 2).
3. Bob reads `.groundtruth/last-report.md`, sees the correction (`refunds.create()`),
   and rewrites the file with the correct call.
4. The second write passes verification — report says ✅ VERIFICADO.

---

### Demo 2 — Correct code passes on first try

Paste this into Bob:

> Agrega un método `refundCharge(chargeId)` a `src/checkout.js` usando  
> `stripe.refunds.create({ charge: chargeId })`.

Expected flow:
1. Bob writes `src/checkout.js` with the correct call.
2. Hook verifies → ✅ VERIFICADO immediately.

---

### Demo 3 — CI verification

```bash
npm run verify -- src/checkout.js
```

Exits `0` (VERIFIED) or `1` (FAILED). Suitable for pre-commit or CI pipelines.

---

## File structure

```
examples/checkout-demo/
├── .bob/
│   ├── custom_modes.yaml   # 🛡️ GroundTruth Verifier mode
│   └── settings.json       # Hook registrations
├── src/
│   └── checkout.js         # Correct Stripe PaymentIntents example
├── .groundtruth/           # Created at runtime by the Guard
│   ├── last-report.md      # Latest verification report
│   └── hook-log.jsonl      # Full hook invocation log
├── package.json
└── README.md
```
