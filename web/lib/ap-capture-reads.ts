import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { withScopeSnapshot } from "@openbooks/engine/organization/scope";
import { apCaptureSubsidiaryScope } from "@openbooks/engine/records/file-cabinet-access";

export async function readApCaptureDetail(input: {
  orgId: string;
  captureItemId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ item: Record<string, unknown>; fields: unknown[]; events: unknown[] } | null> {
  return withScopeSnapshot(input.orgId, async () => {
    const result = await db.execute<Record<string, unknown>>(
      sql`
      select ci.*, f.content_type, f.size_bytes
        from ap_capture_items ci join files f on f.id = ci.file_id and f.org_id = ci.org_id
        left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
        left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
       where ci.org_id = ${input.orgId} and ci.id = ${input.captureItemId}
       ${apCaptureSubsidiaryScope(input.allowedSubsidiaryIds)}
    `,
      "objects",
    );
    if (!result[0]) return null;
    const [fields, events] = await Promise.all([
      db.execute(
        sql`
        select af.* from ap_capture_fields af join ap_capture_runs ar on ar.id = af.run_id and ar.org_id = af.org_id
         where af.org_id = ${input.orgId} and ar.capture_item_id = ${input.captureItemId}
         order by ar.attempt desc, af.field_key, af.line_index nulls first
      `,
        "objects",
      ),
      db.execute(
        sql`
        select * from ap_capture_events where org_id = ${input.orgId} and capture_item_id = ${input.captureItemId}
         order by at desc
      `,
        "objects",
      ),
    ]);
    return { item: result[0], fields, events };
  });
}
