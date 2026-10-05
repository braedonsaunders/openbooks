import assert from "node:assert/strict";
import test from "node:test";

// One rule for the external (source, ref) pair, shared by the document and
// order writers: absent leaves, null clears, a valued half requires its
// partner, and a valued half is never silently dropped.
const {
  isExternalRefCheckViolation,
  isExternalRefConflict,
  resolveExternalRefPair,
} = await import("./external-ref.ts");

test("absent pair leaves the stored value", () => {
  assert.deepEqual(resolveExternalRefPair({}), { action: "leave" });
  assert.deepEqual(
    resolveExternalRefPair({ externalRef: undefined, externalSource: undefined }),
    { action: "leave" },
  );
});

test("two values set the trimmed pair", () => {
  assert.deepEqual(
    resolveExternalRefPair({ externalRef: "  EXT-1 ", externalSource: " shopify " }),
    { action: "set", ref: "EXT-1", source: "shopify" },
  );
});

test("an explicit null with no valued half clears both", () => {
  assert.deepEqual(resolveExternalRefPair({ externalRef: null }), { action: "clear" });
  assert.deepEqual(resolveExternalRefPair({ externalSource: null }), { action: "clear" });
  assert.deepEqual(
    resolveExternalRefPair({ externalRef: null, externalSource: null }),
    { action: "clear" },
  );
});

test("a valued half without its partner is refused, never coerced", () => {
  for (const input of [
    { externalRef: "EXT-1" },
    { externalRef: "EXT-1", externalSource: undefined },
    { externalRef: "EXT-1", externalSource: null },
    { externalSource: "shopify" },
    { externalRef: null, externalSource: "shopify" },
  ]) {
    const result = resolveExternalRefPair(input);
    assert.equal(result.action, "refuse", JSON.stringify(input));
    assert.match(
      (result as { message: string }).message,
      /travel together/,
      JSON.stringify(input),
    );
  }
});

test("blank and non-string halves are refused with the remedy", () => {
  const blank = resolveExternalRefPair({ externalRef: "   ", externalSource: "shopify" });
  assert.equal(blank.action, "refuse");
  assert.match((blank as { message: string }).message, /must not be blank/);
  const numeric = resolveExternalRefPair({ externalRef: 12345, externalSource: "shopify" });
  assert.equal(numeric.action, "refuse");
  assert.match((numeric as { message: string }).message, /must be a string/);
});

test("storage conflict detection names only the dedupe index", () => {
  const conflict = { code: "23505", constraint: "documents_org_external_ref" };
  assert.equal(isExternalRefConflict(conflict), true);
  assert.equal(isExternalRefConflict({ cause: conflict }), true);
  assert.equal(isExternalRefConflict({ code: "23505", constraint: "documents_org_kind_number" }), false);
  assert.equal(isExternalRefConflict(new Error("boom")), false);
  assert.equal(
    isExternalRefCheckViolation({ code: "23514", constraint: "documents_external_ref_source_pair" }),
    true,
  );
  assert.equal(
    isExternalRefCheckViolation({ code: "23514", constraint: "documents_external_ref_nonblank" }),
    true,
  );
  assert.equal(isExternalRefCheckViolation(conflict), false);
});
