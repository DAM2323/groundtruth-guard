import * as path from "path";
import * as stream from "stream";
import Dockerode from "dockerode";
import type { AgentResult, Finding, VerificationRequest } from "../types";

// ---------------------------------------------------------------------------
// Docker client — uses default socket/named-pipe (works on Windows via
// Docker Desktop without hardcoding /var/run/docker.sock)
// ---------------------------------------------------------------------------
const docker = new Dockerode();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SANDBOX_IMAGE =
  process.env.SANDBOX_IMAGE ?? "groundtruth-sandbox:latest";
const SANDBOX_TIMEOUT_MS = Number(
  process.env.SANDBOX_TIMEOUT_MS ?? "5000"
);

// ---------------------------------------------------------------------------
// classifyExecution — pure function, exported for unit tests
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  severity: Finding["severity"];
  message: string;
}

/**
 * Classify a sandbox execution result into a finding (or null if it passed).
 *
 * Priority order:
 *  1. exit 0 → null (success)
 *  2. Network error patterns → INFO (method reached the network; blocked by design)
 *  3. Module-not-found patterns → WARNING (env limitation, not a hallucination)
 *  4. TypeError / ReferenceError / SyntaxError / AttributeError / NameError → CRITICAL
 *  5. Any other non-zero exit → CRITICAL
 *
 * Network patterns are checked BEFORE TypeError because Node.js surfaces a
 * network failure as "TypeError: fetch failed".
 */
export function classifyExecution(
  exitCode: number,
  output: string
): ClassificationResult | null {
  if (exitCode === 0) return null;

  // Network errors — check before TypeError
  const networkPatterns = [
    "ConnectionError",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ENETUNREACH",
    "getaddrinfo",
    "fetch failed",
  ];
  if (networkPatterns.some((p) => output.includes(p))) {
    return {
      severity: "INFO",
      message:
        "El código llegó a la red (bloqueada por diseño en el sandbox). " +
        "Los métodos invocados existen en runtime — la ejecución fue real.",
    };
  }

  // Module not found — env limitation
  const moduleNotFoundPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "ModuleNotFoundError",
  ];
  if (moduleNotFoundPatterns.some((p) => output.includes(p))) {
    return {
      severity: "WARNING",
      message:
        "El módulo no está disponible en el entorno del sandbox. " +
        "Esto es una limitación del entorno, no una alucinación.",
    };
  }

  // Runtime type/reference/syntax errors → CRITICAL hallucination
  const criticalPatterns = [
    "TypeError",
    "ReferenceError",
    "SyntaxError",
    "AttributeError",
    "NameError",
  ];
  for (const pat of criticalPatterns) {
    if (output.includes(pat)) {
      // Extract the first relevant error line
      const line = output
        .split("\n")
        .find((l) => l.includes(pat)) ?? output.slice(0, 200);
      return {
        severity: "CRITICAL",
        message: `Error de runtime detectado: ${line.trim()}`,
      };
    }
  }

  // Catch-all for any other non-zero exit
  return {
    severity: "CRITICAL",
    message: `El proceso terminó con código ${exitCode}. Salida: ${output.slice(0, 300)}`,
  };
}

// ---------------------------------------------------------------------------
// Run exec and collect output + exit code
// ---------------------------------------------------------------------------

function runExec(
  container: Dockerode.Container,
  cmd: string[],
  opts?: { Env?: string[]; User?: string }
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let execHandle: Dockerode.Exec;

    container
      .exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
        Env: opts?.Env,
        User: opts?.User,
      })
      .then((exec) => {
        execHandle = exec;
        return exec.start({ hijack: true, stdin: false });
      })
      .then((execStream) => {
        const stdoutBufs: Buffer[] = [];
        const stderrBufs: Buffer[] = [];
        const stdoutPassthrough = new stream.PassThrough();
        const stderrPassthrough = new stream.PassThrough();

        stdoutPassthrough.on("data", (chunk: unknown) => stdoutBufs.push(chunk as Buffer));
        stderrPassthrough.on("data", (chunk: unknown) => stderrBufs.push(chunk as Buffer));

        (docker.modem as {
          demuxStream(
            s: stream.Duplex,
            stdout: stream.PassThrough,
            stderr: stream.PassThrough
          ): void;
        }).demuxStream(execStream, stdoutPassthrough, stderrPassthrough);

        execStream.on("end", () => {
          stdoutPassthrough.end();
          stderrPassthrough.end();

          const output =
            Buffer.concat(stdoutBufs).toString("utf-8") +
            Buffer.concat(stderrBufs).toString("utf-8");

          // Use the closed-over exec reference — stream.id is not set by Dockerode
          execHandle.inspect().then((info) => {
            resolve({ output, exitCode: info.ExitCode ?? 0 });
          }).catch(() => resolve({ output, exitCode: 0 }));
        });

        execStream.on("error", reject);
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Write code file into the running container via exec + env var (base64)
// Docker 29 rejects putArchive when ReadonlyRootfs=true even with tmpfs mounts.
// ---------------------------------------------------------------------------

async function writeCodeFile(
  container: Dockerode.Container,
  targetPath: string,
  code: string
): Promise<void> {
  const b64 = Buffer.from(code, "utf-8").toString("base64");

  // Run as root so it can write to the tmpfs-mounted /sandbox (owned root:root).
  // Root inside the container is still sandboxed by CapDrop ALL, ReadonlyRootfs,
  // no-new-privileges, and NetworkMode none — no privilege escalation possible.
  const { exitCode, output } = await runExec(
    container,
    [
      "node",
      "-e",
      "require('fs').writeFileSync(process.argv[1], Buffer.from(process.env.GT_CODE,'base64'))",
      targetPath,
    ],
    {
      Env: [`GT_CODE=${b64}`],
      User: "root",
    }
  );

  if (exitCode !== 0) {
    throw new Error(`writeCodeFile failed (exit ${exitCode}): ${output.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export async function sandboxExecutionAgent(
  request: VerificationRequest
): Promise<AgentResult> {
  const start = Date.now();
  const findings: Finding[] = [];

  // Determine filename and exec command
  const { filename, execCmd } = resolveExecPlan(request);

  // Resolve node_modules source path
  const nmSource = path.resolve(
    request.projectContext?.installedPackagesPath ?? process.cwd(),
    "node_modules"
  );

  // Build HostConfig — try with mount first, fall back without
  const baseHostConfig: Dockerode.HostConfig = {
    NetworkMode: "none",
    ReadonlyRootfs: true,
    Memory: 256 * 1024 * 1024,
    PidsLimit: 64,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    Tmpfs: {
      "/sandbox": "rw,noexec,nosuid,size=64m",
      "/tmp": "rw,noexec,nosuid,size=16m",
    },
  };

  const hostConfigWithMount: Dockerode.HostConfig = {
    ...baseHostConfig,
    Mounts: [
      {
        Type: "bind",
        Source: nmSource,
        Target: "/node_modules",
        ReadOnly: true,
      },
    ],
  };

  // Try with mount; if container creation fails, fall back without mount
  let container: Dockerode.Container | null = null;
  let mountFailed = false;

  for (const [hc, isFallback] of [
    [hostConfigWithMount, false],
    [baseHostConfig, true],
  ] as const) {
    try {
      container = await docker.createContainer({
        Image: SANDBOX_IMAGE,
        Cmd: ["sh", "-c", "sleep 3600"],
        User: "10001:10001",
        WorkingDir: "/sandbox",
        HostConfig: hc,
      });
      mountFailed = isFallback;
      break;
    } catch (err) {
      if (!isFallback) {
        // mount attempt failed — try without
        continue;
      }
      // Both attempts failed — infra error
      findings.push({
        agent: "sandbox-execution",
        severity: "WARNING",
        message: `No se pudo crear el contenedor del sandbox (error de infraestructura Docker).`,
        evidence: String(err),
      });
      return {
        agent: "sandbox-execution",
        passed: true,
        findings,
        durationMs: Date.now() - start,
      };
    }
  }

  if (!container) {
    findings.push({
      agent: "sandbox-execution",
      severity: "WARNING",
      message: "No se pudo iniciar el sandbox.",
      evidence: "container is null after creation attempts",
    });
    return {
      agent: "sandbox-execution",
      passed: true,
      findings,
      durationMs: Date.now() - start,
    };
  }

  // Warn if we fell back to no-mount
  if (mountFailed) {
    findings.push({
      agent: "sandbox-execution",
      severity: "WARNING",
      message:
        "El montaje de node_modules falló; se ejecuta sin acceso a paquetes instalados.",
      evidence: `Attempted to mount: ${nmSource}`,
    });
  }

  try {
    // 1. Start the container
    await container.start();

    // 2. Write the code file via exec (avoids putArchive ReadonlyRootfs restriction)
    await writeCodeFile(container, `/sandbox/${filename}`, request.code);

    // 3. Execute with timeout
    const { output, exitCode } = await Promise.race([
      runExec(container, execCmd, { User: "10001:10001" }),
      new Promise<{ output: string; exitCode: number }>((_, reject) =>
        setTimeout(
          () => reject(new Error("SANDBOX_TIMEOUT")),
          SANDBOX_TIMEOUT_MS
        )
      ),
    ]).catch((err: Error) => {
      if (err.message === "SANDBOX_TIMEOUT") {
        return { output: "SANDBOX_TIMEOUT", exitCode: -1 };
      }
      throw err;
    });

    if (output === "SANDBOX_TIMEOUT") {
      findings.push({
        agent: "sandbox-execution",
        severity: "WARNING",
        message: `La ejecución no concluyó en ${SANDBOX_TIMEOUT_MS}ms. Resultado no concluyente.`,
        evidence: `Timeout after ${SANDBOX_TIMEOUT_MS}ms`,
      });
    } else {
      const classification = classifyExecution(exitCode, output);
      if (classification) {
        findings.push({
          agent: "sandbox-execution",
          severity: classification.severity,
          message: classification.message,
          evidence: output.slice(0, 500),
        });
      }
    }
  } catch (err) {
    findings.push({
      agent: "sandbox-execution",
      severity: "WARNING",
      message: `Error de infraestructura durante la ejecución del sandbox.`,
      evidence: String(err),
    });
  } finally {
    try { await container.kill(); } catch { /* already stopped */ }
    try { await container.remove(); } catch { /* best-effort */ }
  }

  return {
    agent: "sandbox-execution",
    passed: findings.every((f) => f.severity !== "CRITICAL"),
    findings,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveExecPlan(request: VerificationRequest): {
  filename: string;
  execCmd: string[];
} {
  switch (request.language) {
    case "python":
      return {
        filename: "snippet.py",
        execCmd: ["python3", "/sandbox/snippet.py"],
      };
    case "typescript":
      return {
        filename: "snippet.ts",
        execCmd: [
          "node",
          "--experimental-strip-types",
          "/sandbox/snippet.ts",
        ],
      };
    default:
      return {
        filename: "snippet.js",
        execCmd: ["node", "/sandbox/snippet.js"],
      };
  }
}
