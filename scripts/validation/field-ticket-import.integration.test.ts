import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { certifyFieldTicketSourceIdentity } from "@openbooks/engine/projects/field-ticket-source-certification";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  createScratchUser,
  grantScratchPermissions,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";
import { importFieldTickets, type ImportBillableCharge } from "./field-ticket-import.ts";
import type { FieldTicketSourceHeaderRow } from "@openbooks/engine/projects/field-ticket-source-headers";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const ticket = (
  overrides: Partial<FieldTicketSourceHeaderRow> = {},
): FieldTicketSourceHeaderRow => ({
  sourceId: "9",
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
  ...overrides,
});

async function project(orgId: string, nsId: string): Promise<string> {
  return String(
    (
      await db.execute<{ id: string }>(
        sql`
        insert into projects (org_id, subsidiary_id, name, custom)
        select ${orgId}, id, ${nsId}, ${JSON.stringify({ nsId })}::jsonb from subsidiaries where org_id = ${orgId} order by id limit 1
        returning id
      `,
        "objects",
      )
    )[0]!.id,
  );
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

async function actor(
  orgId: string,
  permissions = ["time.manage", "time.read", "ar.create"],
): Promise<string> {
  const id = await createScratchUser(orgId, "Source importer", `source_import_${randomUUID()}`);
  await grantScratchPermissions(orgId, id, permissions);
  const customer = (
    await db.execute<{ id: string }>(
      sql`select id from parties where org_id=${orgId} and kind='customer' order by id limit 1`,
      "objects",
    )
  )[0];
  assert.ok(customer, "the source importer fixture requires its native customer");
  const role = (
    await db.execute(
      sql`select party_id from customer_roles where org_id=${orgId} and party_id=${customer.id}`,
      "objects",
    )
  )[0];
  if (!role)
    assert.equal(
      (
        await db.execute<never>(
          sql`insert into customer_roles(org_id,party_id) values(${orgId},${customer.id})`,
        )
      ).rowCount,
      1,
    );
  assert.equal(
    (
      await db.execute<never>(
        sql`update parties set custom=custom || '{"nsId":"C1"}'::jsonb where org_id=${orgId} and id=${customer.id}`,
      )
    ).rowCount,
    1,
  );
  await db.execute(
    sql`update orgs set settings = jsonb_set(settings, '{features}', '{"projects":true,"fieldTickets":true,"orders":true}'::jsonb) where id = ${orgId}`,
  );
  return id;
}

async function sourceRoles(
  orgId: string,
): Promise<{ foremanId: string; superintendentId: string }> {
  return {
    foremanId: await party(orgId, "F1"),
    superintendentId: await party(orgId, "S1"),
  };
}

async function existingDocument(
  orgId: string,
  projectId: string,
  currency: string,
  marker: unknown,
  periodStart: string,
): Promise<string> {
  const docId = String(
    (
      await db.execute<{ id: string }>(
        sql`
        insert into documents (org_id, kind, document_number, project_id, subsidiary_id, document_date, currency, status, custom)
        select ${orgId}, 'field_ticket', 'FT-9', ${projectId}, subsidiary_id, '2024-06-16', ${currency}, 'approved', ${JSON.stringify(marker)}::jsonb
          from projects where org_id = ${orgId} and id = ${projectId}
        returning id
      `,
        "objects",
      )
    )[0]!.id,
  );
  await db.execute(sql`
    insert into field_tickets (document_id, org_id, period, period_start, period_end)
    values (${docId}, ${orgId}, 'weekly', ${periodStart}, '2024-06-16')
  `);
  return docId;
}

async function counts(orgId: string): Promise<{ tickets: number; headers: number }> {
  const row = (
    await db.execute<{ tickets: string; headers: string }>(
      sql`
      select (select count(*) from documents where org_id = ${orgId} and kind = 'field_ticket')::text tickets,
             (select count(*) from field_tickets where org_id = ${orgId})::text headers
    `,
      "objects",
    )
  )[0]!;
  return { tickets: Number(row.tickets), headers: Number(row.headers) };
}

async function currency(orgId: string): Promise<string> {
  return String(
    (
      await db.execute<{ base_currency: string }>(
        sql`select base_currency from orgs where id = ${orgId}`,
        "objects",
      )
    )[0]!.base_currency,
  );
}

test(
  "a same-number ticket from another source refuses and leaves the old document untouched",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const projectId = await project(org.orgId, "JOB-1");
      await sourceRoles(org.orgId);
      const actorId = await actor(org.orgId);
      const docId = await existingDocument(
        org.orgId,
        projectId,
        await currency(org.orgId),
        { source: { system: "other-connector", externalId: "99", number: "FT-9" } },
        "2024-01-01",
      );
      await assert.rejects(
        () =>
          importFieldTickets({
            orgId: org.orgId,
            sourceSystem: "test-source",
            tickets: [ticket()],
            apply: true,
            actorId,
          }),
        /field ticket number FT-9 already exists from a different source \(system other-connector, external id 99\)/,
      );
      assert.deepEqual(await counts(org.orgId), { tickets: 1, headers: 1 });
      const doc = (
        await db.execute<{ custom: unknown }>(
          sql`select custom from documents where id = ${docId}`,
          "objects",
        )
      )[0]!.custom as { source: { system: string } };
      assert.equal(doc.source.system, "other-connector");
      const header = (
        await db.execute<{ period_start: string }>(
          sql`select period_start::text from field_tickets where document_id = ${docId}`,
          "objects",
        )
      )[0]!;
      assert.match(header.period_start, /2024-01-01/);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "matching native work facts and employee source evidence cannot adopt an unsourced ticket; the whole import rolls back",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const projectId = await project(org.orgId, "JOB-1");
      const roles = await sourceRoles(org.orgId);
      const actorId = await actor(org.orgId);
      const employeeId = await party(org.orgId, "E1");
      await db.execute(
        sql`insert into employee_roles (org_id, party_id) values (${org.orgId}, ${employeeId})`,
      );
      const baseCurrency = await currency(org.orgId);
      const docId = await existingDocument(
        org.orgId,
        projectId,
        baseCurrency,
        { retained: "native context" },
        "2024-06-10",
      );
      await db.execute(sql`
      update documents set party_id = (select party_id from customer_roles where org_id = ${org.orgId} order by party_id limit 1),
                           subtotal = '0', tax_total = '0', total = '0'
       where org_id = ${org.orgId} and id = ${docId}
    `);
      await db.execute(sql`
      update field_tickets set foreman_party_id = ${roles.foremanId}, superintendent_party_id = ${roles.superintendentId}
       where org_id = ${org.orgId} and document_id = ${docId}
    `);
      const snapshotId = String(
        (
          await db.execute<{ id: string }>(
            sql`
      insert into field_ticket_labor_snapshots (org_id, field_ticket_id, revision, evidence_basis, reason, source_system, source_payload_hash, currency, captured_by)
      values (${org.orgId}, ${docId}, 1, 'source_import', 'Imported employee evidence', 'test-source', ${"a".repeat(64)}, ${baseCurrency}, ${actorId}) returning id
    `,
            "objects",
          )
        )[0]!.id,
      );
      await db.execute(sql`
      insert into field_ticket_labor_lines
        (org_id, snapshot_id, field_ticket_id, sequence, employee_party_id, employee_name, time_type_name,
         time_classification, worked_on, hours, source_system, source_line_ref, source_payload_hash, created_by)
      values (${org.orgId}, ${snapshotId}, ${docId}, 1, ${employeeId}, 'Employee E1', 'Regular',
              'regular', '2024-06-10', '1', 'test-source', 'employee:E1', ${"a".repeat(64)}, ${actorId})
    `);
      const beforeDocument = (
        await db.execute(
          sql`
      select custom, updated_at::text, party_id::text, project_id::text, subsidiary_id::text, status,
             subtotal::text, tax_total::text, total::text
        from documents where org_id = ${org.orgId} and id = ${docId}
    `,
          "objects",
        )
      )[0]!;
      const beforeHeader = (
        await db.execute(
          sql`
      select period_start::text, period_end::text, foreman_party_id::text, superintendent_party_id::text, updated_at::text
        from field_tickets where org_id = ${org.orgId} and document_id = ${docId}
    `,
          "objects",
        )
      )[0]!;
      const beforeAudit = (
        await db.execute<{ count: string }>(
          sql`
      select count(*)::text count from audit_log where org_id = ${org.orgId}
    `,
          "objects",
        )
      )[0]!.count;

      const sourceProof = { headersSha256: "a".repeat(64), chargesSha256: "b".repeat(64) };
      const planned = await importFieldTickets({
        orgId: org.orgId,
        sourceSystem: "test-source",
        actorId,
        apply: false,
        sourceProof,
        tickets: [ticket()],
        charges: [],
      });
      assert.equal(planned.identityPlan![0]!.action, "admission_held");
      assert.equal(planned.identityPlan![0]!.adoptionPerformed, false);
      assert.match(
        planned.identityPlan![0]!.reasons.join(","),
        /native_ticket_source_lineage_missing/,
      );
      await assert.rejects(
        () =>
          importFieldTickets({
            orgId: org.orgId,
            sourceSystem: "test-source",
            actorId,
            apply: true,
            sourceProof,
            tickets: [ticket({ sourceId: "8", number: "FT-8" }), ticket()],
          }),
        /field ticket number FT-9 already exists from a different source \(system unknown, external id unknown\)/,
      );

      assert.deepEqual(await counts(org.orgId), { tickets: 1, headers: 1 });
      assert.deepEqual(
        (
          await db.execute(
            sql`
      select custom, updated_at::text, party_id::text, project_id::text, subsidiary_id::text, status,
             subtotal::text, tax_total::text, total::text
        from documents where org_id = ${org.orgId} and id = ${docId}
    `,
            "objects",
          )
        )[0],
        beforeDocument,
      );
      assert.deepEqual(
        (
          await db.execute(
            sql`
      select period_start::text, period_end::text, foreman_party_id::text, superintendent_party_id::text, updated_at::text
        from field_tickets where org_id = ${org.orgId} and document_id = ${docId}
    `,
            "objects",
          )
        )[0],
        beforeHeader,
      );
      assert.equal(
        (
          await db.execute<{ count: string }>(
            sql`
      select count(*)::text count from audit_log where org_id = ${org.orgId}
    `,
            "objects",
          )
        )[0]!.count,
        beforeAudit,
      );
      assert.equal(
        (
          await db.execute<{ count: string }>(
            sql`
      select count(*)::text count from field_ticket_labor_lines
       where org_id = ${org.orgId} and field_ticket_id = ${docId} and source_line_ref = 'employee:E1'
    `,
            "objects",
          )
        )[0]!.count,
        "1",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("an exact replay is still idempotent", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const projectId = await project(org.orgId, "JOB-1");
    const roles = await sourceRoles(org.orgId);
    const actorId = await actor(org.orgId);
    await existingDocument(
      org.orgId,
      projectId,
      await currency(org.orgId),
      { source: { system: "test-source", externalId: "9", number: "FT-9" } },
      "2024-06-10",
    );
    const first = await importFieldTickets({
      orgId: org.orgId,
      sourceSystem: "test-source",
      tickets: [ticket()],
      apply: true,
      actorId,
    });
    assert.deepEqual(
      { created: first.created, existing: first.existing },
      { created: 0, existing: 1 },
    );
    assert.equal(first.nativeUpdated, 1);
    assert.deepEqual(await counts(org.orgId), { tickets: 1, headers: 1 });
    const header = (
      await db.execute<{
        foreman_party_id: string | null;
        superintendent_party_id: string | null;
      }>(
        sql`
      select foreman_party_id, superintendent_party_id from field_tickets
       where org_id = ${org.orgId}
    `,
        "objects",
      )
    )[0]!;
    assert.equal(header.foreman_party_id, roles.foremanId);
    assert.equal(header.superintendent_party_id, roles.superintendentId);
    const second = await importFieldTickets({
      orgId: org.orgId,
      sourceSystem: "test-source",
      tickets: [ticket()],
      apply: true,
      actorId,
    });
    assert.equal(second.nativeUpdated, 0);
    const legacyReplay = await importFieldTickets({
      orgId: org.orgId,
      sourceSystem: "test-source",
      tickets: [ticket({ superintendentRef: undefined })],
      apply: true,
      actorId,
    });
    assert.equal(legacyReplay.nativeUpdated, 0);
    const preserved = (
      await db.execute<{ superintendent_party_id: string | null }>(
        sql`
      select superintendent_party_id from field_tickets where org_id = ${org.orgId}
    `,
        "objects",
      )
    )[0]!;
    assert.equal(preserved.superintendent_party_id, roles.superintendentId);
    const audit = (
      await db.execute<{ count: string }>(
        sql`
      select count(*)::text count from audit_log
       where org_id = ${org.orgId} and table_name = 'field_tickets'
    `,
        "objects",
      )
    )[0]!;
    assert.equal(Number(audit.count), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("one unmapped job refuses the whole import with zero writes", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await project(org.orgId, "JOB-1");
    await sourceRoles(org.orgId);
    const actorId = await actor(org.orgId);
    const before = await counts(org.orgId);
    await assert.rejects(
      () =>
        importFieldTickets({
          orgId: org.orgId,
          sourceSystem: "test-source",
          tickets: [ticket(), ticket({ sourceId: "10", number: "FT-10", jobRef: "JOB-9" })],
          apply: true,
          actorId,
        }),
      /unresolved project or role references: source ticket 10 \(number FT-10, job JOB-9\)/,
    );
    assert.deepEqual(await counts(org.orgId), before);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "a hostile org id refuses named at the boundary, before any query",
  { skip: !DB },
  async () => {
    // The target reaches SQL in every query below, so a quote must die here
    // with its remedy — never as a driver syntax error, and never inside a
    // statement. (The bound-parameter sink itself is proven by the wire-format
    // unit test, which fails against the old sql.raw spelling.)
    await assert.rejects(
      () =>
        importFieldTickets({
          orgId: `x' OR '1'='1`,
          sourceSystem: "test-source",
          tickets: [ticket()],
          apply: false,
        }),
      /--org must be a UUID/,
    );
  },
);

test("one tenant's mappings stay invisible to another tenant's import", { skip: !DB }, async () => {
  const victim = await createScratchOrg();
  const probe = await createScratchOrg();
  try {
    await project(victim.orgId, "JOB-1");
    await project(probe.orgId, "PROBE-JOB");
    const plan = await importFieldTickets({
      orgId: probe.orgId,
      actorId: await actor(probe.orgId, ["time.read"]),
      sourceSystem: "test-source",
      tickets: [ticket()],
      apply: false,
    });
    assert.deepEqual(
      plan.unmapped.map((row) => row.jobRef),
      ["JOB-1"],
    );
  } finally {
    await dropScratchOrg(victim.orgId);
    await dropScratchOrg(probe.orgId);
  }
});

const billableCharge = (overrides: Partial<ImportBillableCharge> = {}): ImportBillableCharge => ({
  sourceId: "100",
  ticketRef: "9",
  jobRef: "1",
  itemRef: "2461",
  sourceDocumentRef: null,
  amount: "95.0000",
  quantity: "1.00000000",
  unitPrice: "95.00000000",
  occurredOn: "2024-06-12",
  ...overrides,
});

async function chargeFixture() {
  const org = await createScratchOrg();
  const actorId = await actor(org.orgId);
  const projectId = await project(org.orgId, "1");
  await sourceRoles(org.orgId);
  await db.execute(
    sql`update items set custom = custom || '{"nsId":"2461"}'::jsonb where org_id = ${org.orgId} and id = ${org.items.service}`,
  );
  const input = {
    orgId: org.orgId,
    actorId,
    sourceSystem: "test-source",
    apply: true,
    tickets: [ticket({ jobRef: "1", approval: "No" })],
    charges: [billableCharge()],
  };
  return { org, actorId, projectId, input };
}

test(
  "charges-only concurrent retries preserve one exact native source line",
  { skip: !DB },
  async () => {
    const { org, input } = await chargeFixture();
    try {
      await importFieldTickets({ ...input, charges: [] });
      const [first, second] = await Promise.all([
        importFieldTickets({ ...input, tickets: [] }),
        importFieldTickets({ ...input, tickets: [] }),
      ]);
      assert.equal(first.billableChargesCreated + second.billableChargesCreated, 1);
      assert.equal(first.billableChargesUnchanged + second.billableChargesUnchanged, 1);
      const rows = await db.execute<{ amount: string; source_system: string }>(
        sql`
      select amount::text, custom->>'sourceSystem' source_system from document_lines
       where org_id = ${org.orgId} and custom->>'sourceLineRef' = 'billable_transaction:100'
    `,
        "objects",
      );
      assert.deepEqual(rows, [{ amount: "95.0000", source_system: "test-source" }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "approved source charges replay exactly and refuse financial correction without changing history",
  { skip: !DB },
  async () => {
    const { org, input } = await chargeFixture();
    try {
      await importFieldTickets({ ...input, tickets: [ticket({ jobRef: "1" })] });
      assert.equal(
        (await importFieldTickets({ ...input, tickets: [] })).billableChargesUnchanged,
        1,
      );
      await assert.rejects(
        () =>
          importFieldTickets({
            ...input,
            tickets: [],
            charges: [billableCharge({ amount: "96" })],
          }),
        /approved ticket/,
      );
      const value = await db.execute<{ total: string; amount: string }>(
        sql`
      select d.total::text, l.amount::text from documents d join document_lines l on l.org_id = d.org_id and l.document_id = d.id
       where d.org_id = ${org.orgId} and d.kind = 'field_ticket'
    `,
        "objects",
      );
      assert.deepEqual(value, [{ total: "95.0000", amount: "95.0000" }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "source-system charge identities are independent across connectors",
  { skip: !DB },
  async () => {
    const { org, input } = await chargeFixture();
    try {
      await importFieldTickets(input);
      await importFieldTickets({
        ...input,
        sourceSystem: "other-source",
        tickets: [ticket({ jobRef: "1", number: "FT-OTHER", approval: "No" })],
      });
      const rows = await db.execute<{ source_system: string }>(
        sql`
      select custom->>'sourceSystem' source_system from document_lines
       where org_id = ${org.orgId} and custom->>'sourceLineRef' = 'billable_transaction:100' order by 1
    `,
        "objects",
      );
      assert.deepEqual(
        rows.map((row) => row.source_system),
        ["other-source", "test-source"],
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("an organization user without native ticket duty cannot import", { skip: !DB }, async () => {
  const { org, input } = await chargeFixture();
  try {
    const unauthorized = await actor(org.orgId, []);
    await assert.rejects(
      () => importFieldTickets({ ...input, actorId: unauthorized }),
      /not found/,
    );
    assert.deepEqual(await counts(org.orgId), { tickets: 0, headers: 0 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "native order links retain exact source identity and audit the successful write",
  { skip: !DB },
  async () => {
    const { org, input, projectId } = await chargeFixture();
    try {
      const order = (
        await db.execute<{ id: string }>(
          sql`
      insert into documents (org_id, subsidiary_id, kind, document_number, project_id, document_date, currency, status, custom)
      values (${org.orgId}, ${org.subsidiaryId}, 'sales_order', 'SO-SOURCE', ${projectId}, '2024-06-12', 'CAD', 'draft', '{"nsId":"500"}'::jsonb) returning id
    `,
          "objects",
        )
      )[0]!.id;
      const line = (
        await db.execute<{ id: string }>(
          sql`
      insert into document_lines (org_id, document_id, line_number, item_id, project_id, amount, quantity, unit_price, tax_amount, work_from)
      values (${org.orgId}, ${order}, 1, ${org.items.service}, ${projectId}, '95', '1', '95', '0', '2024-06-12') returning id
    `,
          "objects",
        )
      )[0]!.id;
      const linked = await importFieldTickets({
        ...input,
        charges: [billableCharge({ sourceDocumentRef: "500" })],
      });
      assert.equal(linked.salesOrderLinesLinked, 1);
      const stored = await db.execute<{ ticket_id: string; audit_ticket_id: string }>(
        sql`
      select l.field_ticket_id::text ticket_id, a.changes->'after'->>'fieldTicketId' audit_ticket_id
        from document_lines l join audit_log a on a.org_id = l.org_id and a.row_id = l.id
       where l.org_id = ${org.orgId} and l.id = ${line}
         and a.changes->>'reason' = 'source_billable_timesheet_ticket_link'
    `,
        "objects",
      );
      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.ticket_id, stored[0]!.audit_ticket_id);
      assert.equal(
        (
          await importFieldTickets({
            ...input,
            tickets: [],
            charges: [billableCharge({ sourceDocumentRef: "500" })],
          })
        ).salesOrderLinesLinked,
        0,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "billable occurrence outside the native ticket work period refuses atomically",
  { skip: !DB },
  async () => {
    const { org, input } = await chargeFixture();
    try {
      await assert.rejects(
        () =>
          importFieldTickets({ ...input, charges: [billableCharge({ occurredOn: "2024-06-17" })] }),
        /outside native ticket/,
      );
      assert.deepEqual(await counts(org.orgId), { tickets: 0, headers: 0 });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a supplied unmapped customer cannot silently become a ticket without a customer",
  { skip: !DB },
  async () => {
    const { org, input } = await chargeFixture();
    try {
      await assert.rejects(
        () =>
          importFieldTickets({
            ...input,
            tickets: [ticket({ jobRef: "1", customerRef: "UNKNOWN" })],
          }),
        /unmapped customer UNKNOWN/,
      );
      assert.deepEqual(await counts(org.orgId), { tickets: 0, headers: 0 });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "ticket import and planning refuse a native project outside the actor's entity scope",
  { skip: !DB },
  async () => {
    const { org, input, actorId } = await chargeFixture();
    try {
      await db.execute(sql`update app_roles set subsidiary_restriction = '{"mode":"list","subsidiaryIds":[]}'::jsonb
      where org_id = ${org.orgId} and id in (select role_id from role_assignments where org_id = ${org.orgId} and user_id = ${actorId})`);
      for (const apply of [false, true])
        await assert.rejects(() => importFieldTickets({ ...input, apply }), /not found/);
      assert.deepEqual(await counts(org.orgId), { tickets: 0, headers: 0 });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a certified draft ticket admits its missing source charges only through the governed importer",
  { skip: !DB },
  async () => {
    const { org, input, actorId } = await chargeFixture();
    try {
      await grantScratchPermissions(org.orgId, actorId, ["documents.read"]);
      const projectRow = (
        await db.execute<{ subsidiary_id: string }>(
          sql`
      select subsidiary_id::text from projects where org_id = ${org.orgId} and custom->>'nsId' = '1'
    `,
          "objects",
        )
      )[0]!;
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
      const roles = (
        await db.execute<{ foreman: string; superintendent: string }>(
          sql`
      select (select id::text from parties where org_id = ${org.orgId} and custom->>'nsId' = 'F1') foreman,
             (select id::text from parties where org_id = ${org.orgId} and custom->>'nsId' = 'S1') superintendent
    `,
          "objects",
        )
      )[0]!;
      const ticketId = String(
        (
          await db.execute<{ id: string }>(
            sql`
      insert into documents (org_id, kind, document_number, party_id, project_id, subsidiary_id, document_date, currency, status, custom)
      values (${org.orgId}, 'field_ticket', 'FT-9', ${customerId},
              (select id from projects where org_id = ${org.orgId} and custom->>'nsId' = '1'),
              ${projectRow.subsidiary_id}, '2024-06-16', 'CAD', 'draft', '{}'::jsonb)
      returning id
    `,
            "objects",
          )
        )[0]!.id,
      );
      await db.execute(sql`
      insert into field_tickets (document_id, org_id, period, period_start, period_end, foreman_party_id, superintendent_party_id)
      values (${ticketId}, ${org.orgId}, 'weekly', '2024-06-10', '2024-06-16', ${roles.foreman}, ${roles.superintendent})
    `);
      const sourceBytes = Buffer.from(
        [
          [
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
          ].join("\t"),
          [
            "9",
            "FT-9",
            "1",
            "E1",
            "C1",
            "2024-06-10",
            "2024-06-16",
            "No",
            "Yes",
            "No",
            "F1",
            "S1",
            "NULL",
            "Week nine",
          ].join("\t"),
        ].join("\n") + "\n",
        "utf8",
      );
      const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
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
      values (${org.orgId}, ${folderId}, 'field-ticket-headers.tsv', 'text/tab-separated-values', ${sourceBytes.length}, 'db', ${sourceSha256}, ${actorId})
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
      values (${fileId}, 1, ${sourceBytes.length}, 'text/tab-separated-values', 'db', ${sourceSha256}, ${actorId})
      returning id
    `,
            "objects",
          )
        )[0]!.id,
      );
      await db.execute(
        sql`insert into file_blobs (version_id, bytes) values (${versionId}, ${sourceBytes})`,
      );
      await db.execute(
        sql`update files set current_version_id = ${versionId} where org_id = ${org.orgId} and id = ${fileId}`,
      );

      const revision = String(
        (
          await db.execute<{ revision: string }>(
            sql`
      select revision_seq::text revision from documents where org_id = ${org.orgId} and id = ${ticketId}
    `,
            "objects",
          )
        )[0]!.revision,
      );
      const projectId = String(
        (
          await db.execute<{ id: string }>(
            sql`
      select id::text from projects where org_id = ${org.orgId} and custom->>'nsId' = '1'
    `,
            "objects",
          )
        )[0]!.id,
      );
      const certification = {
        orgId: org.orgId,
        actorId,
        requestId: randomUUID(),
        nativeDocumentId: ticketId,
        expectedNativeRevision: revision,
        sourceSystem: "test-source",
        sourceTicketId: "9",
        sourceFileId: fileId,
        sourceVersionId: versionId,
        sourceFileSha256: sourceSha256,
        attestation:
          "I reviewed the retained source export against this native ticket and attest this crosswalk.",
        reason: "The native ticket has no source identity and this is its reviewed source ticket.",
        explicitReferenceMap: {
          jobRef: "1",
          customerRef: "C1",
          foremanRef: "F1",
          superintendentRef: "S1",
          projectId,
          customerPartyId: customerId,
          foremanPartyId: roles.foreman,
          superintendentPartyId: roles.superintendent,
        },
      };

      // Certification and a charges-only import may race: certification
      // admits exactly one identity, the early import can only refuse or
      // replay, and the governed import afterwards creates the charge once.
      const raced = await Promise.allSettled([
        certifyFieldTicketSourceIdentity(certification),
        importFieldTickets({ ...input, tickets: [] }),
      ]);
      assert.equal(raced[0]!.status, "fulfilled");
      const admitted = await importFieldTickets({
        ...input,
        tickets: [ticket({ jobRef: "1", approval: "No" })],
      });
      const racingImport = raced[1]!;
      if (racingImport.status === "rejected")
        assert.match(
          String(racingImport.reason),
          /native_ticket_source_lineage_missing|source ticket 9, which is not present in this import or native tenant/,
        );
      assert.equal(
        admitted.billableChargesCreated +
          (racingImport.status === "fulfilled" ? racingImport.value.billableChargesCreated : 0),
        1,
        "certification and import admit the source charge exactly once across either lock order",
      );
      assert.equal(admitted.nativeUpdated, 0);
      const replay = await importFieldTickets({
        ...input,
        tickets: [],
        charges: [billableCharge()],
      });
      assert.equal(replay.billableChargesUnchanged, 1);
      const stored = (
        await db.execute<{ total: string; charges: string }>(
          sql`
      select d.total::text total,
             (select count(*)::text from document_lines where org_id = ${org.orgId} and document_id = d.id) charges
        from documents d where org_id = ${org.orgId} and d.id = ${ticketId}
    `,
          "objects",
        )
      )[0]!;
      assert.deepEqual(stored, { total: "95.0000", charges: "1" });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "certifier and importer admit exactly one native representation of one source ticket",
  { skip: !DB },
  async () => {
    const { org, actorId } = await chargeFixture();
    try {
      await grantScratchPermissions(org.orgId, actorId, ["documents.read"]);
      const projectRow = (
        await db.execute<{ id: string; subsidiary_id: string }>(
          sql`
      select id::text, subsidiary_id::text from projects where org_id = ${org.orgId} and custom->>'nsId' = '1'
    `,
          "objects",
        )
      )[0]!;
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
      const roles = (
        await db.execute<{ foreman: string; superintendent: string }>(
          sql`
      select (select id::text from parties where org_id = ${org.orgId} and custom->>'nsId' = 'F1') foreman,
             (select id::text from parties where org_id = ${org.orgId} and custom->>'nsId' = 'S1') superintendent
    `,
          "objects",
        )
      )[0]!;
      const ticketId = String(
        (
          await db.execute<{ id: string }>(
            sql`
      insert into documents (org_id, kind, document_number, party_id, project_id, subsidiary_id, document_date, currency, status, custom)
      values (${org.orgId}, 'field_ticket', 'FT-9', ${customerId}, ${projectRow.id}, ${projectRow.subsidiary_id}, '2024-06-16', 'CAD', 'draft', '{}'::jsonb)
      returning id
    `,
            "objects",
          )
        )[0]!.id,
      );
      await db.execute(sql`
      insert into field_tickets (document_id, org_id, period, period_start, period_end, foreman_party_id, superintendent_party_id)
      values (${ticketId}, ${org.orgId}, 'weekly', '2024-06-10', '2024-06-16', ${roles.foreman}, ${roles.superintendent})
    `);
      const sourceBytes = Buffer.from(
        [
          [
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
          ].join("\t"),
          [
            "9",
            "FT-9",
            "1",
            "E1",
            "C1",
            "2024-06-10",
            "2024-06-16",
            "No",
            "Yes",
            "No",
            "F1",
            "S1",
            "NULL",
            "Week nine",
          ].join("\t"),
        ].join("\n") + "\n",
        "utf8",
      );
      const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
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
      values (${org.orgId}, ${folderId}, 'field-ticket-headers.tsv', 'text/tab-separated-values', ${sourceBytes.length}, 'db', ${sourceSha256}, ${actorId})
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
      values (${fileId}, 1, ${sourceBytes.length}, 'text/tab-separated-values', 'db', ${sourceSha256}, ${actorId})
      returning id
    `,
            "objects",
          )
        )[0]!.id,
      );
      await db.execute(
        sql`insert into file_blobs (version_id, bytes) values (${versionId}, ${sourceBytes})`,
      );
      await db.execute(
        sql`update files set current_version_id = ${versionId} where org_id = ${org.orgId} and id = ${fileId}`,
      );
      const revision = String(
        (
          await db.execute<{ revision: string }>(
            sql`
      select revision_seq::text revision from documents where org_id = ${org.orgId} and id = ${ticketId}
    `,
            "objects",
          )
        )[0]!.revision,
      );

      const raced = await Promise.allSettled([
        certifyFieldTicketSourceIdentity({
          orgId: org.orgId,
          actorId,
          requestId: randomUUID(),
          nativeDocumentId: ticketId,
          expectedNativeRevision: revision,
          sourceSystem: "test-source",
          sourceTicketId: "9",
          sourceFileId: fileId,
          sourceVersionId: versionId,
          sourceFileSha256: sourceSha256,
          attestation:
            "I reviewed the retained source export against this native ticket and attest this crosswalk.",
          reason:
            "The native ticket has no source identity and this is its reviewed source ticket.",
          explicitReferenceMap: {
            jobRef: "1",
            customerRef: "C1",
            foremanRef: "F1",
            superintendentRef: "S1",
            projectId: projectRow.id,
            customerPartyId: customerId,
            foremanPartyId: roles.foreman,
            superintendentPartyId: roles.superintendent,
          },
        }),
        importFieldTickets({
          orgId: org.orgId,
          actorId,
          sourceSystem: "test-source",
          apply: true,
          tickets: [ticket({ sourceId: "9", number: "FT-101", jobRef: "1", approval: "No" })],
          charges: [],
        }),
      ]);
      assert.equal(
        raced.filter((result) => result.status === "fulfilled").length,
        1,
        "exactly one admission wins; the other refuses or rolls back",
      );
      const representations = Number(
        (
          await db.execute<{ count: string }>(
            sql`
      select count(*)::text count from documents
       where org_id = ${org.orgId} and kind = 'field_ticket'
         and custom->'source'->>'system' = 'test-source' and custom->'source'->>'externalId' = '9'
    `,
            "objects",
          )
        )[0]!.count,
      );
      assert.equal(representations, 1);
      const certifications = Number(
        (
          await db.execute<{ count: string }>(
            sql`
      select count(*)::text count from field_ticket_source_certifications where org_id = ${org.orgId}
    `,
            "objects",
          )
        )[0]!.count,
      );
      assert.equal(certifications, raced[0]!.status === "fulfilled" ? 1 : 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
