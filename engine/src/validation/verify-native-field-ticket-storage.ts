/**
 * Certify that every Field Ticket document has exactly one native header and
 * that any temporary legacy JSON copy agrees before it is retired.
 */
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { resolveTargetOrg } from "./target-org.ts";

const args = new Map(
  process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, ...value] = arg.slice(2).split("=");
    return [key!, value.length ? value.join("=") : "true"];
  }),
);
const orgId = args.get("org");
if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) {
  throw new Error("--org=<uuid> is required");
}
await resolveTargetOrg(orgId);

const result = await db.execute(sql`
  select
    (select count(*)::int
       from documents
      where org_id = ${orgId} and kind = 'field_ticket') as documents,
    (select count(*)::int
       from field_tickets
      where org_id = ${orgId}) as native_headers,
    (select count(*)::int
       from documents document
       left join field_tickets ticket
         on ticket.document_id = document.id
        and ticket.org_id = document.org_id
      where document.org_id = ${orgId}
        and document.kind = 'field_ticket'
        and ticket.document_id is null) as missing_native,
    (select count(*)::int
       from field_tickets ticket
       left join documents document
         on document.id = ticket.document_id
        and document.org_id = ticket.org_id
      where ticket.org_id = ${orgId}
        and document.id is null) as orphan_native,
    (select count(*)::int
       from audit_log
      where org_id = ${orgId}
        and table_name = 'field_tickets'
        and changes->>'mode' = 'native_field_ticket_backfill') as backfill_audits,
    (select count(*)::int
       from documents
      where org_id = ${orgId}
        and kind = 'field_ticket'
        and custom ? 'fieldTicket') as legacy_json_copies,
    (select count(*)::int
       from documents document
       join field_tickets ticket
         on ticket.document_id = document.id
        and ticket.org_id = document.org_id
      where document.org_id = ${orgId}
        and document.kind = 'field_ticket'
        and document.custom ? 'fieldTicket'
        and (
          ticket.period is distinct from document.custom->'fieldTicket'->>'period'
          or ticket.period_start::text is distinct from document.custom->'fieldTicket'->>'periodStart'
          or ticket.period_end::text is distinct from document.custom->'fieldTicket'->>'periodEnd'
          or ticket.foreman_party_id::text is distinct from document.custom->'fieldTicket'->>'foremanPartyId'
        )) as legacy_json_mismatches,
    (select count(*)::int
       from field_ticket_signatures
      where org_id = ${orgId}) as signatures,
    (select count(*)::int
       from field_ticket_signature_requests
      where org_id = ${orgId}) as signature_requests
`);
const counts = result.rows[0] as Record<string, number>;
const pass =
  counts.documents === counts.native_headers
  && counts.missing_native === 0
  && counts.orphan_native === 0
  && counts.legacy_json_copies === 0
  && counts.legacy_json_mismatches === 0;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  orgId,
  pass,
  counts,
};
if (args.get("out")) {
  writeFileSync(args.get("out")!, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
if (!pass) process.exitCode = 1;
