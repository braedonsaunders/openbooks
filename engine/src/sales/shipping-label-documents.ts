import { createHash } from "node:crypto";
import { fetchWithConnectorRetry } from "../connectors/http-retry.ts";
import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { assertShippingFeature, ShippingRefusal, type Scope } from "./shipping-accounts.ts";

const LABEL_PDF_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Store the provider's label PDF in the file cabinet in the SAME transaction
 * as the label row — the insert shapes mirror engine/src/hrm/documents/
 * cabinet.ts (files + file_versions + file_blobs + file_attachments under a
 * per-record folder), so the label reads through the normal download path.
 * Best-effort on the bytes: a bought label is financial truth even when its
 * PDF cannot be fetched right now, so a failed download keeps the provider
 * URL and leaves the file to a retry instead of losing the purchase.
 */
export async function storeLabelPdf(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  labelId: string,
  documentNumber: string,
  labelUrl: string,
  transport?: typeof fetch,
): Promise<string | null> {
  let bytes: ArrayBuffer;
  try {
    const res = await fetchWithConnectorRetry(
      labelUrl,
      {},
      {
        describe: "carrier label download",
        timeoutMs: 30_000,
        maxAttempts: 2,
        transport,
      },
    );
    if (!res.ok) return null;
    const length = Number(res.headers.get("content-length") ?? "0");
    if (Number.isInteger(length) && length > LABEL_PDF_MAX_BYTES) return null;
    bytes = await res.arrayBuffer();
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > LABEL_PDF_MAX_BYTES) return null;
  const content = Buffer.from(bytes);
  const contentHash = createHash("sha256").update(content).digest("hex");
  const lockKey = `shipping-label-folder:${orgId}:${labelId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  const existing = (
    await tx.execute<{ id: string }>(
      sql`
    select id from folders
     where org_id = ${orgId} and record_table = 'shipment_labels' and record_id = ${labelId}
       and record_id is not null for share`,
      "objects",
    )
  )[0];
  let folderId = existing?.id;
  if (!folderId) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"shipping-attachments-root:" + orgId}, 0))`,
    );
    const root = (
      await tx.execute<{ id: string }>(
        sql`
      select id from folders where org_id = ${orgId} and system_kind = 'attachments'`,
        "objects",
      )
    )[0];
    const rootId =
      root?.id ??
      (
        await tx.execute<{ id: string }>(
          sql`
      insert into folders (org_id, name, is_system, system_kind, created_at, updated_at)
      values (${orgId}, 'Attachments', true, 'attachments', now(), now()) returning id`,
          "objects",
        )
      )[0]!.id;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"shipping-attach-group:" + orgId}, 0))`,
    );
    const group = (
      await tx.execute<{ id: string }>(
        sql`
      select id from folders where org_id = ${orgId} and parent_folder_id = ${rootId}
        and record_id is null and name = 'Shipping labels'`,
        "objects",
      )
    )[0];
    const groupId =
      group?.id ??
      (
        await tx.execute<{ id: string }>(
          sql`
      insert into folders (org_id, parent_folder_id, name, is_system, record_table, created_at, updated_at)
      values (${orgId}, ${rootId}, 'Shipping labels', true, 'shipment_labels', now(), now()) returning id`,
          "objects",
        )
      )[0]!.id;
    folderId = (
      await tx.execute<{ id: string }>(
        sql`
      insert into folders (org_id, parent_folder_id, name, is_system, record_table, record_id, created_at, updated_at)
      values (${orgId}, ${groupId}, ${"shipment_labels / " + labelId.slice(0, 8)}, true, 'shipment_labels', ${labelId}, now(), now())
      returning id`,
        "objects",
      )
    )[0]!.id;
  }
  const filename = `${documentNumber.replace(/[^A-Za-z0-9-]+/g, "-")}-label.pdf`;
  const fileId = (
    await tx.execute<{ id: string }>(
      sql`
    insert into files (org_id, folder_id, name, extension, file_type, content_type,
                       size_bytes, storage_kind, content_hash, created_by, updated_by, created_at, updated_at)
    values (${orgId}, ${folderId}, ${filename}, 'pdf', 'pdf', 'application/pdf',
            ${content.length}, 'db', ${contentHash}, ${actorId}, ${actorId}, now(), now())
    returning id`,
      "objects",
    )
  )[0]!.id;
  const versionId = (
    await tx.execute<{ id: string }>(
      sql`
    insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind,
                               content_hash, created_by, created_at)
    values (${fileId}, 1, ${content.length}, 'application/pdf', 'db', ${contentHash}, ${actorId}, now())
    returning id`,
      "objects",
    )
  )[0]!.id;
  const patched = await tx.execute<{ id: string }>(
    sql`
    update files set current_version_id = ${versionId} where id = ${fileId} and org_id = ${orgId} returning id`,
    "objects",
  );
  if (patched.length === 0) throw new Error("label file was not linked to its version");
  await tx.execute(
    sql`insert into file_blobs (version_id, bytes) values (${versionId}, ${content})`,
  );
  // Justified: the file_attachments_unique key makes link creation idempotent,
  // so a retried unit converges instead of failing on its own earlier effect.
  await tx.execute(sql`
    insert into file_attachments (org_id, file_id, target_table, target_id, created_by, created_at)
    values (${orgId}, ${fileId}, 'shipment_labels', ${labelId}, ${actorId}, now())
    -- An existing attachment already links the same label bytes to this label record.
    on conflict (org_id, file_id, target_table, target_id) do nothing`);
  return fileId;
}

export interface ShipmentLabelView {
  id: string;
  handlingUnitId: string | null;
  handlingUnitCode: string | null;
  direction: "outbound" | "return" | null;
  accountName: string;
  provider: string;
  carrier: string;
  service: string;
  trackingNumber: string | null;
  trackingStatus: string;
  status: string;
  amountMinor: string;
  currency: string;
  labelUrl: string | null;
  hasFile: boolean;
  costEntryId: string | null;
  purchasedAt: string;
  voidedAt: string | null;
  events: { id: string | null; status: string; detail: string | null; occurredAt: string | null }[];
}

/** Every label on a shipment, newest first, for the drawer timeline. */
export async function getShipmentLabels(
  runner: SqlExecutor,
  orgId: string,
  shipmentId: string,
): Promise<ShipmentLabelView[]> {
  await assertShippingFeature(runner, orgId);
  const rows = await runner.execute<{
    handling_unit_id: string | null;
    handling_unit_code: string | null;
    direction: "outbound" | "return" | null;
    id: string;
    account_name: string;
    provider: string;
    carrier: string;
    service: string;
    tracking_number: string | null;
    tracking_status: string;
    status: string;
    rate_minor: string;
    rate_currency: string;
    label_url: string | null;
    label_file_id: string | null;
    cost_entry_id: string | null;
    purchased_at: string;
    voided_at: string | null;
    events: ShipmentLabelView["events"];
  }>(
    sql`
    select l.id,l.handling_unit_id,unit.code as handling_unit_code,l.direction, a.name as account_name, l.provider, l.carrier, l.service,
           l.tracking_number, l.tracking_status, l.status,
           l.rate_minor::text, l.rate_currency, l.label_url,
           l.label_file_id, l.cost_entry_id,
           l.purchased_at::text, l.voided_at::text, l.events
      from shipment_labels l
      join shipping_accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join handling_units unit on unit.org_id=l.org_id and unit.id=l.handling_unit_id
     where l.org_id = ${orgId} and l.shipment_document_id = ${shipmentId}
     order by l.purchased_at desc`,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    handlingUnitId: row.handling_unit_id,
    handlingUnitCode: row.handling_unit_code,
    direction: row.direction,
    accountName: row.account_name,
    provider: row.provider,
    carrier: row.carrier,
    service: row.service,
    trackingNumber: row.tracking_number,
    trackingStatus: row.tracking_status,
    status: row.status,
    amountMinor: row.rate_minor,
    currency: row.rate_currency,
    labelUrl: row.label_url,
    hasFile: row.label_file_id != null,
    costEntryId: row.cost_entry_id,
    purchasedAt: row.purchased_at,
    voidedAt: row.voided_at,
    events: row.events ?? [],
  }));
}

export interface LabelFile {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/**
 * The stored label PDF for download. Labels bought while the provider file
 * was unreachable have no file — the caller falls back to the provider
 * label URL instead of failing the download.
 */
export async function readLabelFile(
  runner: SqlExecutor,
  orgId: string,
  labelId: string,
  allowedSubsidiaryIds: Scope,
): Promise<LabelFile> {
  await assertShippingFeature(runner, orgId);
  const row = (
    await runner.execute<{
      filename: string;
      content_type: string;
      bytes: Buffer;
      document_number: string;
    }>(
      sql`
    select f.name as filename, v.content_type, b.bytes, d.document_number
      from shipment_labels l
      join files f on f.id = l.label_file_id and f.org_id = l.org_id
      join file_versions v on v.id = f.current_version_id
      join file_blobs b on b.version_id = v.id
      join documents d on d.id = l.shipment_document_id and d.org_id = l.org_id and d.kind = 'shipment'
     where l.org_id = ${orgId} and l.id = ${labelId}
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}`,
      "objects",
    )
  )[0];
  if (!row) throw new ShippingRefusal("Shipping label file not found", "not_found", 404);
  return { filename: row.filename, contentType: row.content_type, bytes: row.bytes };
}
