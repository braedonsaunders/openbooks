import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import {
  importFieldTickets,
  type ImportTicket,
} from "./field-ticket-import.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const ticket = (overrides: Partial<ImportTicket> = {}): ImportTicket => ({
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
  po: null,
  description: "Week nine",
  ...overrides,
});

async function project(orgId: string, nsId: string): Promise<string> {
  return String(
    (
      await db.execute<{ id: string }>(sql`
        insert into projects (org_id, name, custom)
        values (${orgId}, ${nsId}, ${JSON.stringify({ nsId })}::jsonb)
        returning id
      `)
    ).rows[0]!.id,
  );
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
      await db.execute<{ id: string }>(sql`
        insert into documents (org_id, kind, document_number, project_id, document_date, currency, status, custom)
        values (${orgId}, 'field_ticket', 'FT-9', ${projectId}, '2024-06-16', ${currency}, 'approved', ${JSON.stringify(marker)}::jsonb)
        returning id
      `)
    ).rows[0]!.id,
  );
  await db.execute(sql`
    insert into field_tickets (document_id, org_id, period, period_start, period_end)
    values (${docId}, ${orgId}, 'weekly', ${periodStart}, '2024-06-16')
  `);
  return docId;
}

async function counts(orgId: string): Promise<{ tickets: number; headers: number }> {
  const row = (
    await db.execute<{ tickets: string; headers: string }>(sql`
      select (select count(*) from documents where org_id = ${orgId} and kind = 'field_ticket')::text tickets,
             (select count(*) from field_tickets where org_id = ${orgId})::text headers
    `)
  ).rows[0]!;
  return { tickets: Number(row.tickets), headers: Number(row.headers) };
}

async function currency(orgId: string): Promise<string> {
  return String(
    (await db.execute<{ base_currency: string }>(
      sql`select base_currency from orgs where id = ${orgId}`,
    )).rows[0]!.base_currency,
  );
}

test("a same-number ticket from another source refuses and leaves the old document untouched", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const projectId = await project(org.orgId, "JOB-1");
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
        }),
      /field ticket number FT-9 already exists from a different source \(system other-connector, external id 99\)/,
    );
    assert.deepEqual(await counts(org.orgId), { tickets: 1, headers: 1 });
    const doc = (
      await db.execute<{ custom: unknown }>(
        sql`select custom from documents where id = ${docId}`,
      )
    ).rows[0]!.custom as { source: { system: string } };
    assert.equal(doc.source.system, "other-connector");
    const header = (
      await db.execute<{ period_start: string }>(
        sql`select period_start::text from field_tickets where document_id = ${docId}`,
      )
    ).rows[0]!;
    assert.match(header.period_start, /2024-01-01/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an exact replay is still idempotent", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const projectId = await project(org.orgId, "JOB-1");
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
    });
    assert.deepEqual(
      { created: first.created, existing: first.existing },
      { created: 0, existing: 1 },
    );
    assert.deepEqual(await counts(org.orgId), { tickets: 1, headers: 1 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});


test("one unmapped job refuses the whole import with zero writes", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await project(org.orgId, "JOB-1");
    const before = await counts(org.orgId);
    await assert.rejects(
      () =>
        importFieldTickets({
          orgId: org.orgId,
          sourceSystem: "test-source",
          tickets: [ticket(), ticket({ sourceId: "10", number: "FT-10", jobRef: "JOB-9" })],
          apply: true,
        }),
      /unknown source projects: source ticket 10 \(number FT-10, job JOB-9\)/,
    );
    assert.deepEqual(await counts(org.orgId), before);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a hostile org id refuses named at the boundary, before any query", { skip: !DB }, async () => {
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
});

test("one tenant's mappings stay invisible to another tenant's import", { skip: !DB }, async () => {
  const victim = await createScratchOrg();
  const probe = await createScratchOrg();
  try {
    await project(victim.orgId, "JOB-1");
    await project(probe.orgId, "PROBE-JOB");
    const plan = await importFieldTickets({
      orgId: probe.orgId,
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
