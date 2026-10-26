import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";

export interface AnalyticsDashboardConfigRow {
  cfg: unknown;
  rev: number;
  currency: string | null;
}

export async function loadAnalyticsDashboardConfig(
  orgId: string,
  dashboard: string,
  revisionKey: string,
  currencyKey: string,
): Promise<AnalyticsDashboardConfigRow | undefined> {
  return withOrgTransaction(
    orgId,
    async () => {
      const rows = await db.execute<AnalyticsDashboardConfigRow>(
        sql`
          select settings -> 'analytics' -> ${dashboard} as cfg,
                 coalesce((settings -> 'analytics' ->> ${revisionKey})::int, 0) as rev,
                 settings -> 'analytics' ->> ${currencyKey} as currency
            from orgs where id = ${orgId}
        `,
        "objects",
      );
      return rows[0];
    },
    { readOnly: true },
  );
}

export type SaveAnalyticsDashboardConfigResult =
  | { kind: "missing" }
  | { kind: "conflict"; row: AnalyticsDashboardConfigRow }
  | { kind: "unwritten" }
  | { kind: "ok"; revision: number };

export async function saveAnalyticsDashboardConfig(input: {
  orgId: string;
  actorId: string;
  dashboard: string;
  revisionKey: string;
  currencyKey: string;
  expectedRevision: number;
  cleaned: unknown;
  currency: string;
}): Promise<SaveAnalyticsDashboardConfigResult> {
  return withOrgTransaction(input.orgId, async () => {
    const existing = await db.execute<AnalyticsDashboardConfigRow>(
      sql`
      select settings -> 'analytics' -> ${input.dashboard} as cfg,
             coalesce((settings -> 'analytics' ->> ${input.revisionKey})::int, 0) as rev,
             settings -> 'analytics' ->> ${input.currencyKey} as currency
        from orgs where id = ${input.orgId} for update
    `,
      "objects",
    );
    if (!existing[0]) return { kind: "missing" as const };

    const currentRevision = Number(existing[0].rev);
    if (currentRevision !== input.expectedRevision) {
      return { kind: "conflict" as const, row: existing[0] };
    }

    const beforeCurrency = existing[0].currency;
    const rawBefore = existing[0].cfg;
    const before = rawBefore && typeof rawBefore === "object" ? rawBefore : {};
    const nextRevision = currentRevision + 1;
    const updated = await db.execute<never>(sql`
      update orgs
      set settings = jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(coalesce(settings, '{}'::jsonb), '{analytics}', coalesce(settings -> 'analytics', '{}'::jsonb), true),
            array['analytics', ${input.dashboard}], ${JSON.stringify(input.cleaned)}::jsonb, true),
          array['analytics', ${input.revisionKey}], ${JSON.stringify(nextRevision)}::jsonb, true),
        -- The currency stamp makes every money threshold an amount IN a currency.
        array['analytics', ${input.currencyKey}], to_jsonb(${input.currency}::text), true)
      where id = ${input.orgId}
    `);
    if ((updated.rowCount ?? 0) !== 1) return { kind: "unwritten" as const };

    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${input.orgId}, 'orgs', ${input.orgId}, 'update',
        ${JSON.stringify({
          before: {
            analytics: {
              [input.dashboard]: before,
              [input.revisionKey]: currentRevision,
              [input.currencyKey]: beforeCurrency,
            },
          },
          after: {
            analytics: {
              [input.dashboard]: input.cleaned,
              [input.revisionKey]: nextRevision,
              [input.currencyKey]: input.currency,
            },
          },
        })}::jsonb,
        ${input.actorId}
      )
    `);
    return { kind: "ok" as const, revision: nextRevision };
  });
}
