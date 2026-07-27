/**
 * Remove the obsolete documents.custom.fieldTicket compatibility copy after
 * native code is deployed and relational parity is proven.
 *
 * Dry-run by default. Live writes require --apply --production --reason.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../db.ts";
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
const apply = args.get("apply") === "true";
const reason = args.get("reason")?.trim() ?? "";
if (apply && (reason.length < 10 || reason.length > 500)) {
  throw new Error("--reason must be 10-500 characters when applying");
}
const target = await resolveTargetOrg(orgId);
if (apply && target.isProduction && !process.argv.includes("--production")) {
  throw new Error("--production is required for a live tenant");
}

const rows = await db.execute(sql`
  select document.id, document.custom, document.custom->'fieldTicket' as legacy
    from documents document
    join field_tickets ticket
      on ticket.document_id = document.id
     and ticket.org_id = document.org_id
   where document.org_id = ${orgId}
     and document.kind = 'field_ticket'
     and document.custom ? 'fieldTicket'
     and ticket.period is not distinct from document.custom->'fieldTicket'->>'period'
     and ticket.period_start::text is not distinct from document.custom->'fieldTicket'->>'periodStart'
     and ticket.period_end::text is not distinct from document.custom->'fieldTicket'->>'periodEnd'
     and ticket.foreman_party_id::text is not distinct from document.custom->'fieldTicket'->>'foremanPartyId'
`);
const total = await db.execute(sql`
  select
    count(*) filter (where document.custom ? 'fieldTicket')::int as legacy_copies,
    count(*) filter (where ticket.document_id is null)::int as missing_native,
    count(*) filter (
      where document.custom ? 'fieldTicket'
        and (
          ticket.period is distinct from document.custom->'fieldTicket'->>'period'
          or ticket.period_start::text is distinct from document.custom->'fieldTicket'->>'periodStart'
          or ticket.period_end::text is distinct from document.custom->'fieldTicket'->>'periodEnd'
          or ticket.foreman_party_id::text is distinct from document.custom->'fieldTicket'->>'foremanPartyId'
        )
    )::int as mismatches,
    count(*) filter (
      where document.custom->'fieldTicket' ?| array[
        'signatures', 'send', 'chargeDocumentId', 'submittedBy',
        'submittedAt', 'rejectionReason'
      ]
    )::int as unretired_evidence,
    count(*) filter (
      where exists (
        select 1
          from jsonb_object_keys(document.custom->'fieldTicket') as field(key)
         where field.key not in (
           'period', 'periodStart', 'periodEnd', 'foremanPartyId',
           'signatures', 'send', 'chargeDocumentId', 'submittedBy',
           'submittedAt', 'rejectionReason'
         )
      )
    )::int as unexpected_fields
  from documents document
  left join field_tickets ticket
    on ticket.document_id = document.id
   and ticket.org_id = document.org_id
  where document.org_id = ${orgId}
    and document.kind = 'field_ticket'
`);
const counts = total.rows[0] as {
  legacy_copies: number
  missing_native: number
  mismatches: number
  unretired_evidence: number
  unexpected_fields: number
};
if (
  counts.missing_native !== 0
  || counts.mismatches !== 0
  || counts.unretired_evidence !== 0
  || counts.unexpected_fields !== 0
  || rows.rows.length !== counts.legacy_copies
) {
  throw new Error(
    `cleanup refused: ${JSON.stringify({ ...counts, eligible: rows.rows.length })}`,
  );
}

if (apply && rows.rows.length) {
  const requestId = randomUUID();
  const batchSize = 100;
  for (let offset = 0; offset < rows.rows.length; offset += batchSize) {
    const batch = rows.rows.slice(offset, offset + batchSize) as Array<{
      id: string
      custom: Record<string, unknown>
      legacy: Record<string, unknown>
    }>;
    await withOrg(orgId, async () => {
      await db.execute(sql`
        with change as (
          select *
            from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
                 as row(id uuid, custom jsonb, legacy jsonb)
        )
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        select ${orgId}, 'documents', change.id, 'update',
               jsonb_build_object(
                 'mode', 'retire_legacy_native_field_ticket_json',
                 'reason', ${reason}::text,
                 'before', jsonb_build_object('custom.fieldTicket', change.legacy),
                 'after', jsonb_build_object('custom.fieldTicket', null)
               ),
               null, ${requestId}
          from change
      `);
      await db.execute(sql`
        with change as (
          select *
            from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
                 as row(id uuid, legacy jsonb)
        )
        update documents document
           set custom = document.custom - 'fieldTicket',
               updated_at = now()
          from change
         where document.id = change.id
           and document.org_id = ${orgId}
           and document.custom->'fieldTicket' = change.legacy
      `);
    });
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  orgId,
  applied: apply,
  reason: apply ? reason : null,
  counts: {
    ...counts,
    eligible: rows.rows.length,
  },
};
if (args.get("out")) writeFileSync(args.get("out")!, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
