// Book-scope resolution: single-active-primary default, explicit book plans
// govern, book-independent entities stay unclamped. Runs in the integration
// partition with a migrated database:
//   node --import tsx --import ./engine/src/testing/database-bypass.ts \
//     --test web/lib/insight-books.integration.test.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { InsightQuery } from "@openbooks/analytics";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export function redirect(){throw new Error(\"redirect\")};export function useRouter(){throw new Error(\"no router\")}",
      };
    }
    if (specifier === "next/headers") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function headers(){throw new Error(\"no headers\")};export async function cookies(){throw new Error(\"no cookies\")}",
      };
    }
    if (specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function getTranslations(){return (key)=>key};export async function getLocale(){return 'en'}",
      };
    }
    return next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, env, withBypass } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { resolveInsightBookScope } = await import("./insight-books.ts");

const unscopedLedgerPlan: InsightQuery = {
  source: "ledger_lines",
  measures: [{ agg: "sum", field: "amount" }],
  dimensions: [{ field: "posting_date", bin: "month" }],
};

test("insight book scope defaults to the single active primary and never falls back", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg());
  try {
    // Omitted book selection defaults to the primary book.
    assert.deepEqual(
      await withBypass(() => resolveInsightBookScope(scratch.orgId, unscopedLedgerPlan)),
      [scratch.bookId],
    );

    // Zero or several active primaries throw: the basis is ambiguous and no
    // first-row fallback may silently pick one.
    const extraPrimary = randomUUID();
    await withBypass(() => db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${extraPrimary}, ${scratch.orgId}, 'ALT', 'Alternate', true, true, true)`));
    await assert.rejects(
      withBypass(() => resolveInsightBookScope(scratch.orgId, unscopedLedgerPlan)),
      /exactly one active primary/,
    );
    await withBypass(() => db.execute(sql`delete from accounting_books where id = ${extraPrimary}`));
    await withBypass(() => db.execute(sql`
      update accounting_books set is_primary = false where org_id = ${scratch.orgId}`));
    await assert.rejects(
      withBypass(() => resolveInsightBookScope(scratch.orgId, unscopedLedgerPlan)),
      /exactly one active primary/,
    );
    await withBypass(() => db.execute(sql`
      update accounting_books set is_primary = true where id = ${scratch.bookId}`));
    assert.deepEqual(
      await withBypass(() => resolveInsightBookScope(scratch.orgId, unscopedLedgerPlan)),
      [scratch.bookId],
    );

    // Explicit book scoping governs instead of the default.
    assert.equal(
      await withBypass(() => resolveInsightBookScope(scratch.orgId, {
        ...unscopedLedgerPlan,
        filters: [{ field: "book_id", op: "eq", value: scratch.bookId }],
      })),
      null,
    );
    assert.equal(
      await withBypass(() => resolveInsightBookScope(scratch.orgId, {
        ...unscopedLedgerPlan,
        dimensions: [{ field: "book" }],
      })),
      null,
    );

    // Book-independent entities are never clamped.
    assert.equal(
      await withBypass(() => resolveInsightBookScope(scratch.orgId, {
        source: "documents",
        measures: [{ agg: "sum", field: "total" }],
      })),
      undefined,
    );
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId));
  }
});
