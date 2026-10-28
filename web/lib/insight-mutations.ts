import "server-only";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import type { Authz } from "./authz";
import { insightVisibilitySql } from "./insight-access";
import { auditSetupChange } from "./setup/audit";
import { notFound } from "@/lib/api/responses";
import { InsightValidationError, validateInsightQuery } from "@openbooks/analytics";
import { UNTITLED_CARD_NAME, UNTITLED_DASHBOARD_NAME } from "./insight-untitled";

type InsightTable = "insight_cards" | "insight_dashboards";
type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0];
class RejectedMutation extends Error {
  constructor(readonly response: NextResponse) {
    super("Insight mutation rejected");
  }
}

/** Lock, authorize, mutate and capture both row images in the same transaction.
 * An error response or failed audit must never commit a partial mutation. */
export async function mutateInsight(
  authz: Authz,
  table: InsightTable,
  id: string,
  action: "insert" | "update" | "delete",
  work: (
    tx: Executor,
    before: Record<string, unknown> | null,
    revision: string | null,
  ) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await db.transaction(async (tx) => {
      // Layouts reference cards through JSON, so a row FK cannot serialize a
      // new placement against deletion. All Insight writers take this tenant
      // lock before row locks; unrelated organizations remain independent.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${authz.user.orgId + ":insights"}, 0))`,
      );
      let before: Record<string, unknown> | null = null;
      let revision: string | null = null;
      if (action !== "insert") {
        const row = await tx.execute<{
          snapshot: Record<string, unknown>;
          revision: string;
        }>(
          sql`
          select to_jsonb(i) as snapshot,
            to_char(i.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision from ${sql.identifier(table)} i
          where i.id = ${id} and ${insightVisibilitySql(authz, "i")} for update of i
        `,
          "objects",
        );
        before = row[0]?.snapshot ?? null;
        revision = row[0]?.revision ?? null;
        if (!before) return notFound("record");
      }
      const response = await work(tx, before, revision);
      if (response.status >= 400) throw new RejectedMutation(response);
      const row = await tx.execute<{ snapshot: Record<string, unknown> }>(
        sql`
        select to_jsonb(i) as snapshot from ${sql.identifier(table)} i
        where i.id = ${id} and i.org_id = ${authz.user.orgId}
      `,
        "objects",
      );
      const after = row[0]?.snapshot ?? null;
      if (action === "delete" ? after !== null : after === null)
        throw new Error("Insight mutation did not produce the expected row state");
      await auditSetupChange(
        {
          orgId: authz.user.orgId,
          table,
          rowId: id,
          action,
          changes: {
            ...(before ? { before } : {}),
            ...(after ? { after } : {}),
          },
          actorId: authz.user.id,
        },
        tx,
      );
      return response;
    });
  } catch (error) {
    if (error instanceof RejectedMutation) return error.response;
    throw error;
  }
}

/** Publish or return a card/dashboard to draft through the route's audited OCC mutation. */
export async function setInsightPublication(
  authz: Authz,
  target: "card" | "dashboard",
  id: string,
  publish: boolean,
  expectedUpdatedAt: string,
): Promise<NextResponse> {
  const table: InsightTable = target === "card" ? "insight_cards" : "insight_dashboards";
  const revisionMessage =
    "The record changed; reload and review the latest revision before publishing.";
  return mutateInsight(authz, table, id, "update", async (tx, before, revision) => {
    if (expectedUpdatedAt !== revision) {
      return NextResponse.json({ error: revisionMessage }, { status: 409 });
    }
    const name = before?.name;
    const untitled = target === "card" ? UNTITLED_CARD_NAME : UNTITLED_DASHBOARD_NAME;
    if (publish && (typeof name !== "string" || name.trim() === "" || name === untitled)) {
      return NextResponse.json(
        { error: `Give the ${target} a real name before publishing.` },
        { status: 422 },
      );
    }
    if (publish && target === "card") {
      try {
        validateInsightQuery(before?.query);
      } catch (error) {
        if (error instanceof InsightValidationError) {
          return NextResponse.json(
            { error: `The query is incomplete: ${error.message}` },
            { status: 422 },
          );
        }
        throw error;
      }
    }
    const written = await tx.execute<{ id: string }>(
      sql`update ${sql.identifier(table)}
             set status = ${publish ? "published" : "draft"},
                 updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
                 updated_by = ${authz.user.id}
           where id = ${id} and org_id = ${authz.user.orgId}
           returning id`,
      "objects",
    );
    if (!written[0]) throw new Error("Insight publication did not update its record.");
    const updated = await tx.execute(
      sql`select *, to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at from ${sql.identifier(table)} where id = ${id} and org_id = ${authz.user.orgId}`,
      "objects",
    );
    if (!updated[0]) throw new Error("Insight publication result could not be read.");
    return NextResponse.json(updated[0]);
  });
}
