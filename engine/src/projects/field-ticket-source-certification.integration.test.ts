import assert from "node:assert/strict";
import { guardRefusalMessage } from "../platform/database-refusal.ts";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  grantScratchPermissions,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import {
  certifyFieldTicketSourceIdentity,
  listFieldTicketSourceCertificationCandidates,
  nativePointInTimeFingerprint,
  type CertifyFieldTicketSourceIdentityInput,
} from "./field-ticket-source-certification.ts";
import { mergeProjects } from "./merge.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const enabled = { skip: !DB };

const SOURCE_HEADER = [
  "id",
  "TSNumber",
  "JobID",
  "EmpID",
  "CustomerID",
  "PPEBegin",
  "PPEEnd",
  "Billed",
  "FinalTimesheet",
  "ApprovalStatus",
  "ForemanID",
  "SuperintendentID",
  "PO",
  "Description",
].join("\t");
const SOURCE_ROW_100 = [
  "100",
  "FT-9",
  "JOB-1",
  "E1",
  "C1",
  "2024-06-10",
  "2024-06-16",
  "No",
  "Yes",
  "Yes",
  "F1",
  "S1",
  "NULL",
  "Week nine",
].join("\t");
const SOURCE_ROW_101 = [
  "101",
  "FT-101",
  "JOB-1",
  "E1",
  "C1",
  "2024-06-17",
  "2024-06-23",
  "No",
  "Yes",
  "Yes",
  "F1",
  "S1",
  "NULL",
  "Another ticket",
].join("\t");
const SOURCE_BYTES = Buffer.from(
  `${SOURCE_HEADER}\n${SOURCE_ROW_100}\n${SOURCE_ROW_101}\n`,
  "utf8",
);
const SOURCE_SHA256 = createHash("sha256").update(SOURCE_BYTES).digest("hex");

interface Fixture {
  orgId: string;
  actorId: string;
  ticketId: string;
  projectId: string;
  customerId: string;
  foremanId: string;
  superintendentId: string;
  fileId: string;
  versionId: string;
}

async function party(orgId: string, nsId: string): Promise<string> {
  return String(
    (
      await db.execute<{ id: string }>(
        sql`
    insert into parties (org_id, kind, display_name, custom)
    values (${orgId}, 'employee', ${nsId}, ${JSON.stringify({ nsId })}::jsonb)
    returning id
  `,
        "objects",
      )
    )[0]!.id,
  );
}

async function retainedSourceFile(
  orgId: string,
  actorId: string,
): Promise<{ fileId: string; versionId: string }> {
  const folderId = String(
    (
      await db.execute<{ id: string }>(
        sql`
    insert into folders (org_id, name) values (${orgId}, 'Source exports') returning id
  `,
        "objects",
      )
    )[0]!.id,
  );
  const fileId = String(
    (
      await db.execute<{ id: string }>(
        sql`
    insert into files (org_id, folder_id, name, extension, file_type, content_type, size_bytes, storage_kind, content_hash, created_by)
    values (${orgId}, ${folderId}, 'field-ticket-headers.tsv', 'tsv', 'text', 'text/tab-separated-values',
            ${SOURCE_BYTES.length}, 'db', ${SOURCE_SHA256}, ${actorId})
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
    values (${fileId}, 1, ${SOURCE_BYTES.length}, 'text/tab-separated-values', 'db', ${SOURCE_SHA256}, ${actorId})
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
    sql`update files set current_version_id = ${versionId} where org_id = ${orgId} and id = ${fileId}`,
  );
  return { fileId, versionId };
}

async function fixture(
  status = "approved",
  marker: unknown = { retained: "native context" },
): Promise<Fixture> {
  const org = await createScratchOrg();
  const orgId = org.orgId;
  const actorId = await createScratchUser(
    orgId,
    "Source certifier",
    `source_certifier_${randomUUID()}`,
  );
  await grantScratchPermissions(orgId, actorId, ["time.manage", "time.read", "documents.read"]);
  await db.execute(
    sql`update orgs set settings = jsonb_set(settings, '{features}', '{"projects":true,"fieldTickets":true}'::jsonb) where id = ${orgId}`,
  );

  const projectId = String(
    (
      await db.execute<{ id: string }>(
        sql`
    insert into projects (org_id, subsidiary_id, name, custom)
    values (${orgId}, ${org.subsidiaryId}, 'JOB-1', ${JSON.stringify({ nsId: "JOB-1" })}::jsonb)
    returning id
  `,
        "objects",
      )
    )[0]!.id,
  );
  await db.execute(
    sql`insert into customer_roles(org_id,party_id) values (${orgId},${org.customerId})`,
  );
  const foremanId = await party(orgId, "F1");
  const superintendentId = await party(orgId, "S1");
  await db.execute(sql`update parties set custom = custom || '{"nsId":"C1"}'::jsonb
    where org_id = ${orgId} and id = (select party_id from customer_roles where org_id = ${orgId} order by party_id limit 1)`);
  const customerId = String(
    (
      await db.execute<{ party_id: string }>(
        sql`
    select party_id::text from customer_roles where org_id = ${orgId} order by party_id limit 1
  `,
        "objects",
      )
    )[0]!.party_id,
  );

  const ticketId = String(
    (
      await db.execute<{ id: string }>(
        sql`
    insert into documents (org_id, kind, document_number, party_id, project_id, subsidiary_id, document_date, currency, status, subtotal, tax_total, total, custom)
    values (${orgId}, 'field_ticket', 'FT-9', ${customerId}, ${projectId}, ${org.subsidiaryId}, '2024-06-16', 'CAD', ${status}, '95', '0', '95', ${JSON.stringify(marker)}::jsonb)
    returning id
  `,
        "objects",
      )
    )[0]!.id,
  );
  await db.execute(sql`
    insert into field_tickets (document_id, org_id, period, period_start, period_end, foreman_party_id, superintendent_party_id)
    values (${ticketId}, ${orgId}, 'weekly', '2024-06-10', '2024-06-16', ${foremanId}, ${superintendentId})
  `);
  const { fileId, versionId } = await retainedSourceFile(orgId, actorId);
  return {
    orgId,
    actorId,
    ticketId,
    projectId,
    customerId,
    foremanId,
    superintendentId,
    fileId,
    versionId,
  };
}

async function revision(orgId: string, ticketId: string): Promise<string> {
  return String(
    (
      await db.execute<{ revision: string }>(
        sql`
    select revision_seq::text as revision from documents where org_id = ${orgId} and id = ${ticketId}
  `,
        "objects",
      )
    )[0]!.revision,
  );
}

function certificationInput(
  fixtureRow: Fixture,
  expectedNativeRevision: string,
  overrides: Partial<CertifyFieldTicketSourceIdentityInput> = {},
): CertifyFieldTicketSourceIdentityInput {
  return {
    orgId: fixtureRow.orgId,
    actorId: fixtureRow.actorId,
    requestId: randomUUID(),
    nativeDocumentId: fixtureRow.ticketId,
    expectedNativeRevision,
    sourceSystem: "legacy-app",
    sourceTicketId: "100",
    sourceFileId: fixtureRow.fileId,
    sourceVersionId: fixtureRow.versionId,
    sourceFileSha256: SOURCE_SHA256,
    attestation:
      "I reviewed the retained source export against this native ticket and attest this crosswalk.",
    reason: "The native ticket has no source identity and this is its reviewed source ticket.",
    explicitReferenceMap: {
      jobRef: "JOB-1",
      customerRef: "C1",
      foremanRef: "F1",
      superintendentRef: "S1",
      projectId: fixtureRow.projectId,
      customerPartyId: fixtureRow.customerId,
      foremanPartyId: fixtureRow.foremanId,
      superintendentPartyId: fixtureRow.superintendentId,
    },
    ...overrides,
  };
}

async function protectedFacts(orgId: string, ticketId: string) {
  return (
    await db.execute(
      sql`
    select d.status, d.subtotal::text as subtotal, d.tax_total::text as tax_total, d.total::text as total,
           d.party_id::text as party_id, d.project_id::text as project_id, d.subsidiary_id::text as subsidiary_id,
           ft.period_start::text as period_start, ft.period_end::text as period_end,
           ft.foreman_party_id::text as foreman, ft.superintendent_party_id::text as superintendent,
           (select count(*)::int from document_lines where org_id = ${orgId} and document_id = ${ticketId}) as lines,
           (select count(*)::int from time_entries where org_id = ${orgId} and field_ticket_id = ${ticketId}) as time_entries,
           (select count(*)::int from field_ticket_labor_snapshots where org_id = ${orgId} and field_ticket_id = ${ticketId}) as snapshots,
           (select count(*)::int from field_ticket_signatures where org_id = ${orgId} and field_ticket_id = ${ticketId}) as signatures
      from documents d join field_tickets ft on ft.org_id = d.org_id and ft.document_id = d.id
     where d.org_id = ${orgId} and d.id = ${ticketId}
  `,
      "objects",
    )
  )[0]!;
}

async function certificationCount(orgId: string): Promise<number> {
  return Number(
    (
      await db.execute<{ count: string }>(
        sql`
    select count(*)::text as count from field_ticket_source_certifications where org_id = ${orgId}
  `,
        "objects",
      )
    )[0]!.count,
  );
}

test(
  "project merge refuses to reassign an immutable Field Ticket identity certification",
  enabled,
  async () => {
    const row = await fixture("draft");
    try {
      await certifyFieldTicketSourceIdentity(
        certificationInput(row, await revision(row.orgId, row.ticketId)),
      );
      const survivorId = String(
        (
          await db.execute<{ id: string }>(
            sql`
      insert into projects (org_id, subsidiary_id, name, custom)
      values (${row.orgId}, (select subsidiary_id from projects where org_id = ${row.orgId} and id = ${row.projectId}),
              'Survivor', '{}'::jsonb)
      returning id
    `,
            "objects",
          )
        )[0]!.id,
      );

      await assert.rejects(
        mergeProjects(row.orgId, { survivorId, duplicateId: row.projectId, actorId: row.actorId }),
        /append-only history .*field_ticket_source_certifications\.native_project_id.*keep the duplicate as the historical owner/,
      );
      const certification = (
        await db.execute<{ native_project_id: string }>(
          sql`
      select native_project_id from field_ticket_source_certifications
       where org_id = ${row.orgId} and native_document_id = ${row.ticketId}
    `,
          "objects",
        )
      )[0];
      assert.equal(certification?.native_project_id, row.projectId);
      const ticket = (
        await db.execute<{ project_id: string }>(
          sql`
      select project_id from documents where org_id = ${row.orgId} and id = ${row.ticketId}
    `,
          "objects",
        )
      )[0];
      assert.equal(ticket?.project_id, row.projectId);
    } finally {
      await dropScratchOrg(row.orgId);
    }
  },
);

test("a human-reviewed crosswalk certifies a used ticket as metadata only", enabled, async () => {
  const row = await fixture("draft");
  try {
    await db.execute(sql`
      insert into document_lines (org_id, document_id, line_number, description, quantity, unit_price, amount, tax_amount, account_id)
      values (${row.orgId}, ${row.ticketId}, 1, 'Reviewed work', '1', '95', '95', '0',
        (select id from accounts where org_id=${row.orgId} and type='income' order by id limit 1))
    `);
    await db.execute(
      sql`update documents set status='approved' where org_id=${row.orgId} and id=${row.ticketId}`,
    );
    const snapshotId = String(
      (
        await db.execute<{ id: string }>(
          sql`
      insert into field_ticket_labor_snapshots (org_id, field_ticket_id, revision, evidence_basis, reason, currency, captured_by)
      values (${row.orgId}, ${row.ticketId}, 1, 'operational_time', 'Approval capture', 'CAD', ${row.actorId}) returning id
    `,
          "objects",
        )
      )[0]!.id,
    );
    const employeeId = await party(row.orgId, "E1");
    await db.execute(sql`
      insert into field_ticket_labor_lines
        (org_id, snapshot_id, field_ticket_id, sequence, employee_party_id, employee_name, time_type_name, time_classification, worked_on, hours)
      values (${row.orgId}, ${snapshotId}, ${row.ticketId}, 1, ${employeeId}, 'Employee E1', 'Regular', 'regular', '2024-06-10', '8')
    `);
    await db.execute(sql`
      insert into field_ticket_signatures (org_id, field_ticket_id, role, signer_name, signature_file_id, signed_at)
      values (${row.orgId}, ${row.ticketId}, 'customer', 'Customer signer', ${row.fileId}, now())
    `);
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status, field_ticket_id)
      values (${row.orgId}, ${employeeId}, '2024-06-10', '8', 'approved', ${row.ticketId})
    `);

    const candidates = await listFieldTicketSourceCertificationCandidates({
      orgId: row.orgId,
      actorId: row.actorId,
    });
    const candidate = candidates.tickets.find((ticket) => ticket.nativeDocumentId === row.ticketId);
    assert.ok(candidate);
    assert.equal(candidate.certificationId, null);
    assert.equal(candidate.sourceExternalId, null);

    const before = await protectedFacts(row.orgId, row.ticketId);
    const result = await certifyFieldTicketSourceIdentity(
      certificationInput(row, candidate.revision),
    );
    assert.equal(result.replayed, false);
    assert.equal(result.sourceExternalId, "100");

    assert.deepEqual(await protectedFacts(row.orgId, row.ticketId), before);
    const stored = await db.execute<{
      source_system: string;
      source_external_id: string;
      native_document_number: string;
      native_fingerprint_sha256: string;
      native_point_in_time: Record<string, unknown>;
      source_row_sha256: string;
      reference_map: Record<string, unknown>;
    }>(
      sql`
      select source_system, source_external_id, native_document_number, native_fingerprint_sha256,
             native_point_in_time, source_row_sha256, reference_map
        from field_ticket_source_certifications where org_id = ${row.orgId}
    `,
      "objects",
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.source_system, "legacy-app");
    assert.equal(stored[0]!.native_document_number, "FT-9");
    assert.equal(
      nativePointInTimeFingerprint(stored[0]!.native_point_in_time),
      stored[0]!.native_fingerprint_sha256,
    );
    assert.equal(
      (stored[0]!.reference_map as { job: { nativeId: string } }).job.nativeId,
      row.projectId,
    );

    const document = (
      await db.execute<{
        custom: {
          retained: string;
          source: { system: string; externalId: string; jobRef: string };
        };
      }>(
        sql`
      select custom from documents where org_id = ${row.orgId} and id = ${row.ticketId}
    `,
        "objects",
      )
    )[0]!;
    assert.equal(document.custom.retained, "native context");
    assert.deepEqual(
      {
        system: document.custom.source.system,
        externalId: document.custom.source.externalId,
        jobRef: document.custom.source.jobRef,
      },
      { system: "legacy-app", externalId: "100", jobRef: "JOB-1" },
    );
    const audits = await db.execute<{ table_name: string; count: string }>(
      sql`
      select table_name, count(*)::text as count from audit_log
       where org_id = ${row.orgId} and table_name in ('documents', 'field_ticket_source_certifications')
       group by table_name order by table_name
    `,
      "objects",
    );
    assert.deepEqual(
      audits.map((audit) => [audit.table_name, Number(audit.count)]),
      [
        ["documents", 1],
        ["field_ticket_source_certifications", 1],
      ],
    );
    const documentAudit = (
      await db.execute<{
        changes: {
          before: { document: { id: string } };
          after: { document: { id: string; custom: { source: { externalId: string } } } };
        };
      }>(
        sql`
      select changes from audit_log
       where org_id = ${row.orgId} and table_name = 'documents'
         and changes->>'reason' = 'field_ticket_source_identity_certification'
    `,
        "objects",
      )
    )[0]!;
    assert.equal(documentAudit.changes.before.document.id, row.ticketId);
    assert.equal(documentAudit.changes.after.document.id, row.ticketId);
    assert.equal(documentAudit.changes.after.document.custom.source.externalId, "100");

    // A certified identity cannot be moved or removed by a direct marker write.
    await assert.rejects(
      db.execute(sql`update documents set custom = custom || '{"source":{"system":"other","externalId":"100"}}'::jsonb
        where org_id = ${row.orgId} and id = ${row.ticketId}`),
      (error: unknown) =>
        /source identity may be set only from its governed source-identity certification/.test(
          guardRefusalMessage(error, { includeRaisedCheckViolations: true }) ?? "",
        ),
    );
  } finally {
    await dropScratchOrg(row.orgId);
  }
});

test(
  "an exact request replay adds nothing, and a different actor or payload refuses",
  enabled,
  async () => {
    const row = await fixture("draft");
    try {
      const input = certificationInput(row, await revision(row.orgId, row.ticketId));
      const first = await certifyFieldTicketSourceIdentity(input);
      assert.equal(first.replayed, false);
      const revisionAfter = await revision(row.orgId, row.ticketId);

      const replay = await certifyFieldTicketSourceIdentity(input);
      assert.equal(replay.replayed, true);
      assert.equal(replay.id, first.id);
      assert.equal(await certificationCount(row.orgId), 1);
      assert.equal(await revision(row.orgId, row.ticketId), revisionAfter);

      const otherActor = await createScratchUser(
        row.orgId,
        "Other certifier",
        `other_certifier_${randomUUID()}`,
      );
      await grantScratchPermissions(row.orgId, otherActor, [
        "time.manage",
        "time.read",
        "documents.read",
      ]);
      await assert.rejects(
        certifyFieldTicketSourceIdentity({ ...input, actorId: otherActor }),
        /already preserves different evidence/,
      );
      await assert.rejects(
        certifyFieldTicketSourceIdentity({
          ...input,
          attestation: "A different attestation for the same request identity.",
        }),
        /already preserves different evidence/,
      );
      await assert.rejects(
        certifyFieldTicketSourceIdentity(
          certificationInput(row, revisionAfter, { sourceTicketId: "101" }),
        ),
        /already carries a governed source-identity certification/,
      );
      assert.equal(await certificationCount(row.orgId), 1);
    } finally {
      await dropScratchOrg(row.orgId);
    }
  },
);

test("an uppercase source-system identity is stored exactly as reviewed", enabled, async () => {
  const row = await fixture("draft");
  try {
    const result = await certifyFieldTicketSourceIdentity(
      certificationInput(row, await revision(row.orgId, row.ticketId), {
        sourceSystem: "Legacy-App",
      }),
    );
    assert.equal(result.sourceSystem, "Legacy-App");
    const stored = (
      await db.execute<{ source_system: string }>(
        sql`
      select source_system from field_ticket_source_certifications where org_id = ${row.orgId}
    `,
        "objects",
      )
    )[0]!;
    assert.equal(stored.source_system, "Legacy-App");
    const document = (
      await db.execute<{ system: string }>(
        sql`
      select custom->'source'->>'system' as system from documents where org_id = ${row.orgId} and id = ${row.ticketId}
    `,
        "objects",
      )
    )[0]!;
    assert.equal(document.system, "Legacy-App");
  } finally {
    await dropScratchOrg(row.orgId);
  }
});

test(
  "wrong file, hash, version and missing-row bindings refuse without certifying",
  enabled,
  async () => {
    const row = await fixture("draft");
    try {
      const current = await revision(row.orgId, row.ticketId);
      await assert.rejects(
        certifyFieldTicketSourceIdentity(
          certificationInput(row, current, { sourceFileSha256: "b".repeat(64) }),
        ),
        /no longer matches its reviewed hash/,
      );
      await assert.rejects(
        certifyFieldTicketSourceIdentity(
          certificationInput(row, current, { sourceVersionId: randomUUID() }),
        ),
        /pinned source file version is unavailable/,
      );
      await assert.rejects(
        certifyFieldTicketSourceIdentity(
          certificationInput(row, current, { sourceTicketId: "999" }),
        ),
        /not a row of the pinned retained source file/,
      );
      // A client-asserted row for a different native number cannot bind this ticket.
      const otherTicket = String(
        (
          await db.execute<{ id: string }>(
            sql`
      insert into documents (org_id, kind, document_number, party_id, project_id, subsidiary_id, document_date, currency, status, custom)
      values (${row.orgId}, 'field_ticket', 'FT-OTHER', ${row.customerId}, ${row.projectId},
              (select subsidiary_id from projects where org_id = ${row.orgId} and id = ${row.projectId}),
              '2024-06-16', 'CAD', 'draft', '{}'::jsonb)
      returning id
    `,
            "objects",
          )
        )[0]!.id,
      );
      await db.execute(sql`
      insert into field_tickets (document_id, org_id, period, period_start, period_end, foreman_party_id, superintendent_party_id)
      values (${otherTicket}, ${row.orgId}, 'weekly', '2024-06-10', '2024-06-16', ${row.foremanId}, ${row.superintendentId})
    `);
      await assert.rejects(
        certifyFieldTicketSourceIdentity(
          certificationInput(row, await revision(row.orgId, otherTicket), {
            nativeDocumentId: otherTicket,
          }),
        ),
        /does not match source ticket 100 number/,
      );
      assert.equal(await certificationCount(row.orgId), 0);
    } finally {
      await dropScratchOrg(row.orgId);
    }
  },
);

test(
  "partial and conflicting stored markers, stale revision, scope and feature refusals leave no certificate",
  enabled,
  async () => {
    const partial = await fixture("draft", { source: { system: "legacy-app" } });
    try {
      await assert.rejects(
        certifyFieldTicketSourceIdentity(
          certificationInput(partial, await revision(partial.orgId, partial.ticketId)),
        ),
        /partial source marker/,
      );
      assert.equal(await certificationCount(partial.orgId), 0);
    } finally {
      await dropScratchOrg(partial.orgId);
    }

    const conflict = await fixture("draft", {
      source: { system: "other-connector", externalId: "100" },
    });
    try {
      await assert.rejects(
        certifyFieldTicketSourceIdentity(
          certificationInput(conflict, await revision(conflict.orgId, conflict.ticketId)),
        ),
        /different source identity/,
      );
      assert.equal(await certificationCount(conflict.orgId), 0);
    } finally {
      await dropScratchOrg(conflict.orgId);
    }

    const row = await fixture("draft");
    try {
      await assert.rejects(
        certifyFieldTicketSourceIdentity(certificationInput(row, "999999")),
        /changed after it was reviewed/,
      );
      const current = await revision(row.orgId, row.ticketId);
      await assert.rejects(
        certifyFieldTicketSourceIdentity(
          certificationInput(row, current, {
            explicitReferenceMap: {
              jobRef: "JOB-1",
              customerRef: "C1",
              foremanRef: "F1",
              superintendentRef: "S1",
              projectId: randomUUID(),
              customerPartyId: row.customerId,
              foremanPartyId: row.foremanId,
              superintendentPartyId: row.superintendentId,
            },
          }),
        ),
        /does not resolve through the native project map/,
      );
      await db.execute(sql`update field_tickets set foreman_party_id = ${row.superintendentId}
      where org_id = ${row.orgId} and document_id = ${row.ticketId}`);
      await assert.rejects(
        certifyFieldTicketSourceIdentity(
          certificationInput(row, await revision(row.orgId, row.ticketId)),
        ),
        /foreman does not match/,
      );
      await db.execute(sql`update field_tickets set foreman_party_id = ${row.foremanId}
      where org_id = ${row.orgId} and document_id = ${row.ticketId}`);

      const unauthorized = await createScratchUser(
        row.orgId,
        "No ticket duty",
        `no_duty_${randomUUID()}`,
      );
      await grantScratchPermissions(row.orgId, unauthorized, ["documents.read"]);
      await assert.rejects(
        certifyFieldTicketSourceIdentity(
          certificationInput(row, await revision(row.orgId, row.ticketId), {
            actorId: unauthorized,
          }),
        ),
        /not found/,
      );

      await db.execute(
        sql`update orgs set settings = jsonb_set(settings, '{features}', '{"projects":true,"fieldTickets":false}'::jsonb) where id = ${row.orgId}`,
      );
      await assert.rejects(
        certifyFieldTicketSourceIdentity(
          certificationInput(row, await revision(row.orgId, row.ticketId)),
        ),
        /Company Settings/,
      );
      assert.equal(await certificationCount(row.orgId), 0);
    } finally {
      await dropScratchOrg(row.orgId);
    }
  },
);

test(
  "one request identity raced across different tickets admits exactly one certification",
  enabled,
  async () => {
    const row = await fixture("draft");
    try {
      const otherTicket = String(
        (
          await db.execute<{ id: string }>(
            sql`
      insert into documents (org_id, kind, document_number, party_id, project_id, subsidiary_id, document_date, currency, status, custom)
      values (${row.orgId}, 'field_ticket', 'FT-101', ${row.customerId}, ${row.projectId},
              (select subsidiary_id from projects where org_id = ${row.orgId} and id = ${row.projectId}),
              '2024-06-23', 'CAD', 'draft', '{}'::jsonb)
      returning id
    `,
            "objects",
          )
        )[0]!.id,
      );
      await db.execute(sql`
      insert into field_tickets (document_id, org_id, period, period_start, period_end, foreman_party_id, superintendent_party_id)
      values (${otherTicket}, ${row.orgId}, 'weekly', '2024-06-17', '2024-06-23', ${row.foremanId}, ${row.superintendentId})
    `);
      const requestId = randomUUID();
      const results = await Promise.allSettled([
        certifyFieldTicketSourceIdentity(
          certificationInput(row, await revision(row.orgId, row.ticketId), { requestId }),
        ),
        certifyFieldTicketSourceIdentity(
          certificationInput(row, await revision(row.orgId, otherTicket), {
            requestId,
            nativeDocumentId: otherTicket,
            sourceTicketId: "101",
          }),
        ),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      const rejected = results.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      assert.match(
        String(rejected.reason?.message ?? rejected.reason),
        /already preserves different evidence|changed after it was reviewed/,
      );
      assert.equal(await certificationCount(row.orgId), 1);
    } finally {
      await dropScratchOrg(row.orgId);
    }
  },
);

test(
  "a source ticket already represented by another source-born ticket cannot be certified to this ticket",
  enabled,
  async () => {
    const row = await fixture("draft");
    try {
      const otherTicket = String(
        (
          await db.execute<{ id: string }>(
            sql`
      insert into documents (org_id, kind, document_number, party_id, project_id, subsidiary_id, document_date, currency, status, custom)
      values (${row.orgId}, 'field_ticket', 'FT-OTHER', ${row.customerId}, ${row.projectId},
              (select subsidiary_id from projects where org_id = ${row.orgId} and id = ${row.projectId}),
              '2024-06-16', 'CAD', 'draft',
              ${JSON.stringify({ source: { system: "legacy-app", externalId: "100", number: "FT-OTHER" } })}::jsonb)
      returning id
    `,
            "objects",
          )
        )[0]!.id,
      );
      await db.execute(sql`
      insert into field_tickets (document_id, org_id, period, period_start, period_end, foreman_party_id, superintendent_party_id)
      values (${otherTicket}, ${row.orgId}, 'weekly', '2024-06-10', '2024-06-16', ${row.foremanId}, ${row.superintendentId})
    `);
      const refusal = await certifyFieldTicketSourceIdentity(
        certificationInput(row, await revision(row.orgId, row.ticketId)),
      ).then(
        () => null,
        (error: Error) => error,
      );
      assert.ok(refusal);
      assert.match(refusal.message, /already represented by another native Field Ticket/);
      assert.equal(
        refusal.message.includes(otherTicket),
        false,
        "the collision remedy discloses no other record",
      );
      assert.equal(await certificationCount(row.orgId), 0);
      const selected = (
        await db.execute<{ custom: unknown }>(
          sql`
      select custom from documents where org_id = ${row.orgId} and id = ${row.ticketId}
    `,
          "objects",
        )
      )[0]!;
      assert.deepEqual(selected.custom, { retained: "native context" });
    } finally {
      await dropScratchOrg(row.orgId);
    }
  },
);

test("concurrent certifiers admit exactly one identity for one ticket", enabled, async () => {
  const row = await fixture("draft");
  try {
    const current = await revision(row.orgId, row.ticketId);
    const results = await Promise.allSettled([
      certifyFieldTicketSourceIdentity(certificationInput(row, current)),
      certifyFieldTicketSourceIdentity(certificationInput(row, current)),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(await certificationCount(row.orgId), 1);
  } finally {
    await dropScratchOrg(row.orgId);
  }
});
