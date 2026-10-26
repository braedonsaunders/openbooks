import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { auditService, requireOne, type ServiceActor } from "./common.ts";

/** Release billing links whose invoice was voided natively, so the work can be invoiced again. */
export async function releaseVoidedBillings(actor: ServiceActor, jobId: string): Promise<void> {
  const voided = await db.execute<{ id: string }>(
    sql`select b.id from service_billings b
    join documents d on d.org_id = b.org_id and d.id = b.invoice_document_id
    where b.org_id = ${actor.orgId} and b.job_id = ${jobId} and b.released_at is null and d.status = 'voided' for update of b`,
    "objects",
  );
  for (const row of voided) {
    requireOne(
      await db.execute(
        sql`update service_billings set released_at = now(), released_by = ${actor.actorId}, release_reason = 'The invoice was voided'
      where org_id = ${actor.orgId} and id = ${row.id} and released_at is null returning id`,
        "objects",
      ),
      "The billing release",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_billings",
      rowId: row.id,
      action: "update",
      actorId: actor.actorId,
      after: { released: true },
      reason: "The invoice was voided",
    });
  }
}
