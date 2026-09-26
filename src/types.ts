/** Severity level of a finding produced by a verification agent. */
export type Severity = "CRITICAL" | "WARNING" | "INFO";

/**
 * Identifier for each built-in verification agent.
 *  - package-registry   : checks that referenced packages / versions exist on npm/PyPI
 *  - type-definition    : validates API shapes against real type declarations
 *  - sandbox-execution  : runs the snippet in an isolated container and inspects output
 *  - security-scan      : detects known vulnerability patterns
 *  - team-memory        : cross-references previously seen hallucination signatures
 */
export type AgentName =
  | "package-registry"
  | "type-definition"
  | "sandbox-execution"
  | "security-scan"
  | "team-memory";

/**
 * A single issue detected by an agent.
 *
 * @property agent         - Which agent raised this finding.
 * @property severity      - How critical the finding is.
 * @property message       - Human-readable description of the problem.
 * @property evidence      - Raw snippet / diff / output that supports the claim.
 * @property suggestedFix  - Optional corrected version of the offending code.
 * @property signature     - Minimal string signature of the hallucination
 *                           (e.g. "charges.createRefund(" or "pkg:nombre").
 *                           Used to deduplicate and index patterns in the DB.
 */
export interface Finding {
  agent: AgentName;
  severity: Severity;
  message: string;
  evidence: string;
  suggestedFix?: string;
  signature?: string;
}

/** Full result returned by a single verification agent. */
export interface AgentResult {
  agent: AgentName;
  passed: boolean;
  findings: Finding[];
  durationMs: number;
}

/** Payload sent to the /verify endpoint. */
export interface VerificationRequest {
  code: string;
  language: "javascript" | "typescript" | "python";
  projectContext?: {
    /**
     * Absolute or relative path to node_modules / site-packages so agents
     * can inspect locally installed packages rather than hitting the network.
     */
    installedPackagesPath?: string;
  };
}

/**
 * The final verification report returned to the caller.
 *
 * @property id              - UUID for this report.
 * @property createdAt       - ISO-8601 timestamp.
 * @property verdict         - "VERIFIED" if all agents passed, "FAILED" otherwise.
 * @property fromMemory      - true when the verdict was served from the pattern cache
 *                             without re-running agents.
 * @property agentResults    - Individual results from each agent that ran.
 * @property totalDurationMs - Wall-clock time for the entire verification pipeline.
 */
export interface VerificationReport {
  id: string;
  createdAt: string;
  verdict: "VERIFIED" | "FAILED";
  fromMemory: boolean;
  agentResults: AgentResult[];
  totalDurationMs: number;
}

/**
 * A hallucination pattern stored in the local SQLite database.
 *
 * @property hash            - SHA-256 of the signature (primary key).
 * @property signature       - Minimal string that identifies the hallucination.
 * @property originalSnippet - The hallucinated code that triggered the entry.
 * @property problem         - Description of why it is wrong.
 * @property correction      - The correct replacement.
 * @property timesSeen       - How many times this pattern has been matched.
 * @property lastSeenAt      - ISO-8601 timestamp of the most recent match.
 */
export interface KnownPattern {
  hash: string;
  signature: string;
  originalSnippet: string;
  problem: string;
  correction: string;
  timesSeen: number;
  lastSeenAt: string;
}
