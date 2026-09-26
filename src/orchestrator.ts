import { randomUUID } from "crypto";
import type {
  AgentResult,
  Finding,
  VerificationReport,
  VerificationRequest,
} from "./types";
import { packageRegistryAgent, extractPackageNames } from "./agents/packageRegistryAgent";
import { typeDefinitionAgent } from "./agents/typeDefinitionAgent";
import { sandboxExecutionAgent } from "./agents/sandboxExecutionAgent";
import { securityScanAgent } from "./agents/securityScanAgent";
import {
  findMatchingPatterns,
  bumpPattern,
  recordConfirmedHallucination,
} from "./memory/patternStore";

// ---------------------------------------------------------------------------
// Agents that can produce hallucination-class findings worth storing.
// Security and sandbox findings are real runtime signals, not hallucinations.
// ---------------------------------------------------------------------------
const HALLUCINATION_AGENTS = new Set<string>(["type-definition", "package-registry"]);

// ---------------------------------------------------------------------------
// runVerification — single entry point for the full pipeline
// ---------------------------------------------------------------------------

export async function runVerification(
  request: VerificationRequest
): Promise<VerificationReport> {
  const pipelineStart = Date.now();

  // 1. Check team memory first -----------------------------------------------
  const importedPackages = extractPackageNames(request.code, request.language);
  const knownPatterns = findMatchingPatterns(request.code, importedPackages);

  if (knownPatterns.length > 0) {
    // Bump the seen counters for all matched patterns
    for (const p of knownPatterns) {
      bumpPattern(p.signature);
    }

    // Build a single AgentResult representing the memory hit
    const findings: Finding[] = knownPatterns.map((p) => ({
      agent: "team-memory" as const,
      severity: "CRITICAL" as const,
      message: `Alucinación ya conocida por el equipo: ${p.problem}`,
      evidence: `Firma: "${p.signature}" — vista ${p.timesSeen + 1} veces`,
      suggestedFix: p.correction,
      signature: p.signature,
    }));

    const memoryResult: AgentResult = {
      agent: "team-memory",
      passed: false,
      findings,
      durationMs: Date.now() - pipelineStart,
    };

    return {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      verdict: "FAILED",
      fromMemory: true,
      agentResults: [memoryResult],
      totalDurationMs: Date.now() - pipelineStart,
    };
  }

  // 2. Run all 4 agents in parallel -------------------------------------------
  const [registryResult, typeResult, sandboxResult, securityResult] =
    await Promise.all([
      packageRegistryAgent(request),
      typeDefinitionAgent(request),
      sandboxExecutionAgent(request),
      securityScanAgent(request),
    ]);

  const agentResults: AgentResult[] = [
    registryResult,
    typeResult,
    sandboxResult,
    securityResult,
  ];

  // 3. Persist confirmed hallucinations to memory ----------------------------
  // Only CRITICAL findings from hallucination agents that carry a signature.
  for (const result of agentResults) {
    if (!HALLUCINATION_AGENTS.has(result.agent)) continue;
    for (const finding of result.findings) {
      if (finding.severity === "CRITICAL" && finding.signature) {
        recordConfirmedHallucination(
          finding.signature,
          request.code,
          finding.message,
          finding.suggestedFix ?? finding.message
        );
      }
    }
  }

  // 4. Build report -----------------------------------------------------------
  const allPassed = agentResults.every((r) => r.passed);

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    verdict: allPassed ? "VERIFIED" : "FAILED",
    fromMemory: false,
    agentResults,
    totalDurationMs: Date.now() - pipelineStart,
  };
}
