import express from "express";
import cors from "cors";
import path from "path";
import apiRouter from "./api/routes";
import { buildTypeIndex } from "./agents/typeDefinitionAgent";

const PORT = Number(process.env.PORT ?? 3000);
const PREWARM_PACKAGES = (process.env.PREWARM_PACKAGES ?? "stripe")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// API routes — mounted at /api
// ---------------------------------------------------------------------------
app.use("/api", apiRouter);

// ---------------------------------------------------------------------------
// Static dashboard
// ---------------------------------------------------------------------------
const dashboardDir = path.join(__dirname, "..", "dashboard");
app.use(express.static(dashboardDir));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`groundtruth-guard listening on http://localhost:${PORT}`);

  // Pre-warm type indexes after the event loop is free so the port is bound first
  setImmediate(() => {
    const prewarmRoots = [
      process.cwd(),
      path.join(process.cwd(), "examples", "checkout-demo"),
    ];

    for (const root of prewarmRoots) {
      for (const pkg of PREWARM_PACKAGES) {
        const pkgDir = path.join(root, "node_modules", pkg);
        const t0 = Date.now();
        try {
          buildTypeIndex(pkgDir);
          console.log(
            `[prewarm] ${pkg} @ ${path.relative(process.cwd(), root) || "."} — ${Date.now() - t0}ms`
          );
        } catch {
          // Directory may not exist for examples/checkout-demo — skip silently
        }
      }
    }
  });
});

export default app;
