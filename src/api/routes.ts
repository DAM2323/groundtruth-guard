import { Router } from "express";
import type { Request, Response } from "express";
import { runVerification } from "../orchestrator";
import { listKnownPatterns } from "../memory/patternStore";
import type { VerificationRequest } from "../types";

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/verify
// ---------------------------------------------------------------------------
router.post("/verify", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Partial<VerificationRequest>;

  if (!body.code) {
    res.status(400).json({ error: "Missing required field: code" });
    return;
  }

  const request: VerificationRequest = {
    code: body.code,
    language: body.language ?? "javascript",
    projectContext: body.projectContext,
  };

  try {
    const report = await runVerification(request);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: "Internal verification error", detail: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/patterns
// ---------------------------------------------------------------------------
router.get("/patterns", (_req: Request, res: Response): void => {
  try {
    const patterns = listKnownPatterns();
    res.json({ patterns });
  } catch (err) {
    res.status(500).json({ error: "Could not read patterns", detail: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------
router.get("/health", (_req: Request, res: Response): void => {
  res.json({ status: "ok", version: "0.1.0" });
});

export default router;
