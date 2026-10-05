import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import test from "node:test";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    return next(specifier, context);
  },
});

const { entityListSource } = await import("./entity-sources.ts");
const { defaultListView } = await import("@openbooks/customization");

/**
 * The unmatched payout queue reads the payout's legal entity. An unknown
 * caller scope must deny every row — never read as unrestricted.
 */
function whereText(scope: Set<string> | null | undefined): string {
  const source = entityListSource("psp_settlement_line_unmatched");
  assert.ok(source, "the unmatched queue source is registered");
  const compiled = source.where(
    defaultListView("psp_settlement_line_unmatched"),
    {},
    "org-1",
    scope,
  );
  const parts: string[] = [];
  const walk = (chunk: unknown): void => {
    if (typeof chunk === "string") {
      parts.push(chunk);
      return;
    }
    if (Array.isArray(chunk)) {
      for (const entry of chunk) walk(entry);
      return;
    }
    if (chunk && typeof chunk === "object") {
      const record = chunk as Record<string, unknown>;
      if (Array.isArray(record.value)) {
        for (const entry of record.value) walk(entry);
        return;
      }
      if (typeof record.value === "string") {
        parts.push(record.value);
        return;
      }
      if (Array.isArray(record.queryChunks)) {
        for (const entry of record.queryChunks) walk(entry);
      }
    }
  };
  walk((compiled as { queryChunks: unknown }).queryChunks);
  return parts.join(" ");
}

test("an unknown or empty scope denies every unmatched line", () => {
  assert.match(whereText(undefined), /and false/, "undefined scope fails closed");
  assert.match(whereText(new Set()), /and false/, "empty scope reads nothing");
});

test("a restricted scope names only its own entities", () => {
  const home = randomUUID();
  const other = randomUUID();
  const text = whereText(new Set([home]));
  assert.ok(text.includes(home), "the caller's entity stays in the predicate");
  assert.ok(!text.includes(other), "no other entity enters the predicate");
  assert.ok(!/and false/.test(text), "a non-empty scope still reads its rows");
});

test("an explicitly unrestricted caller keeps the established queue", () => {
  assert.ok(!/and false/.test(whereText(null)), "explicit null stays unrestricted");
});
