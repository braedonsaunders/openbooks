import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { allocateDocumentNumber } from "./document-numbering.ts";
import { cmp } from "./money.ts";
import { receiveInventory, revalueOpenLayersToStandardCost, InventoryError } from "./inventory.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Organization-wide document-number uniqueness (0032 policy): `documents`
 * enforces UNIQUE (org_id, kind, document_number) with no subsidiary column,
 * so every generator must allocate from the ONE canonical allocator's single
 * org-wide sequence per (org, kind). Storage refuses per-subsidiary sequence
 * rows, backward counter moves, and format changes on used rows; a
 * deterministic repair merges legacy per-subsidiary rows without ever
 * reproducing an issued number.
 */

/** The generators whose contract is to delegate to the canonical allocator. */
const ALLOCATOR_CONTRACT_FILES = [
  "engine/src/journal-writes.ts",
  "engine/src/ap-capture-service.ts",
  "engine/src/inventory.ts",
  "engine/src/construction-billing.ts",
  "engine/src/subcontracts.ts",
  "engine/src/subscription-billing.ts",
  "engine/src/recurring.ts",
  "engine/src/payments.ts",
  "web/lib/bills.ts",
  "web/lib/data-io/record-resources.ts",
] as const;

/** Insert the numbered draft document a generator would create. */
async function seedNumberedDocument(orgId: string, kind: string, number: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, currency, subtotal, tax_total, total)
    values (${id}, ${orgId}, ${kind}, 'draft', ${number}, '2026-07-15', 'CAD', '0', '0', '0')`);
  return id;
}

async function addSubsidiary(org: ScratchOrg, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${name}, 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

async function sequenceRow(orgId: string, kind: string) {
  const rows = (await db.execute<{
    subsidiary_id: string | null;
    prefix: string;
    next_number: number;
    padding: number;
    allocated_through: number;
  }>(sql`
    select subsidiary_id, prefix, next_number, padding, allocated_through
      from number_sequences
     where org_id = ${orgId} and document_kind = ${kind}`));
  return rows.rows;
}

/** Match a PG violation (code / constraint / message) anywhere in a cause chain. */
function inChain(error: unknown, match: (candidate: { code?: string; constraint?: string; message?: string }) => boolean): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (match(current as { code?: string; constraint?: string; message?: string })) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

test("document numbers from two subsidiaries allocating concurrently stay disjoint", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const subA = await addSubsidiary(org, "Alpha");
    const subB = await addSubsidiary(org, "Beta");

    // Two generator call sites — one per subsidiary context — race through the
    // canonical allocator. Each allocation is one committed autocommit
    // statement, the ON CONFLICT update takes the row lock, and the outputs
    // must be distinct and consecutive: under the retired per-subsidiary
    // scheme these two contexts each drew from their own sequence row and both
    // produced JE-00001, losing the second document on the documents unique
    // index mid-close.
    const jobs = Array.from({ length: 16 }, (_, i) => {
      const sub = i % 2 === 0 ? subA : subB;
      return allocateDocumentNumber(db, org.orgId, "journal", "JE-").then((number) => ({ number, sub }));
    });
    const results = await Promise.all(jobs);
    assert.equal(new Set(results.map((r) => r.sub)).size, 2, "both subsidiary call sites must have raced");

    const numbers = results.map((r) => r.number);
    assert.equal(new Set(numbers).size, numbers.length, "concurrent allocations must never repeat a number");
    const expected = Array.from({ length: 16 }, (_, i) => `JE-${String(i + 1).padStart(5, "0")}`);
    assert.deepEqual([...numbers].sort(), expected, "numbers must be one unbroken consecutive run");

    // Every allocated number is absorbable by documents' org-wide unique
    // index — the exact constraint the old per-subsidiary rows violated.
    for (const number of numbers) {
      await seedNumberedDocument(org.orgId, "journal", number);
    }

    // Exactly one org-wide sequence row backs the kind.
    const rows = await sequenceRow(org.orgId, "journal");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.subsidiary_id, null);
    assert.equal(rows[0]!.allocated_through, 16);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("legacy per-subsidiary sequences are repaired deterministically without reissuing numbers", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const subA = await addSubsidiary(org, "Legacy A");
    const subB = await addSubsidiary(org, "Legacy B");

    // Tenants already hold documents numbered by the broken per-subsidiary
    // scheme; the upgrade must preserve them all.
    for (const number of ["JE-00001", "JE-00002", "JE-00003"]) {
      await seedNumberedDocument(org.orgId, "journal", number);
    }

    // Reconstruct the pre-0032 legacy state: one org-wide row behind the
    // documents plus two independent per-subsidiary rows (the collision
    // source). This lifts the 0032 constraints, exactly as the world looked
    // before the migration installed them; the repair itself needs neither
    // (explicit update-then-insert, no conflict target).
    await db.execute(sql`alter table number_sequences drop constraint number_sequences_org_wide_sequence`);
    await db.execute(sql`alter table number_sequences drop constraint sequences_org_kind_sub`);
    try {
      await db.execute(sql`
        insert into number_sequences (org_id, document_kind, subsidiary_id, prefix, next_number, allocated_through)
        values (${org.orgId}, 'journal', null, 'JE-', 1, 0),
               (${org.orgId}, 'journal', ${subA}, 'JE-', 2, 0),
               (${org.orgId}, 'journal', ${subB}, 'JE-', 3, 0)`);

      await db.execute(sql`select public.openbooks_repair_document_sequences()`);

      // One merged org-wide row, floored at the last issued number so the
      // next allocation hands out exactly the number after the last one
      // issued — never reproducing JE-00001..3.
      const rows = await sequenceRow(org.orgId, "journal");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.subsidiary_id, null);
      assert.equal(rows[0]!.prefix, "JE-");
      assert.equal(rows[0]!.next_number, 3);
      assert.equal(rows[0]!.allocated_through, 3);

      // The repair is rerunnable and idempotent.
      await db.execute(sql`select public.openbooks_repair_document_sequences()`);
      assert.equal((await sequenceRow(org.orgId, "journal")).length, 1);
    } finally {
      await db.execute(sql`alter table number_sequences add constraint sequences_org_kind_sub unique (org_id, document_kind)`);
      await db.execute(sql`alter table number_sequences add constraint number_sequences_org_wide_sequence check (subsidiary_id is null)`);
    }

    // The next allocation resumes after the last issued number — never
    // reproducing JE-00001..3 — and posts cleanly into documents.
    const next = await allocateDocumentNumber(db, org.orgId, "journal", "JE-");
    assert.equal(next, "JE-00004");
    await seedNumberedDocument(org.orgId, "journal", next);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("storage refuses per-subsidiary rows, backward counters, and used-format edits", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // Live allocation through the canonical allocator. The first allocation
    // inserts the fresh row (nothing consumed before it); every later advance
    // raises the watermark.
    const first = await allocateDocumentNumber(db, org.orgId, "journal", "JE-");
    assert.equal(first, "JE-00001");
    let rows = await sequenceRow(org.orgId, "journal");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.subsidiary_id, null);

    // Advancing forward is the legal, controlled skip-ahead operation, and
    // the watermark follows the counter atomically in the same write.
    await db.execute(sql`update number_sequences set next_number = 500 where org_id = ${org.orgId} and document_kind = 'journal'`);
    rows = await sequenceRow(org.orgId, "journal");
    assert.equal(rows[0]!.next_number, 500);
    assert.equal(rows[0]!.allocated_through, 500);

    // A used counter cannot decrease into an occupied output range — an
    // admin reset from 500 back to 1 would otherwise reproduce existing
    // numbers and fail every subsequent document transactionally.
    await assert.rejects(
      db.execute(sql`update number_sequences set next_number = 1 where org_id = ${org.orgId} and document_kind = 'journal'`),
      (error: unknown) => inChain(error, (c) => typeof c.message === "string" && c.message.includes("cannot move backward")),
    );

    // A used sequence cannot change the output format it already issued.
    for (const statement of [
      sql`update number_sequences set prefix = 'JV-' where org_id = ${org.orgId} and document_kind = 'journal'`,
      sql`update number_sequences set padding = 4 where org_id = ${org.orgId} and document_kind = 'journal'`,
    ]) {
      await assert.rejects(
        db.execute(statement),
        (error: unknown) => inChain(error, (c) => typeof c.message === "string" && c.message.includes("frozen once used")),
      );
    }
    assert.equal(await allocateDocumentNumber(db, org.orgId, "journal", "JE-"), "JE-00501");

    // Per-subsidiary sequence rows are refused outright: document numbers are
    // organization-wide identities, so a second subsidiary row for the same
    // kind can never produce disjoint output.
    await assert.rejects(
      db.execute(sql`
        insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
        values (${org.orgId}, 'journal', ${await addSubsidiary(org, "Extra")}, 'JE-')`),
      (error: unknown) =>
        inChain(error, (c) => c.code === "23514" && c.constraint === "number_sequences_org_wide_sequence"),
    );

    // Counters are positive and one row per (org, kind) is exact.
    await assert.rejects(
      db.execute(sql`
        insert into number_sequences (org_id, document_kind, prefix, next_number)
        values (${org.orgId}, 'journal', 'JE-', 0)`),
      (error: unknown) =>
        inChain(error, (c) => c.code === "23514" && c.constraint === "number_sequences_next_number_positive"),
    );
    await assert.rejects(
      db.execute(sql`
        insert into number_sequences (org_id, document_kind, prefix)
        values (${org.orgId}, 'journal', 'JE-')`),
      (error: unknown) => inChain(error, (c) => c.code === "23505" && c.constraint === "sequences_org_kind_sub"),
    );

    // A never-issued sequence remains fully configurable, including format.
    await db.execute(sql`
      insert into number_sequences (org_id, document_kind, prefix, next_number, padding)
      values (${org.orgId}, 'expense_report', 'EXP-', 100, 6)`);
    await db.execute(sql`
      update number_sequences set prefix = 'EX-', padding = 5
       where org_id = ${org.orgId} and document_kind = 'expense_report'`);
    assert.equal(await allocateDocumentNumber(db, org.orgId, "expense_report", "EX-"), "EX-00101");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("every listed generator delegates to the canonical allocator (source contract)", () => {
  const allocatorSource = readFileSync("engine/src/document-numbering.ts", "utf8");
  assert.match(allocatorSource, /insert into number_sequences/, "the canonical allocator owns the one upsert");

  for (const file of ALLOCATOR_CONTRACT_FILES) {
    const source = readFileSync(file, "utf8");
    assert.match(
      source,
      /from ['"](?:\.\/|@openbooks\/engine\/src\/)document-numbering\.ts['"]/,
      `${file} must import the canonical allocator`,
    );
    assert.match(source, /allocateDocumentNumber\(/, `${file} must allocate through the canonical allocator`);
    assert.doesNotMatch(
      source,
      /insert into number_sequences/,
      `${file} must not carry its own sequence upsert`,
    );
  }
});

test("standard-cost revaluation refuses to self-cancel with no variance account, and keeps GL = layers with one", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // The revaluation engine dates its entry on the org's business today, so
    // the org needs an open period covering it (fixture only pins 2026-07).
    const calendar = (await db.execute<{ id: string }>(sql`
      select id from fiscal_calendars where org_id = ${org.orgId} limit 1`));
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${org.orgId},
             extract(year from current_date)::int,
             extract(month from current_date)::int,
             to_char(current_date, 'YYYY-MM'),
             date_trunc('month', current_date)::date,
             (date_trunc('month', current_date) + interval '1 month - 1 day')::date,
             false, ${calendar.rows[0]!.id}
      on conflict do nothing`);

    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "20", unitCost: "6.00",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    });

    const layerValue = async () => {
      const rows = (await db.execute<{ v: string }>(sql`
        select coalesce(sum(round(remaining_quantity * unit_cost, 4)), 0)::text as v
          from cost_layers
         where org_id = ${org.orgId} and item_id = ${org.items.fifo}`));
      return rows.rows[0]!.v;
    };
    const assetBalance = async () => {
      const rows = (await db.execute<{ v: string }>(sql`
        select coalesce(sum(l.amount), 0)::text as v
          from journal_lines l
         where l.org_id = ${org.orgId} and l.account_id = ${org.accounts.invAsset}`));
      return rows.rows[0]!.v;
    };
    const inventoryEntryCount = async () => {
      const rows = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_entries
         where org_id = ${org.orgId} and origin = 'inventory'`));
      return rows.rows[0]!.n;
    };

    // (1) Revaluing with no variance account must be REFUSED with zero
    // journal and zero layer mutation. Before the fix both entry lines named
    // the asset account: a balanced, effectless entry that left the GL
    // unmoved while the layers moved — subledger and GL diverging forever.
    const entriesBefore = await inventoryEntryCount();
    const layersBefore = await layerValue();
    await assert.rejects(
      db.transaction((tx) =>
        revalueOpenLayersToStandardCost(tx, org.orgId, null, org.items.fifo, {
          standardCost: "5.00",
          assetAccountId: org.accounts.invAsset,
          varianceAccountId: null,
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof InventoryError, "refusal must be an InventoryError");
        assert.match(error.message, /requires a variance account/);
        return true;
      },
    );
    assert.equal(await inventoryEntryCount(), entriesBefore, "refusal must post no journal");
    assert.equal(cmp(await layerValue(), layersBefore), 0, "refusal must not mutate layers");

    // (2) With a variance account configured the revaluation succeeds and the
    // GL balance of the asset account equals the cost layers exactly.
    const entryIds = await db.transaction((tx) =>
      revalueOpenLayersToStandardCost(tx, org.orgId, null, org.items.fifo, {
        standardCost: "5.00",
        assetAccountId: org.accounts.invAsset,
        varianceAccountId: org.accounts.adjustment,
      }),
    );
    assert.ok(entryIds && entryIds.length === 1);
    assert.equal(cmp(await layerValue(), await assetBalance()), 0, "GL must equal cost layers after revaluation");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
