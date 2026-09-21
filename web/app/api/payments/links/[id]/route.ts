import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { PaymentAcceptanceError, voidPaymentLink } from "@openbooks/engine/src/payments/acceptance.ts";
import { guardPermission, guardSubsidiaryScope } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("ar.create");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "onlinePayments"))) {
    return NextResponse.json({ error: "feature disabled" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  // Void is a payment-link record boundary: the stored legal entity is
  // loaded with the org probe, then the shared gate runs before the
  // bearer token can be cancelled. Missing and out-of-scope links both
  // 404, matching /api/documents/[id] and /api/payments/[id].
  const owned = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from payment_links
     where id = ${id} and org_id = ${gate.user.orgId}
  `));
  if (!owned.rows[0]) return NextResponse.json({ error: "not found" }, { status: 404 });
  const denied = guardSubsidiaryScope(gate, owned.rows[0].subsidiaryId);
  if (denied) return denied;
  try {
    await voidPaymentLink(gate.user.orgId, gate.user.id, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const status = e instanceof PaymentAcceptanceError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
