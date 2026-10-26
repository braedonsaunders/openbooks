import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  canonicalSubsidiaryIds,
  flowGraphAdmitsSubjectSql,
  validateFlowSubjectScopeRefs,
} from "./subject-admission.ts";

/**
 * The policy-existence SQL must be the same admission as the runtime
 * dispatcher (flows/subject-admission.ts): unscoped flows count for every
 * subject, a scoped flow counts only for a listed entity, a resolved entity
 * outside the list does not count, and an unknown entity still counts the
 * scoped flow so its subject fails closed. These assertions pin the shape
 * of that SQL (compiled, never executed against a database here) so a
 * future edit cannot drift the two semantics apart silently.
 */

const dialect = new PgDialect();

function compiled(fragment: ReturnType<typeof flowGraphAdmitsSubjectSql>): string {
  return dialect.sqlToQuery(fragment).sql;
}

test("policy SQL admits an unscoped graph for every subject", () => {
  const text = compiled(flowGraphAdmitsSubjectSql(sql`f.graph`, sql`d.subsidiary_id`));
  assert.match(text, /f\.graph -> 'subjectScope' is null/);
});

test("policy SQL counts a scoped flow for an unknown entity (fail closed)", () => {
  const text = compiled(flowGraphAdmitsSubjectSql(sql`f.graph`, sql`d.subsidiary_id`));
  assert.match(text, /d\.subsidiary_id is null/);
});

test("policy SQL matches listed entities case-insensitively, as uuid text", () => {
  const text = compiled(flowGraphAdmitsSubjectSql(sql`f.graph`, sql`d.subsidiary_id`));
  assert.match(
    text,
    /jsonb_array_elements_text\(coalesce\(f\.graph -> 'subjectScope' -> 'subsidiaryIds', '\[\]'::jsonb\)\)/,
  );
  assert.match(text, /lower\(scope_id\) = d\.subsidiary_id::text/);
});

const ENTITY_A = "11111111-1111-4111-8111-111111111111";
const ENTITY_B = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";

test("managed-write validation refuses malformed scope entries instead of filtering them", async () => {
  // Every case refuses BEFORE any organization lookup, so none of these
  // may silently persist a narrower or wider limit than submitted.
  const overlength = Array.from(
    { length: 101 },
    (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
  );
  const malformed: unknown[] = [
    { subsidiaryIds: [] },
    { subsidiaryIds: "not-an-array" },
    { subsidiaryIds: ["not-a-uuid"] },
    { subsidiaryIds: [ENTITY_A, "not-a-uuid"] },
    { subsidiaryIds: ["not-a-uuid", ENTITY_B] },
    { subsidiaryIds: [ENTITY_A, 42] },
    { subsidiaryIds: [ENTITY_A, null] },
    { subsidiaryIds: [` ${ENTITY_A} `] },
    { subsidiaryIds: [ENTITY_A, ENTITY_A] },
    { subsidiaryIds: [ENTITY_A, ENTITY_A.toUpperCase()] },
    { subsidiaryIds: overlength },
  ];
  for (const subjectScope of malformed) {
    const refusal = await validateFlowSubjectScopeRefs(
      ORG_ID,
      { subjectScope } as { subjectScope: { subsidiaryIds: string[] } },
      null,
    );
    assert.match(refusal ?? "", /malformed/, JSON.stringify(subjectScope).slice(0, 80));
  }
});

test("managed-write validation still refuses an absent actor ceiling and out-of-ceiling entities", async () => {
  const graph = { subjectScope: { subsidiaryIds: [ENTITY_A, ENTITY_B] } };
  assert.match(
    (await validateFlowSubjectScopeRefs(ORG_ID, graph, undefined)) ?? "",
    /cannot be checked against your access/,
  );
  assert.match(
    (await validateFlowSubjectScopeRefs(ORG_ID, graph, new Set([ENTITY_A]))) ?? "",
    /outside your subsidiary access/,
  );
});

test("actor ceilings compare in canonical uuid case", () => {
  const ceiling = canonicalSubsidiaryIds([ENTITY_A.toUpperCase(), ` ${ENTITY_B} `]);
  assert.deepEqual([...ceiling].sort(), [ENTITY_A, ENTITY_B]);
  assert.ok(ceiling.has(ENTITY_A));
  // Non-string ceiling debris contributes nothing rather than widening it.
  assert.deepEqual([...canonicalSubsidiaryIds([42, null, ENTITY_A])], [ENTITY_A]);
});

test("policy SQL is a single parenthesized predicate safe to AND into a WHERE clause", () => {
  const text = compiled(flowGraphAdmitsSubjectSql(sql`f.graph`, sql`d.subsidiary_id`)).trim();
  assert.ok(text.startsWith("(") && text.endsWith(")"), text);
});
