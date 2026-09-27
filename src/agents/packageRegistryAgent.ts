import type { AgentResult, Finding, VerificationRequest } from "../types";

// ---------------------------------------------------------------------------
// Package name extraction
// ---------------------------------------------------------------------------

/**
 * Returns the unique set of third-party package names referenced in `code`.
 *
 * JS/TS rules:
 *  - `import ... from "pkg"` / `import "pkg"`
 *  - `require("pkg")`
 *  - Relative imports (`./x`, `../x`) are ignored.
 *  - Scoped packages (`@org/pkg`) are preserved as a single token.
 *
 * Python rules:
 *  - `import pkg`
 *  - `from pkg import ...`
 *  - Only the top-level distribution name is returned (e.g. `os`, `sys`).
 */
export function extractPackageNames(
  code: string,
  language: VerificationRequest["language"]
): string[] {
  const names = new Set<string>();

  if (language === "javascript" || language === "typescript") {
    // ES import: import ... from "pkg"  |  import "pkg"
    const esImport = /(?:^|;|\n)\s*import\s+(?:[^"']*\s+from\s+)?["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = esImport.exec(code)) !== null) {
      const spec = m[1];
      if (!spec.startsWith(".")) names.add(packageRoot(spec));
    }

    // CommonJS require: require("pkg")
    const cjsRequire = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = cjsRequire.exec(code)) !== null) {
      const spec = m[1];
      if (!spec.startsWith(".")) names.add(packageRoot(spec));
    }
  } else {
    // Python: import pkg  |  from pkg import something
    const pyImport = /^(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
    let m: RegExpExecArray | null;
    while ((m = pyImport.exec(code)) !== null) {
      names.add(m[1]);
    }
  }

  return Array.from(names);
}

/**
 * Given an import specifier, return only the installable package root.
 *   "lodash/fp"   -> "lodash"
 *   "@org/pkg"    -> "@org/pkg"
 *   "@org/pkg/x"  -> "@org/pkg"
 */
function packageRoot(spec: string): string {
  if (spec.startsWith("@")) {
    // scoped: keep first two path segments
    const parts = spec.split("/");
    return parts.slice(0, 2).join("/");
  }
  // unscoped: keep only first path segment
  return spec.split("/")[0];
}

// ---------------------------------------------------------------------------
// Registry lookup
// ---------------------------------------------------------------------------

async function checkNpm(pkg: string): Promise<404 | 200 | "network-error"> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}`);
    return res.status === 404 ? 404 : 200;
  } catch {
    return "network-error";
  }
}

async function checkPypi(pkg: string): Promise<404 | 200 | "network-error"> {
  try {
    const res = await fetch(`https://pypi.org/pypi/${pkg}/json`);
    return res.status === 404 ? 404 : 200;
  } catch {
    return "network-error";
  }
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export async function packageRegistryAgent(
  request: VerificationRequest
): Promise<AgentResult> {
  const start = Date.now();
  const packages = extractPackageNames(request.code, request.language);
  const findings: Finding[] = [];

  const isPython = request.language === "python";

  await Promise.all(
    packages.map(async (pkg) => {
      const status = isPython ? await checkPypi(pkg) : await checkNpm(pkg);

      if (status === 404) {
        findings.push({
          agent: "package-registry",
          severity: "CRITICAL",
          message: `Package "${pkg}" does not exist in the real registry.`,
          evidence: isPython
            ? `GET https://pypi.org/pypi/${pkg}/json → 404`
            : `GET https://registry.npmjs.org/${pkg} → 404`,
          suggestedFix:
            `Do not install "${pkg}" blindly: it may be a package invented by the AI ` +
            `(slopsquatting). Verify the exact name in the official registry before running npm install / pip install.`,
          signature: `pkg:${pkg}`,
        });
      } else if (status === "network-error") {
        findings.push({
          agent: "package-registry",
          severity: "WARNING",
          message: `Could not verify package "${pkg}" (network error).`,
          evidence: `fetch failed for ${pkg}`,
          signature: `pkg:${pkg}`,
        });
      }
    })
  );

  return {
    agent: "package-registry",
    passed: findings.every((f) => f.severity !== "CRITICAL"),
    findings,
    durationMs: Date.now() - start,
  };
}
