import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@openbooks/engine/src/platform/db.ts';
import { correctReceiptQuantity, correctReceiptRemainder } from '@openbooks/engine/src/inventory/receipt-void-dependents.ts';
import { getAuthz, can, guardSubsidiaryScope } from '../../../../../lib/authz';
import { isFeatureEnabled } from '../../../../../lib/features';
import { isDocKindEnabled } from "../../../../../lib/documents.ts";
import { isUuid } from '../../../../../lib/list-params';
import { notFound } from "@/lib/api/responses";

export const runtime = 'nodejs';

const POSTBodySchema = z.object({
  reason: z.string().min(5).max(500),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Quantity correction for lines whose purchase-side count was wrong
  // while the customer keeps the goods: each line names the quantity the
  // vendor actually delivered. Omitted entirely for the legacy
  // whole-remainder correction of a phantom over-receipt.
  lines: z.array(z.object({
    receiptLineId: z.string().uuid(),
    correctedQuantity: z.string().min(1).max(50),
  }).strict()).min(1).max(500).optional(),
});

/**
 * Correct a phantom over-receipt's unconsumed remainder without voiding
 * the receipt: the leftover leaves through the native inventory
 * adjustment at carried cost, each source order line's received counter
 * restores by exactly the adjusted cover, and the receipt stands as
 * immutable evidence with the correction audited against it. With `lines`
 * the correction instead reduces named receipt lines to their true
 * delivered quantities — the sale stands and only the over-received
 * quantity leaves as a shrink adjustment. Same authority as a receipt
 * void (receiving grant plus the reversal grant when Inventory is on).
 * Engine refusals (nothing left to correct, billed cover, blended
 * layers, phantom units already sold) answer 422 through the shared
 * refusal mapping with the operator's next step.
 */
export const POST = defineRoute({
  public: 'session',
  params: z.object({ id: z.string() }),
  body: POSTBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ params, body }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const { id } = params as { id: string };
    if (!isUuid(id)) return notFound('record');
    const found = (await db.execute<{ kind: string; subsidiaryId: string | null }>(sql`
      select kind, subsidiary_id as "subsidiaryId"
        from documents
       where id = ${id} and org_id = ${authz.user.orgId}
    `));
    const doc = found.rows[0];
    if (!doc || doc.kind !== 'purchase_receipt') return notFound('record');
    const denied = guardSubsidiaryScope(authz, doc.subsidiaryId);
    if (denied) return denied;
    if (!(await isDocKindEnabled(authz.user.orgId, doc.kind))) return notFound('record');
    if (!can(authz, 'goods_receipts.create')) {
      return NextResponse.json({ error: 'missing permission: goods_receipts.create' }, { status: 403 });
    }
    if ((await isFeatureEnabled(authz.user.orgId, 'inventory')) && !can(authz, 'items.reverse')) {
      return NextResponse.json({ error: 'missing permission: items.reverse' }, { status: 403 });
    }
    const { reason, date, lines } = body as {
      reason: string;
      date?: string;
      lines?: { receiptLineId: string; correctedQuantity: string }[];
    };
    if (lines) {
      const result = await correctReceiptQuantity({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        receiptId: id,
        lines,
        reason,
        date,
      });
      return NextResponse.json({ ok: true, ...result });
    }
    const result = await correctReceiptRemainder({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      receiptId: id,
      reason,
      date,
    });
    return NextResponse.json({ ok: true, ...result });
  },
});
