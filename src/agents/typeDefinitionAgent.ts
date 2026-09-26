import * as path from "path";
import * as fs from "fs";
import { Project, SyntaxKind } from "ts-morph";
import type { AgentResult, Finding, VerificationRequest } from "../types";

// ---------------------------------------------------------------------------
// Type index
// ---------------------------------------------------------------------------

interface TypeIndex {
  /** property name (e.g. "charges") -> resolved type name (e.g. "ChargesResource") */
  propertyTypes: Map<string, string>;
  /** type name -> set of declared member names */
  typeMembers: Map<string, Set<string>>;
}

/** Per-package-dir cache so we only parse .d.ts files once per process. */
const indexCache = new Map<string, TypeIndex>();

/**
 * Strip generic parameters and any leading qualifiers so we are left with
 * just the bare class/interface name.
 *
 * Examples handled:
 *   "Stripe.ChargesResource"                      -> "ChargesResource"
 *   "ChargesResource"                             -> "ChargesResource"
 *   'import("stripe").Stripe.ChargesResource'     -> "ChargesResource"
 *   "Promise<Stripe.Charge>"                      -> kept as-is (generic, not a resource name)
 */
function cleanTypeName(raw: string): string {
  // Remove import(...). prefix: import("stripe").Stripe.ChargesResource -> Stripe.ChargesResource
  const withoutImport = raw.replace(/^import\([^)]+\)\./, "");
  // Remove remaining leading qualifier segments (e.g. "Stripe.")
  const stripped = withoutImport.replace(/^(?:[A-Za-z_$][A-Za-z0-9_$]*\.)+/, "");
  // Remove generic parameters
  return stripped.replace(/<[^>]*>/g, "").trim();
}

/**
 * Build a TypeIndex for the given package directory by loading all .d.ts files
 * with ts-morph and walking class/interface declarations.
 */
export function buildTypeIndex(packageDir: string): TypeIndex {
  if (indexCache.has(packageDir)) {
    return indexCache.get(packageDir)!;
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { skipLibCheck: true },
  });

  // Add all .d.ts files, but skip nested node_modules directories
  const dtsFiles = collectDtsFiles(packageDir);
  project.addSourceFilesAtPaths(dtsFiles);

  const propertyTypes = new Map<string, string>();
  const typeMembers = new Map<string, Set<string>>();

  for (const sf of project.getSourceFiles()) {
    // Walk all class and interface declarations, including those nested inside
    // module/namespace blocks (which stripe uses via declare module 'stripe').
    const classes = sf.getDescendantsOfKind(SyntaxKind.ClassDeclaration);
    const interfaces = sf.getDescendantsOfKind(SyntaxKind.InterfaceDeclaration);

    for (const cls of classes) {
      const name = cls.getName();
      if (!name) continue;
      if (!typeMembers.has(name)) typeMembers.set(name, new Set());
      const members = typeMembers.get(name)!;
      for (const m of cls.getMembers()) {
        const mName = (m as { getName?: () => string }).getName?.();
        if (mName) members.add(mName);
      }
      // Also collect properties whose types point to Resource classes
      for (const prop of cls.getProperties()) {
        const propName = prop.getName();
        const typeText = prop.getType().getText();
        const cleaned = cleanTypeName(typeText);
        if (cleaned && !propertyTypes.has(propName)) {
          propertyTypes.set(propName, cleaned);
        }
      }
    }

    for (const iface of interfaces) {
      const name = iface.getName();
      if (!name) continue;
      if (!typeMembers.has(name)) typeMembers.set(name, new Set());
      const members = typeMembers.get(name)!;
      for (const m of iface.getMembers()) {
        const mName = (m as { getName?: () => string }).getName?.();
        if (mName) members.add(mName);
      }
    }
  }

  const idx: TypeIndex = { propertyTypes, typeMembers };
  indexCache.set(packageDir, idx);
  return idx;
}

/** Recursively collect .d.ts files, skipping nested node_modules. */
function collectDtsFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectDtsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Method-call extraction
// ---------------------------------------------------------------------------

/**
 * Returns unique "object.method" pairs found in `code`.
 * Matches patterns like `foo.bar(` where both sides are identifiers.
 */
export function extractMethodCalls(
  code: string
): Array<{ object: string; method: string }> {
  const re = /\b([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  const seen = new Set<string>();
  const results: Array<{ object: string; method: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const key = `${m[1]}.${m[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ object: m[1], method: m[2] });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Suggestion logic
// ---------------------------------------------------------------------------

/**
 * Given a method name that doesn't exist on its resolved type, try to find a
 * better suggestion in the type index.
 *
 * Strategy:
 *  1. If method looks like verbNoun (e.g. "createRefund"), split into
 *     verb="create" and noun="Refund".
 *  2. Find a property whose resolved type starts with noun (e.g. "RefundsResource")
 *     and declares the verb ("create") -> suggest "<prop>.create()".
 *  3. List any other property.type that DOES declare the exact method name.
 */
function buildSuggestedFix(
  object: string,
  method: string,
  idx: TypeIndex
): string | undefined {
  const lines: string[] = [];

  // Split verbNoun
  const verbNounRe = /^([a-z]+)([A-Z][a-zA-Z]*)$/;
  const match = verbNounRe.exec(method);
  if (match) {
    const verb = match[1]; // "create"
    const noun = match[2]; // "Refund"

    // Find a property whose type name starts with the noun (case-insensitive prefix)
    for (const [propName, typeName] of idx.propertyTypes) {
      if (
        typeName.toLowerCase().startsWith(noun.toLowerCase()) &&
        idx.typeMembers.get(typeName)?.has(verb)
      ) {
        lines.push(`Quisiste decir: ${propName}.${verb}()`);
        break;
      }
    }
  }

  // List where the exact method exists
  const existsOn: string[] = [];
  for (const [propName, typeName] of idx.propertyTypes) {
    if (propName !== object && idx.typeMembers.get(typeName)?.has(method)) {
      existsOn.push(`${propName}.${method}() (existe, pero en ${typeName})`);
    }
  }
  if (existsOn.length > 0) {
    lines.push(...existsOn);
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export async function typeDefinitionAgent(
  request: VerificationRequest
): Promise<AgentResult> {
  const start = Date.now();
  const findings: Finding[] = [];

  // Python is out of scope
  if (request.language === "python") {
    return {
      agent: "type-definition",
      passed: true,
      findings: [],
      durationMs: Date.now() - start,
    };
  }

  const projectRoot =
    request.projectContext?.installedPackagesPath ?? process.cwd();
  const nodeModulesDir = path.join(projectRoot, "node_modules");

  // Extract packages from code to know which ones to check
  const { extractPackageNames } = await import("./packageRegistryAgent");
  const packages = extractPackageNames(request.code, request.language);

  const calls = extractMethodCalls(request.code);
  if (calls.length === 0 || packages.length === 0) {
    return {
      agent: "type-definition",
      passed: true,
      findings: [],
      durationMs: Date.now() - start,
    };
  }

  for (const pkg of packages) {
    // Find types directory for this package
    const pkgDir = path.join(nodeModulesDir, pkg);
    const typesDir = resolveTypesDir(pkgDir, pkg, nodeModulesDir);

    if (!typesDir) {
      findings.push({
        agent: "type-definition",
        severity: "WARNING",
        message: `No se encontraron tipos para el paquete "${pkg}". Verifica que @types/${pkg} esté instalado.`,
        evidence: `No .d.ts files found under ${pkgDir}`,
      });
      continue;
    }

    let idx: TypeIndex;
    try {
      idx = buildTypeIndex(typesDir);
    } catch {
      findings.push({
        agent: "type-definition",
        severity: "WARNING",
        message: `Error al parsear los tipos de "${pkg}".`,
        evidence: `buildTypeIndex failed for ${typesDir}`,
      });
      continue;
    }

    for (const { object, method } of calls) {
      const resolvedType = idx.propertyTypes.get(object);
      if (!resolvedType) {
        // Object doesn't map to any known type in this package — skip (avoid false positives)
        continue;
      }

      const members = idx.typeMembers.get(resolvedType);
      if (!members) {
        // Type exists in property map but has no members parsed — skip
        continue;
      }

      if (!members.has(method)) {
        const realMethods = Array.from(members)
          .filter((m) => !m.startsWith("_"))
          .sort()
          .join(", ");

        const suggestedFix = buildSuggestedFix(object, method, idx);

        findings.push({
          agent: "type-definition",
          severity: "CRITICAL",
          message: `"${object}.${method}()" no existe: ${resolvedType} (del paquete ${pkg}) no declara "${method}".`,
          evidence: `Métodos reales de ${resolvedType}: ${realMethods}`,
          suggestedFix,
          signature: `${object}.${method}(`,
        });
      }
    }
  }

  return {
    agent: "type-definition",
    passed: findings.every((f) => f.severity !== "CRITICAL"),
    findings,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the directory that contains .d.ts files for the given package.
 * Checks (in order):
 *  1. package.json "types" / "typings" field
 *  2. A `types/` subdirectory
 *  3. The package root itself
 */
function resolveTypesDir(
  pkgDir: string,
  _pkg: string,
  _nodeModulesDir: string
): string | null {
  if (!fs.existsSync(pkgDir)) return null;

  // Try package.json types field
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
        types?: string;
        typings?: string;
      };
      const typesEntry = pkgJson.types ?? pkgJson.typings;
      if (typesEntry) {
        const resolved = path.dirname(path.join(pkgDir, typesEntry));
        if (fs.existsSync(resolved)) return resolved;
      }
    } catch {
      // fall through
    }
  }

  // Try a types/ subdirectory
  const typesSub = path.join(pkgDir, "types");
  if (fs.existsSync(typesSub)) return typesSub;

  // Fall back to package root
  const hasDts = collectDtsFiles(pkgDir).length > 0;
  return hasDts ? pkgDir : null;
}
