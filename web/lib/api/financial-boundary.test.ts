import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Reviewed non-JSON mutation routes. Every entry needs a narrow reason because
 * this is the only escape hatch from the shared zod request boundary.
 */
const EXEMPT_ROUTES: Readonly<Record<string, string>> = {};

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_DIR, "../..");
const API_ROOT = join(WEB_ROOT, "app/api");
const MUTATION_EXPORT_RE = /^export\s+(?:async\s+)?(?:function|const)\s+(POST|PATCH|PUT)\b/gm;
const DIRECT_JSON_READ_RE = /\b(?:req|request)\s*\.\s*json\s*\(/;

interface MutationRoute {
  file: string;
  methods: string[];
  source: string;
}

function routeFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? routeFiles(path) : path.endsWith(`${sep}route.ts`) ? [path] : [];
    })
    .sort();
}

function mutationRoute(file: string): MutationRoute | null {
  const source = readFileSync(file, "utf8");
  const methods = [...source.matchAll(MUTATION_EXPORT_RE)].map((match) => match[1]!);
  if (methods.length === 0) return null;
  return {
    file: relative(resolve(WEB_ROOT, ".."), file).split(sep).join("/"),
    methods: [...new Set(methods)].sort(),
    source,
  };
}

test("every JSON mutation route parses its body through the shared zod boundary", () => {
  const routes = routeFiles(API_ROOT)
    .map(mutationRoute)
    .filter((route): route is MutationRoute => route !== null);
  const discovered = new Set(routes.map((route) => route.file));
  const failures: string[] = [];

  for (const [file, reason] of Object.entries(EXEMPT_ROUTES)) {
    if (!reason.trim()) failures.push(`${file}: exemption is missing its reviewed reason`);
    if (!discovered.has(file)) failures.push(`${file}: stale exemption (no mutation route discovered)`);
  }

  for (const route of routes) {
    if (route.file in EXEMPT_ROUTES) continue;
    const violations: string[] = [];
    if (!route.source.includes("parseJsonBody(")) violations.push("does not use parseJsonBody");
    if (DIRECT_JSON_READ_RE.test(route.source)) violations.push("reads req/request.json() directly");
    if (violations.length > 0) {
      failures.push(`${route.file} [${route.methods.join(", ")}]: ${violations.join("; ")}`);
    }
  }

  assert.equal(
    failures.length,
    0,
    failures.length === 0
      ? undefined
      : `${failures.length} mutation route boundary violation(s):\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
  );
});
