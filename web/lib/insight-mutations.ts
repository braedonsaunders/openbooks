import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import type { Authz } from "./authz";
import { insightVisibilitySql } from "./insight-access";
import { auditSetupChange } from "./setup/audit";
import { notFound } from "@/lib/api/responses";
import {
  INSIGHT_VIZ_TYPES,
  InsightValidationError,
  validateInsightQuery,
  type VizType,
} from "@openbooks/analytics";
import { UNTITLED_CARD_NAME, UNTITLED_DASHBOARD_NAME } from "./insight-untitled";
import { isUuid } from "./list-params";
import { claimIdempotentCreate, resolveIdempotentReplay } from "./api/idempotency";
import {
  guardInsightCardQuery,
  layoutCardsVisible,
  loadCard,
  loadDashboard,
  normalizeAllowedRoles,
  normalizeLayout,
  normalizeQuery,
  normalizeVizSettings,
  strOrNull,
} from "../app/api/insights/_lib";

const DEFAULT_CARD_QUERY = {
  source: "ledger_lines",
  measures: [{ agg: "sum", field: "amount" }],
  dimensions: [{ field: "posting_date", bin: "month" }],
};

function invalidInsightBody(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 422 });
}

function conflictResponse(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 409 });
}

function isVizType(value: unknown): value is VizType {
  return typeof value === "string" && (INSIGHT_VIZ_TYPES as readonly string[]).includes(value);
}

function cardRevisionSql(column: SQL): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function dashboardRevisionSql(column: SQL): SQL<string> {
  return cardRevisionSql(column);
}

export interface CreateInsightCardInput {
  name?: string;
  description?: string | null;
  query?: unknown;
  vizType?: string;
  vizSettings?: unknown;
  allowedRoles?: unknown;
}

/** Route and application command share card creation and audited replay behavior. */
export async function createInsightCard(
  authz: Authz,
  requestId: string,
  body: CreateInsightCardInput,
): Promise<NextResponse> {
  const user = authz.user;
  if (!isUuid(requestId))
    return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  if (body.name !== undefined && typeof body.name !== "string") {
    return invalidInsightBody("Card name must be a string");
  }
  const name = body.name?.trim() || UNTITLED_CARD_NAME;
  let query: ReturnType<typeof normalizeQuery>;
  try {
    query = normalizeQuery(body.query ?? DEFAULT_CARD_QUERY);
  } catch (error) {
    return invalidInsightBody(error instanceof Error ? error.message : "invalid query");
  }
  const queryDenied = await guardInsightCardQuery(authz, query);
  if (queryDenied) return queryDenied;
  const vizType = body.vizType ?? "bar";
  if (typeof vizType !== "string" || !isVizType(vizType)) {
    return invalidInsightBody("invalid viz type");
  }
  let vizSettings: ReturnType<typeof normalizeVizSettings>;
  try {
    vizSettings = normalizeVizSettings(body.vizSettings);
  } catch (error) {
    return invalidInsightBody(error instanceof Error ? error.message : "invalid viz settings");
  }
  let allowedRoles: string[] | null;
  try {
    allowedRoles = normalizeAllowedRoles(body.allowedRoles);
  } catch (error) {
    return invalidInsightBody(error instanceof Error ? error.message : "invalid roles");
  }
  const description = strOrNull(body.description);
  const snapshot = {
    id: requestId,
    org_id: user.orgId,
    name,
    description,
    query,
    viz_type: vizType,
    viz_settings: vizSettings,
    allowed_roles: allowedRoles,
  };
  const match = {
    name,
    description,
    query,
    viz_type: vizType,
    viz_settings: vizSettings,
    allowed_roles: allowedRoles,
  };
  const outcome = await db.transaction(async (tx) => {
    const claim = await claimIdempotentCreate(tx, {
      orgId: user.orgId,
      table: "insight_cards",
      key: requestId,
    });
    if (claim === "exists") {
      return resolveIdempotentReplay(tx, {
        orgId: user.orgId,
        table: "insight_cards",
        key: requestId,
        match,
      });
    }
    const inserted = await tx.execute<{ id: string }>(
      sql`
        insert into insight_cards
          (id, org_id, name, description, query, viz_type, viz_settings,
           status, allowed_roles, created_by, updated_by)
        values
          (${requestId}, ${user.orgId}, ${name}, ${description},
           ${JSON.stringify(query)}::jsonb, ${vizType}, ${JSON.stringify(vizSettings)}::jsonb,
           'draft', ${allowedRoles ? JSON.stringify(allowedRoles) : null}::jsonb,
           ${user.id}, ${user.id})
        -- A retry resolves the existing audited payload below; conflicting input is refused.
        on conflict (id) do nothing
        returning id
      `,
      "objects",
    );
    if (!inserted[0]) {
      return resolveIdempotentReplay(tx, {
        orgId: user.orgId,
        table: "insight_cards",
        key: requestId,
        match,
      });
    }
    await auditSetupChange(
      {
        orgId: user.orgId,
        table: "insight_cards",
        rowId: requestId,
        action: "insert",
        changes: { before: null, after: snapshot },
        actorId: user.id,
        requestId,
      },
      tx,
    );
    return "fresh" as const;
  });
  if (outcome === "conflict") {
    return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 409 });
  }
  return NextResponse.json({ id: requestId }, { status: outcome === "fresh" ? 201 : 200 });
}

export interface UpdateInsightCardInput extends CreateInsightCardInput {
  expectedUpdatedAt?: string;
}

/** Exact-revision card autosave shared by the API route and external command. */
export async function updateInsightCard(
  authz: Authz,
  id: string,
  body: UpdateInsightCardInput,
): Promise<NextResponse> {
  const user = authz.user;
  if (!isUuid(id)) return notFound("record");
  if (!(await loadCard(id, user.orgId, authz))) return notFound("record");
  const expected = body.expectedUpdatedAt;
  if (expected === undefined) {
    return conflictResponse("the card revision is required; reload and review the latest revision");
  }
  if (
    typeof expected !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(expected) ||
    Number.isNaN(new Date(expected).getTime())
  ) {
    return invalidInsightBody(
      "expectedUpdatedAt must be the exact updatedAt revision previously read for this card",
    );
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    return invalidInsightBody("Card name must be a string");
  }
  const name = body.name !== undefined ? body.name.trim() : undefined;
  if (name !== undefined && name === "") return invalidInsightBody("Card name cannot be empty");
  let query: unknown;
  if (body.query !== undefined) {
    try {
      query = normalizeQuery(body.query);
    } catch (error) {
      return invalidInsightBody(error instanceof Error ? error.message : "invalid query");
    }
    const queryDenied = await guardInsightCardQuery(authz, query);
    if (queryDenied) return queryDenied;
  }
  if (body.vizType !== undefined && !isVizType(body.vizType)) {
    return invalidInsightBody("invalid viz type");
  }
  let vizSettings: unknown;
  if (body.vizSettings !== undefined) {
    try {
      vizSettings = normalizeVizSettings(body.vizSettings);
    } catch (error) {
      return invalidInsightBody(error instanceof Error ? error.message : "invalid viz settings");
    }
  }
  let allowedRoles: string[] | null | undefined;
  if (body.allowedRoles !== undefined) {
    try {
      allowedRoles = normalizeAllowedRoles(body.allowedRoles);
    } catch (error) {
      return invalidInsightBody(error instanceof Error ? error.message : "invalid roles");
    }
  }
  try {
    return await mutateInsight(authz, "insight_cards", id, "update", async (tx) => {
      const updated = await tx.execute(
        sql`
          update insight_cards set
            name = ${name !== undefined ? name : sql`name`},
            description = ${body.description !== undefined ? strOrNull(body.description) : sql`description`},
            query = ${query !== undefined ? sql`${JSON.stringify(query)}::jsonb` : sql`query`},
            viz_type = ${body.vizType !== undefined ? body.vizType : sql`viz_type`},
            viz_settings = ${vizSettings !== undefined ? sql`${JSON.stringify(vizSettings)}::jsonb` : sql`viz_settings`},
            allowed_roles = ${allowedRoles !== undefined ? sql`${allowedRoles ? JSON.stringify(allowedRoles) : null}::jsonb` : sql`allowed_roles`},
            updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
            updated_by = ${user.id}
          where id = ${id}
            and org_id = ${user.orgId}
            and updated_at = ${expected}::timestamptz
          returning *, ${cardRevisionSql(sql.raw("updated_at"))} as updated_at
        `,
        "objects",
      );
      if (!updated[0]) {
        return conflictResponse(
          "this card changed after you opened it; reload and review the latest revision",
        );
      }
      return NextResponse.json(updated[0]);
    });
  } catch (error) {
    throw error;
  }
}

export async function deleteInsightCard(authz: Authz, id: string): Promise<NextResponse> {
  const user = authz.user;
  if (!isUuid(id)) return notFound("record");
  if (!(await loadCard(id, user.orgId, authz))) return notFound("record");
  return mutateInsight(authz, "insight_cards", id, "delete", async (tx) => {
    const boards = await tx.execute<{ id: string; snapshot: Record<string, unknown> }>(
      sql`
        select id, to_jsonb(d) as snapshot from insight_dashboards d
        where org_id = ${user.orgId} and layout @> ${JSON.stringify([{ cardId: id }])}::jsonb
        order by id for update
      `,
      "objects",
    );
    const deleted = await tx.execute<{ id: string }>(
      sql`delete from insight_cards where id = ${id} and org_id = ${user.orgId} returning id`,
      "objects",
    );
    if (!deleted[0]) throw new Error("Insight card deletion did not affect a row.");
    for (const board of boards) {
      const updated = await tx.execute(
        sql`
          update insight_dashboards set layout = coalesce((
            select jsonb_agg(elem) from jsonb_array_elements(layout) elem where elem->>'cardId' <> ${id}
          ), '[]'::jsonb), updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${user.id}
          where id = ${board.id} and org_id = ${user.orgId} returning *
        `,
        "objects",
      );
      if (!updated[0]) throw new Error("Insight dashboard placement cleanup did not update a row.");
      await auditSetupChange(
        {
          orgId: user.orgId,
          table: "insight_dashboards",
          rowId: board.id,
          action: "update",
          actorId: user.id,
          changes: {
            before: board.snapshot,
            after: updated[0],
            reason: "Referenced card deleted",
          },
        },
        tx,
      );
    }
    return NextResponse.json({ ok: true });
  });
}

export interface CreateInsightDashboardInput {
  name?: string;
  description?: string | null;
  layout?: unknown;
  allowedRoles?: unknown;
}

class DashboardCardRefusal extends Error {
  constructor() {
    super("Layout references an unavailable card");
    this.name = "DashboardCardRefusal";
  }
}

/** Route and command share dashboard creation with tenant-scoped card validation. */
export async function createInsightDashboard(
  authz: Authz,
  requestId: string,
  body: CreateInsightDashboardInput,
): Promise<NextResponse> {
  const user = authz.user;
  if (!isUuid(requestId))
    return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  if (body.name !== undefined && typeof body.name !== "string") {
    return invalidInsightBody("Dashboard name must be a string");
  }
  const name = body.name?.trim() || UNTITLED_DASHBOARD_NAME;
  const description = strOrNull(body.description);
  let layout: ReturnType<typeof normalizeLayout>;
  try {
    layout = normalizeLayout(body.layout ?? []);
  } catch (error) {
    return invalidInsightBody(error instanceof Error ? error.message : "invalid layout");
  }
  let allowedRoles: string[] | null;
  try {
    allowedRoles = normalizeAllowedRoles(body.allowedRoles);
  } catch (error) {
    return invalidInsightBody(error instanceof Error ? error.message : "invalid roles");
  }
  const snapshot = {
    id: requestId,
    org_id: user.orgId,
    name,
    description,
    layout,
    allowed_roles: allowedRoles,
  };
  const match = { name, description, layout, allowed_roles: allowedRoles };
  let outcome: "fresh" | "replay" | "conflict";
  try {
    outcome = await db.transaction(async (tx) => {
      const claim = await claimIdempotentCreate(tx, {
        orgId: user.orgId,
        table: "insight_dashboards",
        key: requestId,
      });
      if (claim === "exists") {
        return resolveIdempotentReplay(tx, {
          orgId: user.orgId,
          table: "insight_dashboards",
          key: requestId,
          match,
        });
      }
      if (!(await layoutCardsVisible(tx, authz, layout))) throw new DashboardCardRefusal();
      const inserted = await tx.execute<{ id: string }>(
        sql`
          insert into insight_dashboards
            (id, org_id, name, description, layout, status, allowed_roles, created_by, updated_by)
          values
            (${requestId}, ${user.orgId}, ${name}, ${description}, ${JSON.stringify(layout)}::jsonb,
             'draft', ${allowedRoles ? JSON.stringify(allowedRoles) : null}::jsonb, ${user.id}, ${user.id})
          -- A retry resolves the existing audited payload below; conflicting input is refused.
          on conflict (id) do nothing
          returning id
        `,
        "objects",
      );
      if (!inserted[0]) {
        return resolveIdempotentReplay(tx, {
          orgId: user.orgId,
          table: "insight_dashboards",
          key: requestId,
          match,
        });
      }
      await auditSetupChange(
        {
          orgId: user.orgId,
          table: "insight_dashboards",
          rowId: requestId,
          action: "insert",
          changes: { before: null, after: snapshot },
          actorId: user.id,
          requestId,
        },
        tx,
      );
      return "fresh" as const;
    });
  } catch (error) {
    if (error instanceof DashboardCardRefusal) return invalidInsightBody(error.message);
    throw error;
  }
  if (outcome === "conflict") {
    return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 409 });
  }
  return NextResponse.json({ id: requestId }, { status: outcome === "fresh" ? 201 : 200 });
}

export interface UpdateInsightDashboardInput extends CreateInsightDashboardInput {
  expectedUpdatedAt?: string;
}

/** Exact-revision dashboard autosave shared by its route and command. */
export async function updateInsightDashboard(
  authz: Authz,
  id: string,
  body: UpdateInsightDashboardInput,
): Promise<NextResponse> {
  const user = authz.user;
  if (!isUuid(id)) return notFound("record");
  if (!(await loadDashboard(id, user.orgId, authz))) return notFound("record");
  const expected = body.expectedUpdatedAt;
  if (
    typeof expected !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(expected)
  ) {
    return conflictResponse(
      "the dashboard revision is required; reload and review the latest revision",
    );
  }
  const name = body.name !== undefined ? body.name.trim() : undefined;
  if (name !== undefined && name === "")
    return invalidInsightBody("Dashboard name cannot be empty");
  let layout: ReturnType<typeof normalizeLayout> | undefined;
  if (body.layout !== undefined) {
    try {
      layout = normalizeLayout(body.layout);
    } catch (error) {
      return invalidInsightBody(error instanceof Error ? error.message : "invalid layout");
    }
  }
  let allowedRoles: string[] | null | undefined;
  if (body.allowedRoles !== undefined) {
    try {
      allowedRoles = normalizeAllowedRoles(body.allowedRoles);
    } catch (error) {
      return invalidInsightBody(error instanceof Error ? error.message : "invalid roles");
    }
  }
  return mutateInsight(authz, "insight_dashboards", id, "update", async (tx) => {
    const locked = (
      await tx.execute<{ updatedAt: string }>(
        sql`
          select ${dashboardRevisionSql(sql.raw("updated_at"))} as "updatedAt"
            from insight_dashboards where id = ${id} and org_id = ${user.orgId} for update
        `,
        "objects",
      )
    )[0];
    if (!locked || locked.updatedAt !== expected) {
      return conflictResponse(
        "this dashboard changed after you opened it; reload and review the latest revision",
      );
    }
    if (layout !== undefined && !(await layoutCardsVisible(tx, authz, layout))) {
      return invalidInsightBody("Layout references an unavailable card");
    }
    const updated = await tx.execute(
      sql`
        update insight_dashboards set
          name = ${name !== undefined ? name : sql`name`},
          description = ${body.description !== undefined ? strOrNull(body.description) : sql`description`},
          layout = ${layout !== undefined ? sql`${JSON.stringify(layout)}::jsonb` : sql`layout`},
          allowed_roles = ${allowedRoles !== undefined ? sql`${allowedRoles ? JSON.stringify(allowedRoles) : null}::jsonb` : sql`allowed_roles`},
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
          updated_by = ${user.id}
        where id = ${id} and org_id = ${user.orgId}
        returning *, ${dashboardRevisionSql(sql.raw("updated_at"))} as updated_at
      `,
      "objects",
    );
    if (!updated[0]) throw new Error("Insight dashboard update did not affect a row.");
    return NextResponse.json(updated[0]);
  });
}

export async function deleteInsightDashboard(authz: Authz, id: string): Promise<NextResponse> {
  const user = authz.user;
  if (!isUuid(id)) return notFound("record");
  if (!(await loadDashboard(id, user.orgId, authz))) return notFound("record");
  return mutateInsight(authz, "insight_dashboards", id, "delete", async (tx) => {
    await tx.execute(
      sql`delete from insight_dashboard_pins where dashboard_id = ${id} and org_id = ${user.orgId}`,
    );
    const deleted = await tx.execute<{ id: string }>(
      sql`delete from insight_dashboards where id = ${id} and org_id = ${user.orgId} returning id`,
      "objects",
    );
    if (!deleted[0]) throw new Error("Insight dashboard deletion did not affect a row.");
    return NextResponse.json({ ok: true });
  });
}

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
