/**
 * Source-asserted party merges in the mirror.
 *
 * Owner decision: where an adapter exposes a merge/successor signal, the
 * mirror re-points the mirrored party (documents, open items, applications,
 * references) to the survivor in one transaction, keeps history and audit,
 * and records the merge on the survivor. Where no signal exists, a source
 * party that disappears while still referenced is HELD for controller review
 * as a named row failure — never silently duplicated, never deleted.
 *
 * These cases prove the engine side with per-adapter-namespaced fixtures
 * (every adapter emits the same SourceEntity shape; the behaviour is
 * adapter-agnostic and resolves strictly within one connector identity).
 * Red without the fix: the absorbed party stays live and transactable, its
 * documents keep pointing at it, and a disappeared party vanishes silently.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../test-fixtures.ts";
import { loadEntities, type PartyMirrorOutcome } from "./migrate.ts";
import type { EntityStream, MigrationSource, SourceEntity } from "./source.ts";
import { PARTY_MERGE_REF_COVERAGE } from "./party-merges.ts";
import { buildNativeContext } from "./native.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/** Every adapter namespace the mirror supports, with its connector identity key. */
const ADAPTERS: { name: string; refKey: string }[] = [
  { name: "netsuite", refKey: "nsId" },
  { name: "qbo", refKey: "qboId" },
  { name: "qbd", refKey: "qbdId" },
  { name: "xero", refKey: "xeroId" },
  { name: "odoo", refKey: "odooId" },
  { name: "erpnext", refKey: "erpId" },
  { name: "dynamics", refKey: "bcId" },
];

function party(sourceRef: string, displayName: string, extra?: Partial<SourceEntity>): SourceEntity {
  return {
    sourceRef,
    fields: { displayName, kind: "company", isActive: true },
    ...extra,
  };
}

function stubSource(
  adapter: { name: string; refKey: string },
  streams: EntityStream[],
): MigrationSource {
  return {
    name: adapter.name,
    refKey: adapter.refKey,
    baseCurrency: "CAD",
    accountingPeriods: async () => [],
    entities: async () => streams,
    nativeChanges: async () => {
      throw new Error("not used by this test");
    },
    trialBalance: async () => [],
    monthlyActivity: async () => [],
  };
}

function partiesStream(records: SourceEntity[]): EntityStream {
  return { resource: "parties", records };
}

async function loadParties(
  org: ScratchOrg,
  adapter: { name: string; refKey: string },
  records: SourceEntity[],
  since: Date | null,
  outcome: PartyMirrorOutcome,
  extraStreams: EntityStream[] = [],
) {
  return withOrg(org.orgId, () =>
    loadEntities(
      stubSource(adapter, [partiesStream(records), ...extraStreams]),
      org.orgId,
      since,
      undefined,
      { connectionId: null, runId: "00000000-0000-0000-0000-000000000001", actorId: null, sourceName: adapter.name },
      undefined,
      outcome,
    ),
  );
}

async function partyRow(orgId: string, id: string) {
  return withOrg(orgId, () =>
    db.execute<{ id: string; display_name: string; is_active: boolean; custom: Record<string, unknown> }>(sql`
      select id, display_name, is_active, custom from parties where id = ${id} and org_id = ${orgId}`),
  ).then((r) => r.rows[0]!);
}

async function partyIdByRef(orgId: string, refKey: string, ref: string): Promise<string> {
  const found = await withOrg(orgId, () =>
    db.execute<{ id: string }>(sql`
      select id from parties where org_id = ${orgId} and custom->>${refKey} = ${ref} limit 1`),
  );
  assert.ok(found.rows[0], `party ${ref} landed`);
  return found.rows[0]!.id;
}

for (const adapter of ADAPTERS) {
  test(`[${adapter.name}] a source-asserted merge re-points the absorbed party to the survivor`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    try {
      const outcome1: PartyMirrorOutcome = { merges: [], holds: [] };
      const stats1 = await loadParties(org, adapter, [
        party("PTY-A", "Survivor Co"),
        party("PTY-B", "Absorbed Co"),
      ], null, outcome1, [
        { resource: "contacts", records: [{ sourceRef: "C-1", fields: { companyRef: "PTY-B", name: "Bee Contact" } }] },
        { resource: "addresses", records: [{ sourceRef: "ADDR-1", fields: { entityRef: "PTY-B", line1: "1 Main St" } }] },
        { resource: "projects", records: [{ sourceRef: "P-1", fields: { name: "Job 1", customerRef: "PTY-B" } }] },
      ]);
      assert.equal(stats1.parties?.failed ?? 0, 0);
      assert.deepEqual(outcome1, { merges: [], holds: [] });
      const survivorId = await partyIdByRef(org.orgId, adapter.refKey, "PTY-A");
      const absorbedId = await partyIdByRef(org.orgId, adapter.refKey, "PTY-B");

      const outcome2: PartyMirrorOutcome = { merges: [], holds: [] };
      const stats2 = await loadParties(org, adapter, [
        party("PTY-A", "Survivor Co"),
        party("PTY-B", "Absorbed Co", { mergedIntoRef: "PTY-A" }),
      ], null, outcome2);
      assert.equal(stats2.parties?.failed ?? 0, 0);
      assert.deepEqual(outcome2.merges, [{ absorbedRef: "PTY-B", survivorRef: "PTY-A" }]);
      assert.deepEqual(outcome2.holds, []);

      const absorbed = await partyRow(org.orgId, absorbedId);
      assert.equal(absorbed.is_active, false);
      assert.equal(
        ((absorbed.custom["merged_into"] as Record<string, unknown>)?.["survivor"] as string),
        survivorId,
      );
      const survivor = await partyRow(org.orgId, survivorId);
      const mergedFrom = survivor.custom["merged_from"] as { absorbedRef: string }[];
      assert.ok(Array.isArray(mergedFrom) && mergedFrom.some((e) => e.absorbedRef === "PTY-B"));

      const refs = await withOrg(org.orgId, () => db.execute<{ tbl: string; pid: string }>(sql`
        select 'contacts' as tbl, party_id as pid from contacts where org_id = ${org.orgId} and custom->>${adapter.refKey} = 'C-1'
         union all
        select 'addresses', party_id from addresses where org_id = ${org.orgId} and custom->>${adapter.refKey} = 'ADDR-1'
         union all
        select 'projects', customer_id from projects where org_id = ${org.orgId} and custom->>${adapter.refKey} = 'P-1'`));
      for (const row of refs.rows) {
        assert.equal(row.pid, survivorId, `${row.tbl} follows the survivor`);
      }

      const audit = await withOrg(org.orgId, () => db.execute<{ n: string }>(sql`
        select count(*)::text as n from audit_log
         where org_id = ${org.orgId} and table_name = 'parties' and row_id = ${absorbedId} and action = 'merge'`));
      assert.equal(audit.rows[0]?.n, "1");

      // Re-pulling the same signal is an idempotent no-op: no new outcome, no failure.
      const outcome3: PartyMirrorOutcome = { merges: [], holds: [] };
      const stats3 = await loadParties(org, adapter, [
        party("PTY-A", "Survivor Co"),
        party("PTY-B", "Absorbed Co", { mergedIntoRef: "PTY-A" }),
      ], null, outcome3);
      assert.equal(stats3.parties?.failed ?? 0, 0);
      assert.deepEqual(outcome3, { merges: [], holds: [] });

      // A later full pull without the absorbed row does not re-hold the merge.
      const outcome4: PartyMirrorOutcome = { merges: [], holds: [] };
      const stats4 = await loadParties(org, adapter, [party("PTY-A", "Survivor Co")], null, outcome4);
      assert.equal(stats4.parties?.failed ?? 0, 0);
      assert.deepEqual(outcome4, { merges: [], holds: [] });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });

  test(`[${adapter.name}] a disappeared party that is still referenced is held, never deleted`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    try {
      const first: PartyMirrorOutcome = { merges: [], holds: [] };
      await loadParties(org, adapter, [
        party("PTY-A", "Survivor Co"),
        party("PTY-C", "Vanishing Co"),
      ], null, first, [
        { resource: "contacts", records: [{ sourceRef: "C-9", fields: { companyRef: "PTY-C", name: "Cee Contact" } }] },
      ]);
      const vanishingId = await partyIdByRef(org.orgId, adapter.refKey, "PTY-C");

      const outcome: PartyMirrorOutcome = { merges: [], holds: [] };
      const stats = await loadParties(org, adapter, [party("PTY-A", "Survivor Co")], null, outcome);
      assert.equal(stats.parties?.failed, 1);
      assert.equal(stats.parties?.errors.length, 1);
      assert.match(stats.parties!.errors[0]!.message, /Vanishing Co/);
      assert.match(stats.parties!.errors[0]!.message, /PTY-C/);
      assert.deepEqual(outcome.holds, ["PTY-C"]);

      // Held means kept: the row stays live, its contact still points at it, nothing was re-pointed or deleted.
      const held = await partyRow(org.orgId, vanishingId);
      assert.equal(held.is_active, true);
      assert.equal(held.custom["merged_into"], undefined);
      const contact = await withOrg(org.orgId, () => db.execute<{ pid: string }>(sql`
        select party_id as pid from contacts where org_id = ${org.orgId} and custom->>${adapter.refKey} = 'C-9'`));
      assert.equal(contact.rows[0]?.pid, vanishingId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}

test("merge signals fail closed: self-merge, unknown survivor, and cycles are held", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const adapter = ADAPTERS[0]!;
  try {
    const first: PartyMirrorOutcome = { merges: [], holds: [] };
    await loadParties(org, adapter, [party("A", "A Co"), party("B", "B Co"), party("C", "C Co")], null, first);
    const idA = await partyIdByRef(org.orgId, adapter.refKey, "A");

    const outcome: PartyMirrorOutcome = { merges: [], holds: [] };
    const stats = await loadParties(org, adapter, [
      party("A", "A Co"),
      party("B", "B Co", { mergedIntoRef: "B" }),
      party("C", "C Co", { mergedIntoRef: "GHOST" }),
    ], null, outcome);
    assert.equal(stats.parties?.failed, 2);
    assert.deepEqual(outcome.merges, []);
    const byRef = new Map(stats.parties!.errors.map((e) => [e.sourceRef, e.message]));
    assert.match(byRef.get("B") ?? "", /itself/);
    assert.match(byRef.get("C") ?? "", /GHOST/);
    assert.equal((await partyRow(org.orgId, idA)).is_active, true);

    const cycleOutcome: PartyMirrorOutcome = { merges: [], holds: [] };
    const cycleStats = await loadParties(org, adapter, [
      party("A", "A Co", { mergedIntoRef: "B" }),
      party("B", "B Co", { mergedIntoRef: "A" }),
      party("C", "C Co"),
    ], null, cycleOutcome);
    assert.equal(cycleStats.parties?.failed, 2);
    assert.deepEqual(cycleOutcome.merges, []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function seedPostedInvoice(
  org: ScratchOrg,
  opts: { customerPartyId: string; tag: string },
): Promise<{ documentId: string; invoiceArLineId: string; paymentArLineId: string; applicationId: string }> {
  return withOrg(org.orgId, async () => {
    const entry1 = (await db.execute<{ id: string }>(sql`
      insert into journal_entries (org_id, book_id, entry_number, posting_date, period_id, subsidiary_id, status)
      values (${org.orgId}, ${org.bookId}, ${`PM-INV-${opts.tag}`}, ${org.date}, ${org.periodId}, ${org.subsidiaryId}, 'draft')
      returning id`)).rows[0]!.id;
    const lines1 = (await db.execute<{ id: string; line_number: number }>(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, amount, currency, txn_amount, subsidiary_id, party_id, is_open_item)
      values
        (${org.orgId}, ${entry1}, 1, ${org.accounts.ar}, '100', 'CAD', '100', ${org.subsidiaryId}, ${opts.customerPartyId}, true),
        (${org.orgId}, ${entry1}, 2, ${org.accounts.revenue}, '-100', 'CAD', '-100', ${org.subsidiaryId}, null, false)
      returning id, line_number`)).rows;
    lines1.sort((a, b) => a.line_number - b.line_number);
    const entry2 = (await db.execute<{ id: string }>(sql`
      insert into journal_entries (org_id, book_id, entry_number, posting_date, period_id, subsidiary_id, status)
      values (${org.orgId}, ${org.bookId}, ${`PM-PAY-${opts.tag}`}, ${org.date}, ${org.periodId}, ${org.subsidiaryId}, 'draft')
      returning id`)).rows[0]!.id;
    const lines2 = (await db.execute<{ id: string; line_number: number }>(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, amount, currency, txn_amount, subsidiary_id, party_id, is_open_item)
      values
        (${org.orgId}, ${entry2}, 1, ${org.accounts.bank}, '40', 'CAD', '40', ${org.subsidiaryId}, null, false),
        (${org.orgId}, ${entry2}, 2, ${org.accounts.ar}, '-40', 'CAD', '-40', ${org.subsidiaryId}, ${opts.customerPartyId}, true)
      returning id, line_number`)).rows;
    lines2.sort((a, b) => a.line_number - b.line_number);
    await db.execute(sql`
      update journal_entries set status = 'posted'
       where org_id = ${org.orgId} and id in (${entry1}, ${entry2})`);
    const applicationId = (await db.execute<{ id: string }>(sql`
      insert into applications
        (org_id, from_line_id, to_line_id, amount, applied_on, source_amount,
         source_transaction_amount, source_transaction_currency,
         target_transaction_amount, target_transaction_currency,
         settlement_rate, settlement_rate_source, settlement_rate_reference)
      values (${org.orgId}, ${lines2[1]!.id}, ${lines1[0]!.id}, '40', ${org.date}, '40',
              '40', 'CAD', '40', 'CAD', '1', 'same_currency', 'party-merge')
      returning id`)).rows[0]!.id;
    const documentId = (await db.execute<{ id: string }>(sql`
      insert into documents
        (org_id, kind, document_number, document_date, currency, party_id, status,
         subtotal, tax_total, total, open_balance)
      values (${org.orgId}, 'customer_invoice', ${`PM-DOC-${opts.tag}`}, ${org.date}, 'CAD',
              ${opts.customerPartyId}, 'draft', '0', '0', '0', null)
      returning id`)).rows[0]!.id;
    await db.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, amount, party_id)
      values (${org.orgId}, ${documentId}, 1, ${org.accounts.revenue}, '100', ${opts.customerPartyId})`);
    await db.execute(sql`
      update documents
         set status = 'posted', posted_entry_id = ${entry1}, posting_period_id = ${org.periodId}
       where id = ${documentId} and org_id = ${org.orgId}`);
    return { documentId, invoiceArLineId: lines1[0]!.id, paymentArLineId: lines2[1]!.id, applicationId };
  });
}

test("a merge re-points posted documents, lines, journals, and open balances while applications stand", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const adapter = ADAPTERS[0]!;
  const tag = org.orgId.slice(0, 8);
  try {
    const first: PartyMirrorOutcome = { merges: [], holds: [] };
    await loadParties(org, adapter, [party("A", "Survivor Co"), party("B", "Absorbed Co")], null, first);
    const survivorId = await partyIdByRef(org.orgId, adapter.refKey, "A");
    const absorbedId = await partyIdByRef(org.orgId, adapter.refKey, "B");

    const seeded = await seedPostedInvoice(org, { customerPartyId: absorbedId, tag });
    await withOrg(org.orgId, () => db.execute(sql`
      insert into customer_roles (org_id, party_id) values (${org.orgId}, ${survivorId}), (${org.orgId}, ${absorbedId})`));
    await withOrg(org.orgId, () => db.execute(sql`
      insert into party_subsidiaries (org_id, party_id, subsidiary_id)
      values (${org.orgId}, ${survivorId}, ${org.subsidiaryId}), (${org.orgId}, ${absorbedId}, ${org.subsidiaryId})`));
    const beforeDoc = await withOrg(org.orgId, () => db.execute<{
      party_id: string; status: string; open_balance: string | null; total: string;
    }>(sql`
      select party_id, status, open_balance::text as open_balance, total::text as total
        from documents where id = ${seeded.documentId} and org_id = ${org.orgId}`)).then((r) => r.rows[0]!);
    assert.equal(beforeDoc.party_id, absorbedId);
    assert.equal(beforeDoc.status, "posted");

    const outcome: PartyMirrorOutcome = { merges: [], holds: [] };
    const stats = await loadParties(org, adapter, [
      party("A", "Survivor Co"),
      party("B", "Absorbed Co", { mergedIntoRef: "A" }),
    ], null, outcome);
    assert.equal(stats.parties?.failed ?? 0, 0);
    assert.deepEqual(outcome.merges, [{ absorbedRef: "B", survivorRef: "A" }]);

    const afterDoc = await withOrg(org.orgId, () => db.execute<{
      party_id: string; status: string; open_balance: string | null; total: string;
    }>(sql`
      select party_id, status, open_balance::text as open_balance, total::text as total
        from documents where id = ${seeded.documentId} and org_id = ${org.orgId}`)).then((r) => r.rows[0]!);
    assert.equal(afterDoc.party_id, survivorId);
    assert.equal(afterDoc.status, "posted");
    assert.equal(afterDoc.open_balance, beforeDoc.open_balance);
    assert.equal(afterDoc.total, beforeDoc.total);

    const docLine = await withOrg(org.orgId, () => db.execute<{ pid: string }>(sql`
      select party_id as pid from document_lines where document_id = ${seeded.documentId} and org_id = ${org.orgId}`));
    assert.equal(docLine.rows[0]?.pid, survivorId);

    const journals = await withOrg(org.orgId, () => db.execute<{ id: string; pid: string | null }>(sql`
      select id, party_id as pid from journal_lines
       where org_id = ${org.orgId} and id in (${seeded.invoiceArLineId}, ${seeded.paymentArLineId})`));
    for (const row of journals.rows) assert.equal(row.pid, survivorId);

    const application = await withOrg(org.orgId, () => db.execute<{
      from_line_id: string; to_line_id: string; amount: string;
    }>(sql`
      select from_line_id, to_line_id, amount::text as amount from applications
       where id = ${seeded.applicationId} and org_id = ${org.orgId}`)).then((r) => r.rows[0]!);
    assert.equal(application.from_line_id, seeded.paymentArLineId);
    assert.equal(application.to_line_id, seeded.invoiceArLineId);
    assert.equal(application.amount, "40.0000");

    // Both sides held a customer role: the survivor's stands, the absorbed row
    // is retained as deactivated history — never duplicated, never deleted.
    const roles = await withOrg(org.orgId, () => db.execute<{ pid: string; active: boolean }>(sql`
      select party_id as pid, is_active as active from customer_roles
       where org_id = ${org.orgId} and party_id in (${survivorId}, ${absorbedId}) order by pid`));
    assert.equal(roles.rows.length, 2);
    assert.equal(roles.rows.find((r) => r.pid === survivorId)?.active, true);
    assert.equal(roles.rows.find((r) => r.pid === absorbedId)?.active, false);

    // Both sides linked the same subsidiary: the absorbed link is retained.
    const links = await withOrg(org.orgId, () => db.execute<{ pid: string }>(sql`
      select party_id as pid from party_subsidiaries where org_id = ${org.orgId} and subsidiary_id = ${org.subsidiaryId}`));
    assert.deepEqual(links.rows.map((r) => r.pid).sort(), [absorbedId, survivorId].sort());

    const audit = await withOrg(org.orgId, () => db.execute<{ changes: Record<string, unknown> }>(sql`
      select changes from audit_log
       where org_id = ${org.orgId} and table_name = 'parties' and row_id = ${absorbedId} and action = 'merge'`));
    const changes = audit.rows[0]?.changes as { moved: Record<string, number>; retained: Record<string, number> };
    assert.ok((changes.moved["documents.party_id"] ?? 0) >= 1);
    assert.ok((changes.moved["journal_lines.party_id"] ?? 0) >= 2);
    assert.ok((changes.retained["customer_roles.party_id"] ?? 0) >= 1);
    assert.ok((changes.retained["party_subsidiaries.party_id"] ?? 0) >= 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("journal lines in a controller-closed period are retained, never forced", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const adapter = ADAPTERS[0]!;
  const tag = org.orgId.slice(0, 8);
  try {
    const first: PartyMirrorOutcome = { merges: [], holds: [] };
    await loadParties(org, adapter, [party("A", "Survivor Co"), party("B", "Absorbed Co")], null, first);
    const survivorId = await partyIdByRef(org.orgId, adapter.refKey, "A");
    const absorbedId = await partyIdByRef(org.orgId, adapter.refKey, "B");
    const seeded = await seedPostedInvoice(org, { customerPartyId: absorbedId, tag });
    await withOrg(org.orgId, () => db.execute(sql`
      insert into period_locks (org_id, period_id, book_id, module, state, reason)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, 'gl', 'closed', 'test-controller-close')`));

    const outcome: PartyMirrorOutcome = { merges: [], holds: [] };
    const stats = await loadParties(org, adapter, [
      party("A", "Survivor Co"),
      party("B", "Absorbed Co", { mergedIntoRef: "A" }),
    ], null, outcome);
    assert.equal(stats.parties?.failed ?? 0, 0);
    assert.deepEqual(outcome.merges, [{ absorbedRef: "B", survivorRef: "A" }]);

    const journals = await withOrg(org.orgId, () => db.execute<{ id: string; pid: string | null }>(sql`
      select id, party_id as pid from journal_lines
       where org_id = ${org.orgId} and id in (${seeded.invoiceArLineId}, ${seeded.paymentArLineId})`));
    for (const row of journals.rows) assert.equal(row.pid, absorbedId);

    const afterDoc = await withOrg(org.orgId, () => db.execute<{ pid: string }>(sql`
      select party_id as pid from documents where id = ${seeded.documentId} and org_id = ${org.orgId}`));
    assert.equal(afterDoc.rows[0]?.pid, survivorId);

    const audit = await withOrg(org.orgId, () => db.execute<{ changes: Record<string, unknown> }>(sql`
      select changes from audit_log
       where org_id = ${org.orgId} and table_name = 'parties' and row_id = ${absorbedId} and action = 'merge'`));
    const retained = (audit.rows[0]?.changes as { retained: Record<string, number> }).retained;
    assert.ok((retained["journal_lines.party_id"] ?? 0) >= 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the native context resolves absorbed refs to the survivor after a merge", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const adapter = ADAPTERS[0]!;
  try {
    const first: PartyMirrorOutcome = { merges: [], holds: [] };
    await loadParties(org, adapter, [party("A", "Survivor Co"), party("B", "Absorbed Co")], null, first);
    const survivorId = await partyIdByRef(org.orgId, adapter.refKey, "A");
    const second: PartyMirrorOutcome = { merges: [], holds: [] };
    await loadParties(org, adapter, [
      party("A", "Survivor Co"),
      party("B", "Absorbed Co", { mergedIntoRef: "A" }),
    ], null, second);
    assert.deepEqual(second.merges, [{ absorbedRef: "B", survivorRef: "A" }]);
    const ctx = await withOrg(org.orgId, () => buildNativeContext(org.orgId, adapter.refKey, "CAD"));
    assert.equal(ctx.partyByRef.get("A"), survivorId);
    assert.equal(ctx.partyByRef.get("B"), survivorId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the merge covers every foreign key to parties(id)", { skip: !DB }, async () => {
  const catalog = await db.execute<{ tbl: string; col: string }>(sql`
    select distinct tc.table_name as tbl, kcu.column_name as col
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
     where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'parties' and ccu.column_name = 'id'
       and kcu.column_name <> 'org_id'`);
  const inCatalog = new Set(catalog.rows.map((r) => `${r.tbl}.${r.col}`));
  const covered = new Set(PARTY_MERGE_REF_COVERAGE.map(([t, c]) => `${t}.${c}`));
  assert.deepEqual([...inCatalog].sort(), [...covered].sort());
});

test("an unreferenced disappearance is left untouched and an incremental absence is ignored", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const adapter = ADAPTERS[0]!;
  try {
    const first: PartyMirrorOutcome = { merges: [], holds: [] };
    await loadParties(org, adapter, [party("A", "A Co"), party("LONER", "Loner Co")], null, first);
    const lonerId = await partyIdByRef(org.orgId, adapter.refKey, "LONER");

    const fullOutcome: PartyMirrorOutcome = { merges: [], holds: [] };
    const fullStats = await loadParties(org, adapter, [party("A", "A Co")], null, fullOutcome);
    assert.equal(fullStats.parties?.failed ?? 0, 0);
    assert.deepEqual(fullOutcome, { merges: [], holds: [] });
    assert.equal((await partyRow(org.orgId, lonerId)).is_active, true);

    const referenced: PartyMirrorOutcome = { merges: [], holds: [] };
    await loadParties(org, adapter, [party("A", "A Co"), party("HELD", "Held Co")], null, referenced, [
      { resource: "contacts", records: [{ sourceRef: "C-H", fields: { companyRef: "HELD", name: "Held Contact" } }] },
    ]);
    const incrementalOutcome: PartyMirrorOutcome = { merges: [], holds: [] };
    const incrementalStats = await loadParties(org, adapter, [party("A", "A Co")], new Date(), incrementalOutcome);
    assert.equal(incrementalStats.parties?.failed ?? 0, 0);
    assert.deepEqual(incrementalOutcome, { merges: [], holds: [] });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
