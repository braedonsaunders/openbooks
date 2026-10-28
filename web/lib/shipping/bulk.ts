import "server-only";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import {
  buyShipmentLabel,
  getShipmentRates,
  listBulkCandidates,
  readLabelFile,
  selectRateByRule,
  ShippingRefusal,
} from "@openbooks/engine/sales/shipping-labels";

const UUID = z.string().regex(UUID_RE);

export const bulkPreviewBody = z.object({
  items: z
    .array(
      z
        .object({
          shipmentId: UUID.describe("Shipment UUID to rate."),
          handlingUnitId: UUID.describe("Packed handling-unit UUID to rate."),
        })
        .describe("Shipment parcel to preview."),
    )
    .min(1)
    .max(100)
    .describe("Shipments and parcels included in the rate preview."),
  presetId: UUID.nullable()
    .optional()
    .describe("Package preset UUID, or null to use shipping defaults."),
  accountId: UUID.nullable().optional().describe("Carrier account UUID, or null for the default."),
  rule: z
    .enum(["cheapest", "fastest", "cheapest_by_date"])
    .default("cheapest")
    .describe("Rule for selecting one rate per parcel."),
  promisedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .describe("Latest promised delivery date, in YYYY-MM-DD format."),
});

export const bulkBuyBody = z.object({
  accountId: UUID.nullable().optional().describe("Carrier account UUID, or null for the default."),
  items: z
    .array(
      z
        .object({
          shipmentId: UUID.describe("Shipment UUID whose label will be purchased."),
          handlingUnitId: UUID.describe("Packed handling-unit UUID whose label will be purchased."),
          providerRateId: z
            .string()
            .min(1)
            .max(200)
            .describe("Rate identifier returned by the bulk rate preview."),
        })
        .describe("Parcel and selected carrier rate."),
    )
    .min(1)
    .max(100)
    .describe("Shipment labels to purchase."),
});

export type PreviewRow =
  | {
      shipmentId: string;
      handlingUnitId: string;
      documentNumber: string;
      ok: true;
      providerRateId: string;
      carrier: string;
      service: string;
      amount: string;
      currency: string;
      deliveryDate: string | null;
    }
  | {
      shipmentId: string;
      handlingUnitId: string;
      documentNumber: string | null;
      ok: false;
      code: string;
      message: string;
      remedy?: string;
    };

export type BuyRow =
  | {
      shipmentId: string;
      handlingUnitId: string;
      ok: true;
      labelId: string;
      trackingNumber: string | null;
      duplicate: boolean;
    }
  | {
      shipmentId: string;
      handlingUnitId: string;
      ok: false;
      code: string;
      message: string;
      remedy?: string;
    };

/** Draft shipments without labels, for the bulk shipping workflow. */
export async function listBulkShipmentCandidates(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
) {
  return listBulkCandidates(db, orgId, allowedSubsidiaryIds);
}

/** Rate every parcel independently and preserve a row-level reason when one cannot be rated. */
export async function previewBulkShipmentLabels(
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  input: z.infer<typeof bulkPreviewBody>,
): Promise<{ rows: PreviewRow[] }> {
  const rows: PreviewRow[] = [];
  for (const item of input.items) {
    try {
      const quote = await db.transaction((tx) =>
        getShipmentRates(tx, orgId, actorId, {
          shipmentId: item.shipmentId,
          handlingUnitId: item.handlingUnitId,
          presetId: input.presetId,
          accountId: input.accountId,
          allowedSubsidiaryIds,
        }),
      );
      const chosen = selectRateByRule(quote.rates, input.rule, input.promisedDate);
      if (!chosen) {
        rows.push({
          shipmentId: item.shipmentId,
          handlingUnitId: item.handlingUnitId,
          documentNumber: quote.documentNumber,
          ok: false,
          code: "no_rate_on_time",
          message: `No rate for ${quote.documentNumber} arrives by ${input.promisedDate}`,
          remedy: "Pick a later promised date or buy the fastest rate instead",
        });
        continue;
      }
      rows.push({
        shipmentId: item.shipmentId,
        handlingUnitId: item.handlingUnitId,
        documentNumber: quote.documentNumber,
        ok: true,
        providerRateId: chosen.providerRateId,
        carrier: chosen.carrier,
        service: chosen.service,
        amount: chosen.amount,
        currency: chosen.currency,
        deliveryDate: chosen.deliveryDate,
      });
    } catch (error) {
      rows.push({
        shipmentId: item.shipmentId,
        handlingUnitId: item.handlingUnitId,
        documentNumber: null,
        ok: false,
        code: error instanceof ShippingRefusal ? error.code : "failed",
        message: error instanceof Error ? error.message : "Rating failed",
        ...(error instanceof ShippingRefusal && error.remedy ? { remedy: error.remedy } : {}),
      });
    }
  }
  return { rows };
}

/** Buy each chosen label in its own transaction so one provider refusal does not roll back other parcels. */
export async function buyBulkShipmentLabels(
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  input: z.infer<typeof bulkBuyBody>,
): Promise<{ rows: BuyRow[]; merged: { pages: number; pdfBase64: string } | null }> {
  const rows: BuyRow[] = [];
  const boughtIds: string[] = [];
  for (const item of input.items) {
    try {
      const bought = await db.transaction((tx) =>
        buyShipmentLabel(tx, orgId, actorId, {
          shipmentId: item.shipmentId,
          handlingUnitId: item.handlingUnitId,
          providerRateId: item.providerRateId,
          accountId: input.accountId,
          allowedSubsidiaryIds,
        }),
      );
      boughtIds.push(bought.id);
      rows.push({
        shipmentId: item.shipmentId,
        handlingUnitId: item.handlingUnitId,
        ok: true,
        labelId: bought.id,
        trackingNumber: bought.trackingNumber,
        duplicate: bought.duplicate,
      });
    } catch (error) {
      rows.push({
        shipmentId: item.shipmentId,
        handlingUnitId: item.handlingUnitId,
        ok: false,
        code: error instanceof ShippingRefusal ? error.code : "failed",
        message: error instanceof Error ? error.message : "Label purchase failed",
        ...(error instanceof ShippingRefusal && error.remedy ? { remedy: error.remedy } : {}),
      });
    }
  }
  return { rows, merged: await mergeLabelPdfs(orgId, boughtIds, allowedSubsidiaryIds) };
}

async function mergeLabelPdfs(
  orgId: string,
  labelIds: string[],
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ pages: number; pdfBase64: string } | null> {
  const merged = await PDFDocument.create();
  let pages = 0;
  for (const labelId of labelIds) {
    let file;
    try {
      file = await readLabelFile(db, orgId, labelId, allowedSubsidiaryIds);
    } catch {
      continue;
    }
    try {
      const source = await PDFDocument.load(file.bytes);
      const copied = await merged.copyPages(source, source.getPageIndices());
      for (const page of copied) merged.addPage(page);
      pages += copied.length;
    } catch {
      continue;
    }
  }
  if (pages === 0) return null;
  const bytes = await merged.save();
  return { pages, pdfBase64: Buffer.from(bytes).toString("base64") };
}
