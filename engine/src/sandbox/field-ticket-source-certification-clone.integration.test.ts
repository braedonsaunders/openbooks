import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import {
  createScratchOrg,
  createScratchUser,
  grantScratchPermissions,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { certifyFieldTicketSourceIdentity } from "../projects/field-ticket-source-certification.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";

installEngineSeams();
const DB = !!process.env.OPENBOOKS_DB_URL;

const EXTERNAL_ID = "123e4567-e89b-42d3-a456-426614174000";
const SOURCE_BYTES = Buffer.from(
  JSON.stringify([
    {
      sourceId: EXTERNAL_ID,
      number: "FT-9",
      jobRef: "JOB-1",
      empRef: "E1",
      customerRef: "C1",
      begin: "2024-06-10",
      end: "2024-06-16",
      billed: false,
      final: true,
      approval: "Yes",
      foremanRef: "F1",
      superintendentRef: "S1",
      po: null,
      description: "Week nine",
    },
  ]),
  "utf8",
);
const SOURCE_SHA256 = createHash("sha256").update(SOURCE_BYTES).digest("hex");
const EMPLOYEE_NAME = "Zelda Privateperson";

async function cloneFlags() {
  await db.execute(sql`select set_config('openbooks.clone','on',true),
    set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`);
}

for (const masked of [false, true])
  test(
    `${masked ? "masked" : "full"} sandbox keeps the exact Field Ticket source certification without carrying native person evidence`,
    { skip: !DB },
    async () => {
      const org = await createScratchOrg();
      const name = `Field Ticket certification ${randomUUID()}`;
      try {
        const actor = await createScratchUser(
          org.orgId,
          "Source certifier",
          `source_certifier_${randomUUID()}`,
        );
        await grantScratchPermissions(org.orgId, actor, [
          "time.manage",
          "time.read",
          "documents.read",
        ]);
        await db.execute(
          sql`update orgs set settings = jsonb_set(settings, '{features}', '{"projects":true,"fieldTickets":true}'::jsonb) where id = ${org.orgId}`,
        );

        const projectId = String(
          (
            await db.execute<{ id: string }>(
              sql`
      insert into projects (org_id, subsidiary_id, name, custom)
      values (${org.orgId}, ${org.subsidiaryId}, 'JOB-1', ${JSON.stringify({ nsId: "JOB-1" })}::jsonb) returning id
    `,
              "objects",
            )
          )[0]!.id,
        );
        const party = async (nsId: string) =>
          String(
            (
              await db.execute<{ id: string }>(
                sql`
      insert into parties (org_id, kind, display_name, custom)
      values (${org.orgId}, 'employee', ${nsId}, ${JSON.stringify({ nsId })}::jsonb) returning id
    `,
                "objects",
              )
            )[0]!.id,
          );
        await db.execute(
          sql`insert into customer_roles(org_id,party_id) values (${org.orgId},${org.customerId})`,
        );
        const foremanId = await party("F1");
        const superintendentId = await party("S1");
        const employeeId = await party("E1");
        await db.execute(sql`update parties set custom = custom || '{"nsId":"C1"}'::jsonb
      where org_id = ${org.orgId} and id = (select party_id from customer_roles where org_id = ${org.orgId} order by party_id limit 1)`);
        const customerId = String(
          (
            await db.execute<{ party_id: string }>(
              sql`
      select party_id::text from customer_roles where org_id = ${org.orgId} order by party_id limit 1
    `,
              "objects",
            )
          )[0]!.party_id,
        );
        const ticketId = String(
          (
            await db.execute<{ id: string }>(
              sql`
      insert into documents (org_id, kind, document_number, party_id, project_id, subsidiary_id, document_date, currency, status, custom)
      values (${org.orgId}, 'field_ticket', 'FT-9', ${customerId}, ${projectId}, ${org.subsidiaryId}, '2024-06-16', 'CAD', 'approved', '{}'::jsonb)
      returning id
    `,
              "objects",
            )
          )[0]!.id,
        );
        await db.execute(sql`
      insert into field_tickets (document_id, org_id, period, period_start, period_end, foreman_party_id, superintendent_party_id)
      values (${ticketId}, ${org.orgId}, 'weekly', '2024-06-10', '2024-06-16', ${foremanId}, ${superintendentId})
    `);
        const snapshotId = String(
          (
            await db.execute<{ id: string }>(
              sql`
      insert into field_ticket_labor_snapshots (org_id, field_ticket_id, revision, evidence_basis, reason, currency, captured_by)
      values (${org.orgId}, ${ticketId}, 1, 'operational_time', 'Approval capture', 'CAD', ${actor}) returning id
    `,
              "objects",
            )
          )[0]!.id,
        );
        await db.execute(sql`
      insert into field_ticket_labor_lines
        (org_id, snapshot_id, field_ticket_id, sequence, employee_party_id, employee_name, time_type_name, time_classification, worked_on, hours)
      values (${org.orgId}, ${snapshotId}, ${ticketId}, 1, ${employeeId}, ${EMPLOYEE_NAME}, 'Regular', 'regular', '2024-06-10', '8')
    `);
        const folderId = String(
          (
            await db.execute<{ id: string }>(
              sql`
      insert into folders (org_id, name) values (${org.orgId}, 'Source exports') returning id
    `,
              "objects",
            )
          )[0]!.id,
        );
        const fileId = String(
          (
            await db.execute<{ id: string }>(
              sql`
      insert into files (org_id, folder_id, name, content_type, size_bytes, storage_kind, content_hash, created_by)
      values (${org.orgId}, ${folderId}, 'field-ticket-headers.json', 'application/json', ${SOURCE_BYTES.length}, 'db', ${SOURCE_SHA256}, ${actor})
      returning id
    `,
              "objects",
            )
          )[0]!.id,
        );
        const versionId = String(
          (
            await db.execute<{ id: string }>(
              sql`
      insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind, content_hash, created_by)
      values (${fileId}, 1, ${SOURCE_BYTES.length}, 'application/json', 'db', ${SOURCE_SHA256}, ${actor})
      returning id
    `,
              "objects",
            )
          )[0]!.id,
        );
        await db.execute(
          sql`insert into file_blobs (version_id, bytes) values (${versionId}, ${SOURCE_BYTES})`,
        );
        await db.execute(
          sql`update files set current_version_id = ${versionId} where org_id = ${org.orgId} and id = ${fileId}`,
        );

        const revision = String(
          (
            await db.execute<{ revision: string }>(
              sql`
      select revision_seq::text as revision from documents where org_id = ${org.orgId} and id = ${ticketId}
    `,
              "objects",
            )
          )[0]!.revision,
        );
        const certified = await certifyFieldTicketSourceIdentity({
          orgId: org.orgId,
          actorId: actor,
          requestId: randomUUID(),
          nativeDocumentId: ticketId,
          expectedNativeRevision: revision,
          sourceSystem: "legacy-app",
          sourceTicketId: EXTERNAL_ID,
          sourceFileId: fileId,
          sourceVersionId: versionId,
          sourceFileSha256: SOURCE_SHA256,
          attestation:
            "I reviewed the retained source export against this native ticket and attest this crosswalk.",
          reason:
            "The native ticket has no source identity and this is its reviewed source ticket.",
          explicitReferenceMap: {
            jobRef: "JOB-1",
            customerRef: "C1",
            foremanRef: "F1",
            superintendentRef: "S1",
            projectId,
            customerPartyId: customerId,
            foremanPartyId: foremanId,
            superintendentPartyId: superintendentId,
          },
        });
        const production = (
          await db.execute<{ native_fingerprint_sha256: string; source_row_sha256: string }>(
            sql`
      select native_fingerprint_sha256, source_row_sha256 from field_ticket_source_certifications where org_id = ${org.orgId} and id = ${certified.id}
    `,
            "objects",
          )
        )[0]!;

        const created = await createSandbox({
          productionOrgId: org.orgId,
          name,
          tier: masked ? "masked" : "full",
          masked,
          createdBy: actor,
          lifecycleAuthority: { actorId: actor },
        });
        const target = created.sandboxOrgId;
        const copied = (
          await db.execute<{
            source_system: string;
            source_external_id: string;
            native_document_id: string;
            native_point_in_time: Record<string, unknown>;
            attestation: string;
            reason: string;
            native_fingerprint_sha256: string;
            row_text: string;
            source_row_snapshot: { sourceId: string };
            source_row_sha256: string;
            reference_project_id: string;
          }>(
            sql`
      select c.source_system, c.source_external_id, c.native_document_id::text,
             c.native_point_in_time, c.attestation, c.reason, c.native_fingerprint_sha256,
             c.source_row_snapshot, c.source_row_sha256,
             c.reference_map->'job'->>'nativeId' as reference_project_id,
             to_jsonb(c)::text as row_text
        from field_ticket_source_certifications c join orgs o on o.id = c.org_id
       where c.org_id = ${target} and c.id = ob_rebase(${certified.id}::uuid, o.sandbox_seed)
    `,
            "objects",
          )
        )[0]!;
        assert.equal(copied.source_system, "legacy-app");
        assert.equal(copied.source_external_id, EXTERNAL_ID);
        assert.equal(
          copied.source_row_snapshot.sourceId,
          EXTERNAL_ID,
          "the source snapshot is external evidence: its own ticket identity is never rebased",
        );
        assert.equal(
          copied.source_row_sha256,
          production.source_row_sha256,
          "the source row hash keeps its original attribution",
        );
        const rebasedTicket = (
          await db.execute<{ id: string }>(
            sql`
      select ob_rebase(${ticketId}::uuid, sandbox_seed)::text as id from orgs where id = ${target}
    `,
            "objects",
          )
        )[0]!.id;
        assert.equal(copied.native_document_id, rebasedTicket);
        const rebasedProject = (
          await db.execute<{ id: string }>(
            sql`
      select ob_rebase(${projectId}::uuid, sandbox_seed)::text as id from orgs where id = ${target}
    `,
            "objects",
          )
        )[0]!.id;
        assert.equal(
          copied.reference_project_id,
          rebasedProject,
          "the reference map rebases its native project while its source identity stays original",
        );
        assert.notEqual(copied.reference_project_id, projectId);
        assert.equal(
          copied.native_fingerprint_sha256,
          production.native_fingerprint_sha256,
          "the fingerprint keeps its attribution to the original source evidence",
        );
        if (masked) {
          assert.deepEqual(copied.native_point_in_time, {
            maskedEvidence: "REDACTED",
            fingerprintAttribution:
              "native_fingerprint_sha256 retains the original source fingerprint; this masked copy carries no native point-in-time before-image",
          });
          assert.equal(
            copied.row_text.includes(EMPLOYEE_NAME),
            false,
            "no embedded employee name crosses into a masked copy",
          );
          assert.equal(copied.row_text.includes("employee_name"), false);
          assert.equal(copied.attestation, "REDACTED");
          assert.equal(copied.reason, "REDACTED");
        } else {
          assert.match(
            JSON.stringify(copied.native_point_in_time),
            /Zelda Privateperson/,
            "an unmasked copy retains the exact native before-image",
          );
          assert.match(
            JSON.stringify(copied.native_point_in_time),
            new RegExp(rebasedTicket),
            "the copied before-image names rebased sandbox identities",
          );
          assert.equal(JSON.stringify(copied.native_point_in_time).includes(ticketId), false);
        }

        await withMaintenanceTransaction(null, async () => {
          await cloneFlags();
          const readyMatch = (
            await db.execute<{ matches: boolean }>(
              sql`
        select public.field_ticket_source_certifications_clone_matches(to_jsonb(c)) as matches
          from field_ticket_source_certifications c join orgs o on o.id=c.org_id
         where c.org_id=${target} and c.id=ob_rebase(${certified.id}::uuid,o.sandbox_seed)
      `,
              "objects",
            )
          )[0]!;
          assert.equal(readyMatch.matches, false, "ready sandboxes have no clone-insert admission");
          const refreshing = await db.execute(
            sql`update sandboxes set status='refreshing'
        where id=${created.sandboxId} and org_id=${target} and status='ready' returning id`,
            "objects",
          );
          assert.equal(refreshing.length, 1);
          const verdicts = (
            await db.execute<{ exact: boolean; forged: boolean }>(
              sql`
        select public.field_ticket_source_certifications_clone_matches(to_jsonb(c)) as exact,
               public.field_ticket_source_certifications_clone_matches(
                 to_jsonb(c) || jsonb_build_object('source_external_id', '999')) as forged
          from field_ticket_source_certifications c join orgs o on o.id = c.org_id
         where c.org_id = ${target} and c.id = ob_rebase(${certified.id}::uuid, o.sandbox_seed)
      `,
              "objects",
            )
          )[0]!;
          assert.deepEqual(
            verdicts,
            { exact: true, forged: false },
            "clone authority admits only the exact authoritative projection",
          );
          assert.equal(
            (
              await db.execute(
                sql`update sandboxes set status='ready'
        where id=${created.sandboxId} and org_id=${target} and status='refreshing' returning id`,
                "objects",
              )
            ).length,
            1,
          );
        });
        await deleteSandbox(created.sandboxId, { actorId: actor });
      } finally {
        const shells = await db.execute<{ id: string }>(
          sql`select id from sandboxes where production_org_id = ${org.orgId} and name = ${name}`,
          "objects",
        );
        for (const shell of shells)
          await deleteSandbox(shell.id, {
            systemReason: "Remove Field Ticket certification clone fixture",
          });
        await dropScratchOrg(org.orgId);
      }
    },
  );
