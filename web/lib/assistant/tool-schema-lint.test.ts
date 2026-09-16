import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// The tool catalogs are server-only, but this wiring test runs with Node's
// plain test runner. Keep the module graph identical to the other assistant
// tests by shimming only the marker package (same precedent as
// web/lib/application/tool-catalog.test.ts) plus the `@/` alias the
// transitively imported app modules use (same precedent as
// tools-banking-scope.integration.test.ts).
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (specifier.startsWith("@/")) {
      const path = root + "web/" + specifier.slice(2);
      for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
      }
      return nextResolve(path, context);
    }
    return nextResolve(specifier, context);
  },
});

const { ASSISTANT_TOOLS } = await import("./registry.ts");
const { APPLICATION_TOOLS } = await import("../application/tool-catalog.ts");
const sharedAtoms = await import("./tools-shared.ts");

/**
 * Strict-provider JSON-Schema lint over every tool the chat and MCP surfaces
 * expose. Both adapters hand the zod `inputSchema` to their SDK (AI SDK
 * `tool()` / MCP `registerToolCatalog`), which renders provider-facing JSON
 * Schema with zod v4's `z.toJSONSchema` — so this test lints exactly that
 * conversion. Failure class it guards: one provider rejected the WHOLE tool
 * catalog over a single unescaped `[` in a character class; `format: uuid`
 * is likewise rejected by strict providers while the equivalent `pattern`
 * is accepted.
 */

type CatalogEntry = { name: string; schema: unknown };

const CATALOG: CatalogEntry[] = [
  ...ASSISTANT_TOOLS.map((t) => ({ name: t.name, schema: t.inputSchema as unknown })),
  ...APPLICATION_TOOLS.map((t) => ({ name: t.name, schema: t.inputSchema as unknown })),
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toJsonSchema(schema: unknown): Record<string, unknown> {
  return z.toJSONSchema(schema as never) as unknown as Record<string, unknown>;
}

/** Unwrap optional/nullable/description-outside wrappers to the described core. */
function unwrap(node: unknown): unknown {
  let current = node;
  for (;;) {
    const record = asRecord(current);
    if (!record) return current;
    if (typeof record.description === "string") return current;
    for (const key of ["anyOf", "oneOf"] as const) {
      const branches = record[key];
      if (!Array.isArray(branches)) continue;
      const concrete = branches.filter((b) => asRecord(b)?.type !== "null");
      if (concrete.length === 1) {
        current = concrete[0];
        break;
      }
      return current;
    }
    return current;
  }
}

function described(node: unknown): boolean {
  return typeof asRecord(unwrap(node))?.description === "string";
}

/**
 * RE2 complaint for one emitted `pattern`, or null when strict providers
 * accept it. JSON Schema patterns carry no flags and strict providers
 * compile them with RE2 semantics: no lookarounds, no backreferences, and —
 * the outage that motivated this test — no unescaped `[` inside a character
 * class (valid in JavaScript, rejected by RE2).
 */
export function re2Complaint(pattern: string): string | null {
  let inClass = false;
  let classFirst = false;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) return "trailing backslash";
      if (next >= "1" && next <= "9") return `backreference \\${next} is not RE2-safe`;
      i += 2;
      classFirst = false;
      continue;
    }
    if (!inClass) {
      if (c === "[") {
        inClass = true;
        classFirst = true;
        i += 1;
        continue;
      }
      if (c === "(" && pattern[i + 1] === "?") {
        const third = pattern[i + 2];
        if (third === "=" || third === "!") return "lookahead is not RE2-safe";
        if (third === "<") return "lookbehind is not RE2-safe";
      }
      i += 1;
      continue;
    }
    // Inside a character class.
    if (classFirst && c === "^") {
      classFirst = false;
      i += 1;
      continue;
    }
    if (classFirst && c === "]") {
      // A `]` in first position is a literal in JavaScript; RE2 rejects the
      // empty-class reading, so flag it rather than mis-parse the class end.
      return "leading literal `]` in a character class is not RE2-safe";
    }
    classFirst = false;
    if (c === "[") return "unescaped `[` inside a character class is not RE2-safe";
    if (c === "]") inClass = false;
    i += 1;
  }
  if (inClass) return "unterminated character class";
  return null;
}

type Violation = { tool: string; path: string; message: string };

/**
 * Walk one converted schema. Structural map keys (`properties` names) are
 * names, not constraints; everything else named below is a constraint a
 * strict provider compiles. `inOpenMap` marks keyed string maps
 * (`additionalProperties` / `propertyNames` from `z.record`), which are
 * open-world by construction: the page-layout route-param maps they serve
 * accept arbitrary segment values, and the declaring tools are open-world —
 * a maxLength there would invent a product limit that does not exist.
 */
function walk(node: unknown, tool: string, path: string, inOpenMap: boolean, out: Violation[]): void {
  const record = asRecord(node);
  if (!record) return;
  const type = record.type;
  if (record.format !== undefined) {
    out.push({ tool, path, message: `format ${JSON.stringify(record.format)} is rejected by strict providers; use pattern` });
  }
  if (typeof record.pattern === "string") {
    const complaint = re2Complaint(record.pattern);
    if (complaint) out.push({ tool, path, message: `${complaint}: ${record.pattern}` });
  }
  if (Array.isArray(record.enum) && record.enum.length > 64) {
    out.push({ tool, path, message: `enum has ${record.enum.length} values (max 64)` });
  }
  if (type === "string" && !inOpenMap) {
    const bounded =
      typeof record.maxLength === "number" ||
      typeof record.pattern === "string" ||
      Array.isArray(record.enum) ||
      record.const !== undefined;
    if (!bounded) out.push({ tool, path, message: "unbounded string: add maxLength, pattern, or enum" });
  }
  if (type === "array" && typeof record.maxItems !== "number") {
    out.push({ tool, path, message: "unbounded array: add .max()" });
  }
  const properties = asRecord(record.properties);
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      walk(value, tool, `${path}.${key}`, false, out);
    }
  }
  for (const key of ["additionalProperties", "propertyNames", "items"] as const) {
    const value = record[key];
    if (value === undefined || typeof value === "boolean") continue;
    if (Array.isArray(value)) {
      value.forEach((v, index) => walk(v, tool, `${path}[${key}:${index}]`, true, out));
    } else {
      walk(value, tool, `${path}.${key}`, true, out);
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    value.forEach((v, index) => walk(v, tool, `${path}[${key}:${index}]`, inOpenMap, out));
  }
}

function lintCatalog(): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const entry of CATALOG) {
    if (seen.has(entry.name)) {
      violations.push({ tool: entry.name, path: "$", message: "duplicate tool name across the assistant/application catalogs" });
      continue;
    }
    seen.add(entry.name);
    let schema: Record<string, unknown>;
    try {
      schema = toJsonSchema(entry.schema);
    } catch (error) {
      violations.push({ tool: entry.name, path: "$", message: `zod→JSON Schema conversion throws: ${String(error).slice(0, 200)}` });
      continue;
    }
    if (schema.type !== "object" || !asRecord(schema.properties)) {
      violations.push({ tool: entry.name, path: "$", message: "tool root must be an object schema with properties" });
      continue;
    }
    for (const [key, value] of Object.entries(schema.properties as Record<string, unknown>)) {
      if (!described(value)) {
        violations.push({ tool: entry.name, path: `$.${key}`, message: "top-level property has no description" });
      }
    }
    walk(schema, entry.name, "$", false, violations);
  }
  return violations;
}

test("every tool converts to strict-provider JSON Schema without violations", () => {
  assert.ok(CATALOG.length >= 100, `catalog extraction looks broken (${CATALOG.length} tools)`);
  const violations = lintCatalog();
  assert.equal(
    violations.length,
    0,
    `${violations.length} schema violations; first: ${
      violations[0] ? `${violations[0].tool} ${violations[0].path}: ${violations[0].message}` : "none"
    }`,
  );
});

test("shared schema atoms emit exactly the provider-safe patterns (no flag-dependent regex)", () => {
  // JSON Schema patterns carry no flags: a case-insensitive zod regex would
  // silently narrow provider-side (lowercase-only) while zod accepts more.
  // Pin the emitted patterns so a flag-dependent edit fails loudly here.
  const uuid = toJsonSchema(z.object({ id: sharedAtoms.uuidInput }));
  assert.equal(
    (asRecord(uuid.properties)?.id as Record<string, unknown>).pattern,
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  );
  const date = toJsonSchema(z.object({ on: sharedAtoms.dateInput }));
  assert.equal((asRecord(date.properties)?.on as Record<string, unknown>).pattern, "^\\d{4}-\\d{2}-\\d{2}$");
  const sharedSource = readFileSync(new URL("./tools-shared.ts", import.meta.url), "utf8");
  assert.doesNotMatch(sharedSource, /\$\/i/, "flag-dependent end-anchored pattern in the shared atoms");
});

test("the RE2 pattern guard catches the historical failure classes", () => {
  assert.equal(re2Complaint("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}$"), null);
  assert.equal(re2Complaint("^\\/[A-Za-z0-9._\\-/\\[\\]()]*$"), null);
  assert.ok(re2Complaint("^[a-z[]+$")?.includes("unescaped `[`"));
  assert.ok(re2Complaint("^(?=a)b")?.includes("lookahead"));
  assert.ok(re2Complaint("^(?!a)b")?.includes("lookahead"));
  assert.ok(re2Complaint("^(?<=a)b")?.includes("lookbehind"));
  assert.ok(re2Complaint("^(a)\\1$")?.includes("backreference"));
});
