import { PDFDocument } from 'pdf-lib'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/platform/database'
import {
  buyShipmentLabel,
  readLabelFile,
  ShippingRefusal,
} from '@openbooks/engine/sales/shipping-labels'
import { defineRoute } from '@/lib/api/route'

const buyItem = z.object({
  shipmentId: z.string().uuid(),
  handlingUnitId:z.string().uuid(),
  providerRateId: z.string().min(1).max(200),
})

const bulkBuyBody = z.object({
  accountId: z.string().uuid().nullable().optional(),
  items: z.array(buyItem).min(1).max(100),
})

type BuyRow =
  | { shipmentId: string; handlingUnitId:string; ok: true; labelId: string; trackingNumber: string | null; duplicate: boolean }
  | { shipmentId: string; handlingUnitId:string; ok: false; code: string; message: string; remedy?: string }

/**
 * Buy the previewed labels, one independent transaction per shipment: a
 * provider failure on one parcel never rolls back the others. Successful
 * label PDFs merge into one print-ready document (base64); labels whose
 * file never downloaded print from their provider URL instead.
 */
export const POST = defineRoute({
  permission: 'shipping.manage',
  feature: 'shippingHub',
  body: bulkBuyBody,
  handler: async ({ authz, body }) => {
    const orgId = authz.user.orgId
    const rows: BuyRow[] = []
    const boughtIds: string[] = []
    for (const item of body.items) {
      try {
        const bought = await db.transaction((tx) =>
          buyShipmentLabel(tx, orgId, authz.user.id, {
            shipmentId: item.shipmentId,handlingUnitId:item.handlingUnitId,
            providerRateId: item.providerRateId,
            accountId: body.accountId,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          }),
        )
        boughtIds.push(bought.id)
        rows.push({
          shipmentId: item.shipmentId,handlingUnitId:item.handlingUnitId,
          ok: true,
          labelId: bought.id,
          trackingNumber: bought.trackingNumber,
          duplicate: bought.duplicate,
        })
      } catch (error) {
        rows.push({
          shipmentId: item.shipmentId,handlingUnitId:item.handlingUnitId,
          ok: false,
          code: error instanceof ShippingRefusal ? error.code : 'failed',
          message: error instanceof Error ? error.message : 'Label purchase failed',
          remedy: error instanceof ShippingRefusal ? error.remedy : undefined,
        })
      }
    }
    const merged = await mergeLabelPdfs(orgId, boughtIds)
    return NextResponse.json({ rows, merged })
  },
})

async function mergeLabelPdfs(
  orgId: string,
  labelIds: string[],
): Promise<{ pages: number; pdfBase64: string } | null> {
  const merged = await PDFDocument.create()
  let pages = 0
  for (const labelId of labelIds) {
    let file
    try {
      file = await readLabelFile(db, orgId, labelId)
    } catch {
      continue
    }
    try {
      const source = await PDFDocument.load(file.bytes)
      const copied = await merged.copyPages(source, source.getPageIndices())
      for (const page of copied) merged.addPage(page)
      pages += copied.length
    } catch {
      continue
    }
  }
  if (pages === 0) return null
  const bytes = await merged.save()
  return { pages, pdfBase64: Buffer.from(bytes).toString('base64') }
}
