import { defineRoute } from "@/lib/api/route";
import { UNTITLED_DASHBOARD_NAME } from "@/lib/insight-untitled";
import { z } from "zod";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { isUuid } from "../../../../lib/list-params";
import {
  claimIdempotentCreate,
  resolveIdempotentReplay,
} from "../../../../lib/api/idempotency";
import { auditSetupChange } from "../../../../lib/setup/audit";
import {
  layoutCardsVisible,
  normalizeAllowedRoles,
  normalizeLayout,
  strOrNull,
} from "../_lib";

export { runtime } from "@/lib/api/route";

const layoutBody = z.array(z.strictObject({
  cardId: z.string().uuid("layout.cardId must be a valid id"),
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(999),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(24),
}), { error: "layout must be an array of card placements" }).max(1000, "layout cannot contain more than 1000 cards");
const createDashboardBodySchema = z.strictObject({
  name: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  layout: layoutBody.optional(),
  allowedRoles: z.array(z.string().trim().min(1, "allowedRoles cannot contain blank role keys")).nullable().optional(),
});

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 });
}

/**
 * A layout naming a missing or foreign card. Thrown inside the create
 * transaction so the refusal rolls back the whole unit (no row, no audit
 * event) and caught below into the same 422 PATCH returns.
 */
class DashboardCardRefusal extends Error {
  constructor() {
    super("Layout references an unavailable card");
    this.name = "DashboardCardRefusal";
  }
}

/**
 * Explicit create for an insight dashboard. The New button opens a LOCAL
 * dialog (name + description, zero writes) and this endpoint runs only on
 * Save: the caller supplies a UUID idempotency key, which becomes the
 * dashboard id, so retrying the same request returns the same dashboard
 * without a duplicate insert or duplicate audit event. Cancel/close writes
 * nothing — there is no draft row.
 */
export const POST = defineRoute({
  permission: "insights.create",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  body: createDashboardBodySchema,
  handler: async ({ request: req, authz: gate, body: routeBody }) => {
    const user = gate.user;

    const requestId = req.headers.get("Idempotency-Key")?.trim() ?? "";
    if (!isUuid(requestId)) {
      return NextResponse.json(
        { error: "invalid_idempotency_key" },
        { status: 400 },
      );
    }

    const body = routeBody;

    if (body.name !== undefined && typeof body.name !== "string") {
      return bad("Dashboard name must be a string");
    }
    const name = body.name?.trim() || UNTITLED_DASHBOARD_NAME;
    const description = strOrNull(body.description);

    let layout: ReturnType<typeof normalizeLayout>;
    try {
      layout = normalizeLayout(body.layout ?? []);
    } catch (e) {
      return bad(e instanceof Error ? e.message : "invalid layout");
    }
    let allowedRoles: string[] | null;
    try {
      allowedRoles = normalizeAllowedRoles(body.allowedRoles);
    } catch (e) {
      return bad(e instanceof Error ? e.message : "invalid roles");
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
        // Transactional and equivalent to PATCH: a layout naming a missing or
        // foreign card is refused inside this same transaction, before any
        // insert, so the refusal commits nothing — no row, no audit event.
        if (!(await layoutCardsVisible(tx, gate, layout))) {
          throw new DashboardCardRefusal();
        }
        const inserted = await tx.execute<{ id: string }>(sql`
      insert into insight_dashboards
        (id, org_id, name, description, layout, status, allowed_roles, created_by, updated_by)
      values
        (${requestId}, ${user.orgId}, ${name}, ${description},
         ${JSON.stringify(layout)}::jsonb, 'draft',
         ${allowedRoles ? JSON.stringify(allowedRoles) : null}::jsonb,
         ${user.id}, ${user.id})
      on conflict (id) do nothing
      returning id
    `);
        if (!inserted.rows[0]) {
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
    } catch (e) {
      if (e instanceof DashboardCardRefusal) return bad(e.message);
      throw e;
    }
    if (outcome === "conflict") {
      return NextResponse.json(
        { error: "invalid_idempotency_key" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { id: requestId },
      { status: outcome === "fresh" ? 201 : 200 },
    );
  },
});
