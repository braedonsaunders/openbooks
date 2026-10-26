import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@openbooks/engine/platform/db";
import {
  billMatchCandidates,
  matchVendorBillLines,
} from "@openbooks/engine/payables/vendor-bill-matching";
import { getAuthz, can, guardSubsidiaryScope } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";
import { DOC_KINDS, createPermission } from "../../../../../lib/document-kinds.ts";
import { canReadDocumentKind } from "../../../../../lib/flow-subject-authz.ts";
import { isDocKindEnabled } from "../../../../../lib/documents.ts";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const POSTBodySchema = z.object({
  matches: z
    .array(
      z.object({
        billLineId: uuidString(),
        purchaseOrderLineId: uuidString(),
      }),
    )
    .min(1)
    .max(200),
  expectedUpdatedAt: z.string().min(1).optional(),
});

/**
 * Match a hand-coded vendor bill to its purchase order after the fact.
 *
 * GET names every stocked bill line without provenance and the approved
 * purchase-order lines still holding its item open (with their goods
 * receipts, so the operator confirms the right delivery). POST stamps the
 * chosen links: conversion-grade provenance on the bill lines, a bills
 * edge per order, and a billed-quantity advance under conversion's own
 * ceilings — so the matched bill posts like a converted one. Both verbs
 * need the bill's read grant; matching additionally needs its edit grant.
 * Reading never mutates.
 */
async function authorize(
  orgId: string,
  authz: NonNullable<Awaited<ReturnType<typeof getAuthz>>>,
  id: string,
  write: boolean,
) {
  const [row] = await db
    .select({
      id: schema.documents.id,
      kind: schema.documents.kind,
      status: schema.documents.status,
      subsidiaryId: schema.documents.subsidiaryId,
    })
    .from(schema.documents)
    .where(and(eq(schema.documents.id, id), eq(schema.documents.orgId, orgId)));
  if (!row || row.kind !== "vendor_bill") return { denied: notFound("record") as NextResponse };
  const denied = guardSubsidiaryScope(authz, row.subsidiaryId);
  if (denied) return { denied };
  if (!(await isDocKindEnabled(orgId, row.kind)))
    return { denied: notFound("record") as NextResponse };
  const cfg = DOC_KINDS[row.kind];
  if (!cfg)
    return {
      denied: NextResponse.json(
        { error: `kind "${row.kind}" is not actionable here` },
        { status: 422 },
      ),
    };
  if (!canReadDocumentKind(authz, row.kind)) return { denied: notFound("record") as NextResponse };
  if (write) {
    const perm = createPermission(row.kind);
    if (!can(authz, perm)) {
      return {
        denied: NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 }),
      };
    }
  }
  return { denied: null as NextResponse | null };
}

export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ params }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = params as { id: string };
    if (!isUuid(id)) return notFound("record");
    const { denied } = await authorize(authz.user.orgId, authz, id, false);
    if (denied) return denied;
    return NextResponse.json(await billMatchCandidates(authz.user.orgId, id));
  },
});

export const POST = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  body: POSTBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ params, body }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = params as { id: string };
    if (!isUuid(id)) return notFound("record");
    const { denied } = await authorize(authz.user.orgId, authz, id, true);
    if (denied) return denied;
    const { matched } = await matchVendorBillLines({
      orgId: authz.user.orgId,
      billId: id,
      actorId: authz.user.id,
      matches: (body as { matches: { billLineId: string; purchaseOrderLineId: string }[] }).matches,
      expectedUpdatedAt: (body as { expectedUpdatedAt?: string }).expectedUpdatedAt,
    });
    return NextResponse.json({ ok: true, matched });
  },
});
