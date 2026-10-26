import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";

export interface CashflowCategoriesSnapshot {
  categories: unknown[];
  revision: number;
}

export async function loadCashflowCategories(orgId: string): Promise<CashflowCategoriesSnapshot> {
  return withOrgTransaction(
    orgId,
    async () => {
      const rows = await db.execute<{ cats: unknown; rev: number }>(
        sql`
        select settings -> 'analytics' -> 'cashflowCategories' as cats,
               coalesce((settings -> 'analytics' ->> 'cashflowCategoriesRevision')::int, 0) as rev
          from orgs where id = ${orgId}
      `,
        "objects",
      );
      const row = rows[0];
      return {
        categories: Array.isArray(row?.cats) ? row.cats : [],
        revision: typeof row?.rev === "number" ? row.rev : 0,
      };
    },
    { readOnly: true },
  );
}

export type SaveCashflowCategoriesResult =
  | { kind: "missing" }
  | { kind: "conflict"; revision: number }
  | { kind: "unwritten" }
  | { kind: "saved"; revision: number };

export async function saveCashflowCategories(input: {
  orgId: string;
  actorId: string;
  expectedRevision: number;
  categories: unknown[];
}): Promise<SaveCashflowCategoriesResult> {
  return withOrgTransaction(input.orgId, async () => {
    const existing = await db.execute<{ cats: unknown; rev: number }>(
      sql`
      select settings -> 'analytics' -> 'cashflowCategories' as cats,
             coalesce((settings -> 'analytics' ->> 'cashflowCategoriesRevision')::int, 0) as rev
        from orgs where id = ${input.orgId} for update
    `,
      "objects",
    );
    const row = existing[0];
    if (!row) return { kind: "missing" as const };

    const currentRevision = typeof row.rev === "number" ? row.rev : 0;
    if (currentRevision !== input.expectedRevision) {
      return { kind: "conflict" as const, revision: currentRevision };
    }

    const before = Array.isArray(row.cats) ? row.cats : [];
    const nextRevision = currentRevision + 1;
    const updated = await db.execute<never>(sql`
      update orgs
      set settings = jsonb_set(
        jsonb_set(
          jsonb_set(coalesce(settings, '{}'::jsonb), '{analytics}', coalesce(settings -> 'analytics', '{}'::jsonb), true),
          '{analytics,cashflowCategories}', ${JSON.stringify(input.categories)}::jsonb, true),
        '{analytics,cashflowCategoriesRevision}', ${JSON.stringify(nextRevision)}::jsonb, true)
      where id = ${input.orgId}
    `);
    if ((updated.rowCount ?? 0) !== 1) return { kind: "unwritten" as const };

    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${input.orgId}, 'orgs', ${input.orgId}, 'update',
        ${JSON.stringify({
          before: { analytics: { cashflowCategories: before } },
          after: { analytics: { cashflowCategories: input.categories } },
        })}::jsonb,
        ${input.actorId}
      )
    `);
    return { kind: "saved" as const, revision: nextRevision };
  });
}
