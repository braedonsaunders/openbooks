/**
 * Curated target/test mapping for the mutation harness.
 *
 * Explicit `mutation.config.json` entries win. A target with no entry falls
 * back to every `*.test.ts` / `*.integration.test.ts` next to it (excluding
 * this harness's own self-tests, which must never mutate themselves) — a
 * deliberately broad default that the curated entries narrow for the engine
 * root, where one directory holds hundreds of files.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LineRange } from "./operators.ts";

export interface MutationTargetConfig {
  readonly path: string;
  readonly tests: readonly string[];
  readonly lineRanges?: readonly LineRange[];
  readonly needsDb?: boolean;
  /** Why the selected runtime behavior requires the database partition. */
  readonly needsDbReason?: string;
}

export interface MutationConfig {
  readonly version: number;
  readonly targets: readonly MutationTargetConfig[];
}

const CONFIG_URL = new URL("./mutation.config.json", import.meta.url);
const CONFIG_PATH = fileURLToPath(CONFIG_URL);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLineRange(value: unknown): value is LineRange {
  if (!isRecord(value)) return false;
  return (
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    value.start >= 1 &&
    value.end >= value.start
  );
}

/** Parse and shape-check the config file; throws on any malformation. */
export function parseMutationConfig(raw: string): MutationConfig {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.targets)) {
    throw new Error("mutation config must be { version: 1, targets: [...] }");
  }
  const seen = new Set<string>();
  const targets: MutationTargetConfig[] = [];
  for (const entry of parsed.targets) {
    if (!isRecord(entry) || typeof entry.path !== "string" || !Array.isArray(entry.tests)) {
      throw new Error("each mutation target must be { path: string, tests: string[], ... }");
    }
    if (seen.has(entry.path)) throw new Error(`duplicate mutation target: ${entry.path}`);
    seen.add(entry.path);
    if (entry.tests.length === 0 || !entry.tests.every((t) => typeof t === "string")) {
      throw new Error(`mutation target ${entry.path} needs a non-empty tests array`);
    }
    let lineRanges: readonly LineRange[] | undefined;
    if (entry.lineRanges !== undefined) {
      if (!Array.isArray(entry.lineRanges) || !entry.lineRanges.every(isLineRange)) {
        throw new Error(`mutation target ${entry.path} has malformed lineRanges`);
      }
      lineRanges = entry.lineRanges;
    }
    if (entry.needsDb === true && (typeof entry.needsDbReason !== "string" || !entry.needsDbReason.trim())) {
      throw new Error(`mutation target ${entry.path} needs a non-empty needsDbReason grounded in its selected code`);
    }
    targets.push({
      path: entry.path,
      tests: [...entry.tests].sort(),
      ...(lineRanges ? { lineRanges } : {}),
      ...(entry.needsDb === true ? { needsDb: true as const, needsDbReason: entry.needsDbReason as string } : {}),
    });
  }
  return { version: 1, targets };
}

export function loadMutationConfig(configPath: string = CONFIG_PATH): MutationConfig {
  return parseMutationConfig(readFileSync(configPath, "utf8"));
}

/**
 * Resolve the test files for a target: the curated entry when present,
 * otherwise every test file beside it. `repoRoot` is the repository checkout
 * the harness runs against (the scratch copy at runtime).
 */
export function resolveTargetTests(
  config: MutationConfig,
  targetPath: string,
  repoRoot: string,
): string[] {
  const entry = config.targets.find((t) => t.path === targetPath);
  if (entry) return [...entry.tests];
  const dir = join(repoRoot, dirname(targetPath));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.test\.[cm]?[jt]sx?$/.test(name))
    .filter((name) => !name.startsWith("mutation-") && !name.startsWith("operators.") && !name.startsWith("harness-selfcheck."))
    .map((name) => join(dirname(targetPath), name).replace(/\\/g, "/"))
    .sort();
}


