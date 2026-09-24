import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * The org id must cross into SQL as a bound value, never as statement text:
 * the import CLI takes --org from the operator's shell, and the old
 * sourceIdMap built `org_id = '<value>'` with sql.raw, so a quote broke out
 * and ran arbitrary SQL as the script role. The stubbed executor below
 * captures the drizzle query with text chunks kept apart from bound values,
 * proving a hostile id never enters the statement.
 */
const captured: unknown[] = [];
(globalThis as Record<string, unknown>).__sourceIdMapCapture = captured;

function splitQuery(query: unknown): { text: string; values: unknown[] } {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  const textParts: string[] = [];
  const values: unknown[] = [];
  const visit = (chunk: unknown): void => {
    if (typeof chunk === "string") {
      textParts.push(chunk);
      return;
    }
    if (chunk && typeof chunk === "object") {
      const record = chunk as { value?: unknown; queryChunks?: unknown[] };
      if ("value" in record) {
        if (Array.isArray(record.value)) values.push(...record.value);
        else values.push(record.value);
        return;
      }
      if (Array.isArray(record.queryChunks)) {
        for (const inner of record.queryChunks) visit(inner);
        return;
      }
    }
  };
  if (Array.isArray(chunks)) for (const chunk of chunks) visit(chunk);
  return { text: textParts.join(""), values };
}

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === "../platform/db.ts" &&
      context.parentURL?.endsWith("/field-ticket-import.ts")
    ) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`
          export const db = {
            execute: async (query) => {
              globalThis.__sourceIdMapCapture.push(query);
              return { rows: [] };
            },
          };
          export const withOrg = async (_orgId, fn) => fn();
        `)}`,
      };
    }
    return next(specifier, context);
  },
});
const { sourceIdMap } = await import("./field-ticket-import.ts");
hooks.deregister();

test("source mappings bind the org id instead of interpolating it", async () => {
  const hostile = "x' OR '1'='1";
  captured.length = 0;
  await sourceIdMap("projects", hostile);
  assert.equal(captured.length, 1);
  const { text, values } = splitQuery(captured[0]);
  assert.ok(
    !text.includes(hostile),
    `hostile org id must not enter the statement text, got: ${text}`,
  );
  assert.ok(
    values.some((value) => value === hostile),
    "the org id must still scope the query as a bound value",
  );
});

test("source mappings read both registries through the same bound scope", async () => {
  captured.length = 0;
  await sourceIdMap("parties", "123e4567-e89b-12d3-a456-426614174000");
  assert.equal(captured.length, 1);
  const { text, values } = splitQuery(captured[0]);
  assert.match(text, /custom->>'nsId'/);
  assert.ok(values.includes("123e4567-e89b-12d3-a456-426614174000"));
});
