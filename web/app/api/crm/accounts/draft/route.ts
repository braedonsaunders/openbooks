import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import { ensureCrmDefaults } from "@openbooks/engine/crm/crm";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const DRAFT_STAGES = ["lead", "prospect"] as const;
type DraftStage = (typeof DRAFT_STAGES)[number];

// An empty object defaults to a lead; only the optional stage is read. The
// schema refuses array and non-object bodies.
const draftBody = z.strictObject({
  lifecycleStage: z
    .enum(DRAFT_STAGES, {
      error: `lifecycleStage must be one of ${DRAFT_STAGES.join(", ")}`,
    })
    .optional(),
});

export const POST = defineRoute({
  permission: "crm.accounts.create",
  feature: "crm",
  body: draftBody,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body }) => {
    const { user } = gate;
    if (gate.allowedSubsidiaryIds?.size === 0) return notFound("record");
    // The factory accepts {} and reads only an optional stage: the unified
    // account list's New button passes the
    // lifecycle segment it is on, so prospects come through this same endpoint.
    // Anything else fails closed instead of silently minting a lead.
    const rawStage = body.lifecycleStage;
    const stage: DraftStage = rawStage === undefined ? "lead" : (rawStage as DraftStage);
    if (!DRAFT_STAGES.includes(stage))
      return NextResponse.json({ error: "invalid lifecycle stage" }, { status: 422 });
    // 'New lead' stays the shared inactive-placeholder sentinel for both stages:
    // the parties PATCH completes it reason-free and the drawer blanks it.
    const reason = stage === "lead" ? "Lead created" : "Prospect created";
    await ensureCrmDefaults(user.orgId, user.id);
    const result = await db.transaction(async (tx) => {
      const party = await tx.execute<{ id: string }>(
        sql`
        insert into parties (org_id, kind, display_name, is_active, created_by, updated_by)
        values (${user.orgId}, 'company', 'New lead', false, ${user.id}, ${user.id}) returning id
      `,
        "objects",
      );
      const status = await tx.execute<{ id: string }>(
        sql`
        select id from crm_account_statuses
         where org_id = ${user.orgId} and lifecycle_stage = ${stage} and is_default and is_active
         order by sequence limit 1`,
        "objects",
      );
      const profile = await tx.execute<{ id: string }>(
        sql`
        insert into crm_account_profiles
          (org_id, party_id, lifecycle_stage, status_id, owner_user_id, is_active, created_by, updated_by)
        values (${user.orgId}, ${party[0]!.id}, ${stage}, ${status[0]?.id ?? null}, ${user.id}, false, ${user.id}, ${user.id})
        returning id`,
        "objects",
      );
      await tx.execute(sql`
        insert into crm_account_stage_events
          (org_id, account_profile_id, to_stage, source_kind, reason, created_by, updated_by)
        values (${user.orgId}, ${profile[0]!.id}, ${stage}, 'manual', ${reason}, ${user.id}, ${user.id})`);
      return { id: party[0]!.id };
    });
    return NextResponse.json(result);
  },
});
