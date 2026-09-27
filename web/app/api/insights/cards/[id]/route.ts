import { defineRoute } from "@/lib/api/route";
import { auditSetupChange } from "@/lib/setup/audit";
import { mutateInsight } from "@/lib/insight-mutations";
import { z } from "zod";
import { INSIGHT_VIZ_TYPES, validateInsightQuery } from "@openbooks/analytics";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { isUuid } from "../../../../../lib/list-params";
import {
  isVizType,
  loadCard,
  normalizeAllowedRoles,
  normalizeQuery,
  normalizeVizSettings,
  strOrNull,
} from "../../_lib";
import { notFound } from "@/lib/api/responses";

export { runtime } from "@/lib/api/route";

/** Lossless wire representation for PostgreSQL's six-digit timestamptz. */
function cardRevisionSql(column: ReturnType<typeof sql.raw>) {
  return sql<string>`to_char(
    ${column} at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )`;
}

const CARD_REVISION_REQUIRED =
  "the card revision is required; reload and review the latest revision";
const CARD_REVISION_CONFLICT =
  "this card changed after you opened it; reload and review the latest revision";

class CardRevisionConflictError extends Error {}

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 });
}

const insightQueryBody = z.json().refine((value) => {
  try { validateInsightQuery(value); return true; } catch { return false; }
}, "query must follow the insight query schema");
const revisionBody = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
  "expectedUpdatedAt must be the exact card revision",
).refine((value) => !Number.isNaN(new Date(value).getTime()), "expectedUpdatedAt must be a valid timestamp");

export const GET = defineRoute({
  permission: "insights.read",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");
    const card = await loadCard(id, gate.user.orgId);
    if (!card)
      return notFound("record");
    return NextResponse.json(card);
  },
});

interface PatchBody {
  name?: string;
  description?: string | null;
  query?: unknown;
  vizType?: string;
  vizSettings?: unknown;
  allowedRoles?: unknown;
  expectedUpdatedAt?: string;
}

/** Autosave for the card studio: name, query plan, viz type + settings, gating. */
export const PATCH = defineRoute({
  permission: "insights.create",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  body: z
    .strictObject({
      name: z.string().trim().min(1, "name cannot be empty").max(200).optional(),
      description: z.string().trim().max(2000).nullable().optional(),
      query: insightQueryBody.optional(),
      vizType: z.enum(INSIGHT_VIZ_TYPES).optional(),
      vizSettings: z.record(z.string().min(1), z.json()).optional(),
      allowedRoles: z.array(z.string().trim().min(1, "allowedRoles cannot contain blank role keys")).nullable().optional(),
      expectedUpdatedAt: revisionBody,
    })
    .refine((body) => Object.keys(body).some((key) => key !== "expectedUpdatedAt"), "provide at least one card field to update"),
  handler: async ({ request: _req, authz: gate, params, body: routeBody }) => {
    const user = gate.user;
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");

    const existing = await loadCard(id, user.orgId);
    if (!existing)
      return notFound("record");

    const body = routeBody as PatchBody;

    // Autosave is a full-card replacement. Require the exact revision the
    // caller loaded so an older debounced request can never restore stale
    // analytical definitions after a newer save commits.
    if (body.expectedUpdatedAt === undefined) {
      return NextResponse.json(
        { error: CARD_REVISION_REQUIRED },
        { status: 409 },
      );
    }
    if (
      typeof body.expectedUpdatedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(
        body.expectedUpdatedAt,
      ) ||
      Number.isNaN(new Date(body.expectedUpdatedAt).getTime())
    ) {
      return NextResponse.json(
        {
          error:
            "expectedUpdatedAt must be the exact updatedAt revision previously read for this card",
        },
        { status: 422 },
      );
    }

    if (body.name !== undefined && typeof body.name !== "string")
      return bad("Card name must be a string");
    const name = body.name !== undefined ? body.name.trim() : undefined;
    if (name !== undefined && name === "")
      return bad("Card name cannot be empty");

    let query: unknown = undefined;
    if (body.query !== undefined) {
      try {
        query = normalizeQuery(body.query);
      } catch (e) {
        return bad(e instanceof Error ? e.message : "invalid query");
      }
    }

    if (body.vizType !== undefined && !isVizType(body.vizType))
      return bad("invalid viz type");

    let vizSettings: unknown = undefined;
    if (body.vizSettings !== undefined) {
      try {
        vizSettings = normalizeVizSettings(body.vizSettings);
      } catch (e) {
        return bad(e instanceof Error ? e.message : "invalid viz settings");
      }
    }

    let allowedRoles: string[] | null | undefined = undefined;
    if (body.allowedRoles !== undefined) {
      try {
        allowedRoles = normalizeAllowedRoles(body.allowedRoles);
      } catch (e) {
        return bad(e instanceof Error ? e.message : "invalid roles");
      }
    }

    try {
      const outcome = await mutateInsight(
        gate,
        "insight_cards",
        id,
        "update",
        async (tx) => {
          const updated = await tx.execute(sql`
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
      and updated_at = ${body.expectedUpdatedAt}::timestamptz
    returning *, ${cardRevisionSql(sql.raw("updated_at"))} as updated_at
  `);
          if (!updated.rows[0]) throw new CardRevisionConflictError();
          return NextResponse.json(updated.rows[0]);
        },
      );
      return outcome;
    } catch (error) {
      if (error instanceof CardRevisionConflictError) {
        return NextResponse.json(
          { error: CARD_REVISION_CONFLICT },
          { status: 409 },
        );
      }
      throw error;
    }
  },
});

export const DELETE = defineRoute({
  permission: "insights.create",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const user = gate.user;
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");

    if (!(await loadCard(id, user.orgId)))
      return notFound("record");

    return mutateInsight(gate, "insight_cards", id, "delete", async (tx) => {
      // Lock affected boards in stable order and advance their revisions, so an
      // in-flight autosave cannot restore a deleted placement.
      const boards = await tx.execute<{
        id: string;
        snapshot: Record<string, unknown>;
      }>(sql`
      select id, to_jsonb(d) as snapshot from insight_dashboards d
      where org_id = ${user.orgId} and layout @> ${JSON.stringify([{ cardId: id }])}::jsonb
      order by id for update
    `);
      await tx.execute(
        sql`delete from insight_cards where id = ${id} and org_id = ${user.orgId}`,
      );
      for (const board of boards.rows) {
        const updated = await tx.execute(sql`
        update insight_dashboards set layout = coalesce((
          select jsonb_agg(elem) from jsonb_array_elements(layout) elem where elem->>'cardId' <> ${id}
        ), '[]'::jsonb), updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${user.id}
        where id = ${board.id} and org_id = ${user.orgId} returning *
      `);
        await auditSetupChange(
          {
            orgId: user.orgId,
            table: "insight_dashboards",
            rowId: board.id,
            action: "update",
            actorId: user.id,
            changes: {
              before: board.snapshot,
              after: updated.rows[0],
              reason: "Referenced card deleted",
            },
          },
          tx,
        );
      }
      return NextResponse.json({ ok: true });
    });
  },
});
