import express from "express";
import cors from "cors";
import type { VerificationRequest, VerificationReport } from "./types";

const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0" });
});

// ---------------------------------------------------------------------------
// POST /verify — main verification endpoint (stub, agents wired in later)
// ---------------------------------------------------------------------------
app.post("/verify", async (req, res) => {
  const body = req.body as VerificationRequest;

  if (!body.code || !body.language) {
    res.status(400).json({ error: "Missing required fields: code, language" });
    return;
  }

  const report: VerificationReport = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    verdict: "VERIFIED",
    fromMemory: false,
    agentResults: [],
    totalDurationMs: 0,
  };

  res.json(report);
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`groundtruth-guard listening on http://localhost:${PORT}`);
});

export default app;
