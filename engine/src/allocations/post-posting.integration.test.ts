import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { postDocument } from "../posting.ts";
import { requestDocumentVoid } from "../document-void.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

interface Ctx {
  org: ScratchOrg;
  actor: string;
  deptSrc: string;
  deptA: string;
  deptB: string;
}

async function setupCtx(): Promise<Ctx> {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Alloc post tester", "admin");
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
         || '{"allocations": true, "allocationsAtPosting": true}'::jsonb)
     where id = ${org.orgId}`);
  const deptSrc = randomUUID();
  const deptA = randomUUID();
  const deptB = randomUUID();
  await db.execute(sql`
    insert into departments (id, org_id, name, is_active)
    values (${deptSrc}, ${org.orgId}, 'Source', true),
           (${deptA}, ${org.orgId}, 'Team A', true),
           (${deptB}, ${org.orgId}, 'Team B', true)`);
  return { org, actor, deptSrc, deptA, deptB };
}

interface TargetSeed {
  departmentId?: string;
  subsidiaryId?: string | null;
  targetAccountId?: string | null;
  fixedPercent: string;
  label?: string;
}

async function seedPostRule(
  ctx: Ctx,
  opts: {
    key: string;
    impact: "reclass" | "net_zero_pair" | "report_only";
    targets: TargetSeed[];
    bookScope?: "primary" | "all_posting" | "books";
    bookIds?: string[];
    offsetAccountId?: string | null;
    accountId?: string;
  },
): Promise<{ ruleId: string; versionId: string }> {
  const ruleId = randomUUID();
  const versionId = randomUUID();
  const accountId = opts.accountId ?? ctx.org.accounts.cogs;
  await db.execute(sql`
    insert into allocation_rules
      (id, org_id, key, name, mode, sort_order, is_active, is_system, current_version_id)
    values (${ruleId}, ${ctx.org.orgId}, ${opts.key}, ${opts.key}, 'post', 100, true, false, null)`);
  // Draft first: published versions are frozen (targets immutable), so the
  // seed follows the real flow — draft, targets, then publish + pointer.
  await db.execute(sql`
    insert into allocation_rule_versions
      (id, org_id, rule_id, version_no, status, effective_from, definition_hash,
       book_scope, book_ids, document_kinds, account_scope, dimension_filters,
       basis_kind, target_kind, impact, offset_account_id, residual_policy)
    values (${versionId}, ${ctx.org.orgId}, ${ruleId}, 1, 'draft', '2026-01-01', null,
       ${opts.bookScope ?? "primary"}, ${JSON.stringify(opts.bookIds ?? [])}::jsonb,
       '["vendor_bill"]'::jsonb,
       ${JSON.stringify({ kind: "accounts", accountIds: [accountId] })}::jsonb,
       '{}'::jsonb, 'fixed_percent', 'explicit', ${opts.impact},
       ${opts.offsetAccountId ?? null}, 'largest_share')`);
  let sequence = 0;
  for (const target of opts.targets) {
    sequence += 1;
    await db.execute(sql`
      insert into allocation_rule_targets
        (id, org_id, version_id, sequence, target_account_id, department_id,
         subsidiary_id, fixed_percent, is_remainder, label)
      values (${randomUUID()}, ${ctx.org.orgId}, ${versionId}, ${sequence},
              ${target.targetAccountId ?? null}, ${target.departmentId ?? null},
              ${target.subsidiaryId ?? null}, ${target.fixedPercent}, false,
              ${target.label ?? null})`);
  }
  // Publish last: freeze the version, then point the head at it (the
  // head's FK to its current version requires the row to exist first).
  await db.execute(sql`
    update allocation_rule_versions
       set status = 'published', definition_hash = 'test-hash'
     where id = ${versionId} and org_id = ${ctx.org.orgId}`);
  await db.execute(sql`
    update allocation_rules set current_version_id = ${versionId}
     where id = ${ruleId} and org_id = ${ctx.org.orgId}`);
  return { ruleId, versionId };
}

/** An approved vendor bill with one expense line in the source department. */
async function seedBill(ctx: Ctx, number: string, amount: string): Promise<string> {
  const documentId = randomUUID();
  // Draft first: posted-document guards refuse line writes on an approved
  // header, so lines land while the bill is still a draft.
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
    values (${documentId}, ${ctx.org.orgId}, 'vendor_bill', 'draft', ${number},
            ${ctx.org.subsidiaryId}, ${ctx.org.vendorId}, ${ctx.org.date}, ${ctx.org.date},
            'CAD', '1', ${amount}, '0.0000', ${amount})`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, account_id, department_id, amount,
       tax_input_amount, tax_amount, quantity, unit_price)
    values (${randomUUID()}, ${ctx.org.orgId}, ${documentId}, 1, ${ctx.org.accounts.cogs},
            ${ctx.deptSrc}, ${amount}, ${amount}, '0.0000', '1', ${amount})`);
  await db.execute(sql`
    update documents set status = 'approved'
     where id = ${documentId} and org_id = ${ctx.org.orgId}`);
  return documentId;
}

async function postBill(ctx: Ctx, documentId: string): Promise<string> {
  return postDocument(
    documentId,
    { control: { ar: ctx.org.accounts.ar, ap: ctx.org.accounts.ap, bank: ctx.org.accounts.bank } },
    { audit: { actorId: ctx.actor, source: "test" } },
  );
}

type EntryLine = {
  id: string;
  line_number: number;
  account_id: string;
  department_id: string | null;
  amount: string;
  contributor_kind: string | null;
  contributor_ref: string | null;
};

async function entryLines(orgId: string, entryId: string): Promise<EntryLine[]> {
  const r = await db.execute<EntryLine>(sql`
    select id, line_number, account_id, department_id, amount::text,
           contributor_kind, contributor_ref
      from journal_lines
     where org_id = ${orgId} and entry_id = ${entryId}
     order by line_number`);
  return r.rows;
}

test("net_zero_pair adds dimensional attribution without moving account totals", { skip: !DB }, async () => {
  const ctx = await setupCtx();
  try {
    const { versionId } = await seedPostRule(ctx, {
      key: "stat-pair",
      impact: "net_zero_pair",
      targets: [
        { departmentId: ctx.deptA, fixedPercent: "60.0000", label: "Team A" },
        { departmentId: ctx.deptB, fixedPercent: "40.0000", label: "Team B" },
      ],
    });
    const entryId = await postBill(ctx, await seedBill(ctx, "BILL-PAIR-1", "100.0000"));
    const lines = await entryLines(ctx.org.orgId, entryId);
    assert.equal(lines.length, 5);
    // Kernel lines keep numbers 1..2 and carry no contributor.
    assert.deepEqual(lines.slice(0, 2).map((l) => [l.account_id, l.department_id, l.amount, l.contributor_kind]), [
      [ctx.org.accounts.cogs, ctx.deptSrc, "100.0000", null],
      [ctx.org.accounts.ap, null, "-100.0000", null],
    ]);
    // Contributed lines follow with rule stamps.
    assert.deepEqual(lines.slice(2).map((l) => [l.account_id, l.department_id, l.amount]), [
      [ctx.org.accounts.cogs, ctx.deptA, "60.0000"],
      [ctx.org.accounts.cogs, ctx.deptB, "40.0000"],
      [ctx.org.accounts.cogs, ctx.deptSrc, "-100.0000"],
    ]);
    for (const line of lines.slice(2)) {
      assert.equal(line.contributor_kind, "rule");
      assert.equal(line.contributor_ref, versionId);
    }
    // The pair nets to zero at the account level.
    const cogs = lines.filter((l) => l.account_id === ctx.org.accounts.cogs);
    const cogsTotal = cogs.reduce((acc, l) => acc + Number(l.amount), 0);
    assert.equal(cogsTotal, 100);
    // Lineage traces every contributed line to its kernel source.
    const lineage = (await db.execute<{
      journal_line_id: string | null;
      source_journal_line_id: string | null;
      amount: string;
      share: string;
    }>(sql`
      select journal_line_id, source_journal_line_id, amount::text, share::text
        from allocation_lineage
       where org_id = ${ctx.org.orgId} and mode = 'post'
       order by amount desc`)).rows;
    assert.equal(lineage.length, 3);
    const kernelIds = new Set(lines.slice(0, 2).map((l) => l.id));
    const contribIds = new Set(lines.slice(2).map((l) => l.id));
    for (const row of lineage) {
      assert.ok(row.journal_line_id && contribIds.has(row.journal_line_id));
      assert.ok(row.source_journal_line_id && kernelIds.has(row.source_journal_line_id));
    }
    assert.deepEqual(lineage.map((r) => r.amount), ["60.0000", "40.0000", "-100.0000"]);
  } finally {
    await dropScratchOrg(ctx.org.orgId);
  }
});

test("reclass moves the cost and the trial balance total is unchanged", { skip: !DB }, async () => {
  const ctx = await setupCtx();
  try {
    await seedPostRule(ctx, {
      key: "move-cost",
      impact: "reclass",
      targets: [{ departmentId: ctx.deptA, targetAccountId: ctx.org.accounts.adjustment, fixedPercent: "100.0000" }],
    });
    const entryId = await postBill(ctx, await seedBill(ctx, "BILL-RECLASS-1", "100.0000"));
    const lines = await entryLines(ctx.org.orgId, entryId);
    assert.equal(lines.length, 4);
    assert.deepEqual(lines.slice(2).map((l) => [l.account_id, l.amount]), [
      [ctx.org.accounts.adjustment, "100.0000"],
      [ctx.org.accounts.cogs, "-100.0000"],
    ]);
    const total = lines.reduce((acc, l) => acc + Number(l.amount), 0);
    assert.equal(total, 0);
  } finally {
    await dropScratchOrg(ctx.org.orgId);
  }
});

test("a cross-subsidiary contribution is refused with no partial write", { skip: !DB }, async () => {
  const ctx = await setupCtx();
  const documentId = await seedBill(ctx, "BILL-XSUB-1", "100.0000");
  try {
    const sub2 = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${sub2}, ${ctx.org.orgId}, ${ctx.org.subsidiaryId}, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
    await seedPostRule(ctx, {
      key: "xsub",
      impact: "net_zero_pair",
      targets: [{ departmentId: ctx.deptA, subsidiaryId: sub2, fixedPercent: "100.0000" }],
    });
    await assert.rejects(postBill(ctx, documentId), /does not balance/);
    // No partial write: no entry, no lineage, document untouched.
    const probe = (await db.execute<{ entries: number; lineage: number; status: string }>(sql`
      select (select count(*)::int from journal_entries where org_id = ${ctx.org.orgId}) as entries,
             (select count(*)::int from allocation_lineage where org_id = ${ctx.org.orgId}) as lineage,
             (select status from documents where id = ${documentId} and org_id = ${ctx.org.orgId}) as status`)).rows[0]!;
    assert.equal(probe.entries, 0);
    assert.equal(probe.lineage, 0);
    assert.equal(probe.status, "approved");
  } finally {
    await dropScratchOrg(ctx.org.orgId);
  }
});

test("secondary-book rules write a separate allocation entry", { skip: !DB }, async () => {
  const ctx = await setupCtx();
  try {
    const secBook = randomUUID();
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${secBook}, ${ctx.org.orgId}, 'SEC', 'Secondary', false, true, true)`);
    const { versionId } = await seedPostRule(ctx, {
      key: "sec-book",
      impact: "net_zero_pair",
      bookScope: "books",
      bookIds: [secBook],
      targets: [{ departmentId: ctx.deptA, fixedPercent: "100.0000" }],
    });
    const entryId = await postBill(ctx, await seedBill(ctx, "BILL-SEC-1", "100.0000"));
    // The primary entry carries kernel lines only.
    const primary = await entryLines(ctx.org.orgId, entryId);
    assert.equal(primary.length, 2);
    assert.ok(primary.every((l) => l.contributor_kind === null));
    // The secondary entry carries the balanced pair with stamps.
    const secondary = (await db.execute<{ id: string; entry_number: string; origin: string; book_id: string }>(sql`
      select id, entry_number, origin, book_id from journal_entries
       where org_id = ${ctx.org.orgId} and source_document_id is not null
         and id <> ${entryId}`)).rows;
    assert.equal(secondary.length, 1);
    assert.equal(secondary[0]!.origin, "allocation");
    assert.equal(secondary[0]!.book_id, secBook);
    assert.match(secondary[0]!.entry_number, /-ALLOC-SEC$/);
    const secLines = await entryLines(ctx.org.orgId, secondary[0]!.id);
    assert.deepEqual(secLines.map((l) => [l.account_id, l.department_id, l.amount]), [
      [ctx.org.accounts.cogs, ctx.deptA, "100.0000"],
      [ctx.org.accounts.cogs, ctx.deptSrc, "-100.0000"],
    ]);
    assert.ok(secLines.every((l) => l.contributor_kind === "rule" && l.contributor_ref === versionId));
    // Lineage for secondary lines sources the primary kernel line.
    const lineage = (await db.execute<{ journal_entry_id: string; journal_line_id: string; source_journal_line_id: string }>(sql`
      select journal_entry_id, journal_line_id, source_journal_line_id
        from allocation_lineage where org_id = ${ctx.org.orgId} and mode = 'post'`)).rows;
    assert.equal(lineage.length, 2);
    const kernelIds = new Set(primary.map((l) => l.id));
    for (const row of lineage) {
      assert.equal(row.journal_entry_id, secondary[0]!.id);
      assert.ok(kernelIds.has(row.source_journal_line_id));
    }
  } finally {
    await dropScratchOrg(ctx.org.orgId);
  }
});

test("report_only writes lineage rows and no journal lines", { skip: !DB }, async () => {
  const ctx = await setupCtx();
  try {
    await seedPostRule(ctx, {
      key: "stats",
      impact: "report_only",
      targets: [
        { departmentId: ctx.deptA, fixedPercent: "60.0000" },
        { departmentId: ctx.deptB, fixedPercent: "40.0000" },
      ],
    });
    const entryId = await postBill(ctx, await seedBill(ctx, "BILL-STAT-1", "100.0000"));
    const lines = await entryLines(ctx.org.orgId, entryId);
    assert.equal(lines.length, 2);
    const lineage = (await db.execute<{
      journal_entry_id: string;
      journal_line_id: string | null;
      amount: string;
    }>(sql`
      select journal_entry_id, journal_line_id, amount::text
        from allocation_lineage where org_id = ${ctx.org.orgId} and mode = 'post'`)).rows;
    assert.equal(lineage.length, 2);
    assert.deepEqual(lineage.map((r) => r.amount).sort(), ["40.0000", "60.0000"]);
    assert.ok(lineage.every((r) => r.journal_entry_id === entryId && r.journal_line_id === null));
  } finally {
    await dropScratchOrg(ctx.org.orgId);
  }
});

test("feature off contributes nothing and keeps posted data", { skip: !DB }, async () => {
  const ctx = await setupCtx();
  try {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
           || '{"allocations": true, "allocationsAtPosting": false}'::jsonb)
       where id = ${ctx.org.orgId}`);
    await seedPostRule(ctx, {
      key: "gated",
      impact: "net_zero_pair",
      targets: [{ departmentId: ctx.deptA, fixedPercent: "100.0000" }],
    });
    const entryId = await postBill(ctx, await seedBill(ctx, "BILL-GATE-1", "100.0000"));
    const lines = await entryLines(ctx.org.orgId, entryId);
    assert.equal(lines.length, 2);
    const lineage = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from allocation_lineage where org_id = ${ctx.org.orgId}`)).rows[0]!;
    assert.equal(lineage.n, 0);
  } finally {
    await dropScratchOrg(ctx.org.orgId);
  }
});

test("void mirrors contributed lines with their contributor stamps", { skip: !DB }, async () => {
  const ctx = await setupCtx();
  try {
    const { versionId } = await seedPostRule(ctx, {
      key: "void-pair",
      impact: "net_zero_pair",
      targets: [
        { departmentId: ctx.deptA, fixedPercent: "60.0000" },
        { departmentId: ctx.deptB, fixedPercent: "40.0000" },
      ],
    });
    const documentId = await seedBill(ctx, "BILL-VOID-1", "100.0000");
    const entryId = await postBill(ctx, documentId);
    const before = await entryLines(ctx.org.orgId, entryId);
    assert.equal(before.length, 5);
    const result = await requestDocumentVoid({
      documentId,
      orgId: ctx.org.orgId,
      actorId: ctx.actor,
      reason: "allocation void mirror check",
      reversalDate: ctx.org.date,
      source: "api",
    });
    assert.equal(result.status, "voided");
    assert.ok(result.reversalEntryId);
    const after = await entryLines(ctx.org.orgId, result.reversalEntryId!);
    assert.equal(after.length, 5);
    for (let i = 0; i < before.length; i += 1) {
      assert.equal(Number(after[i]!.amount), -Number(before[i]!.amount));
      assert.equal(after[i]!.account_id, before[i]!.account_id);
      assert.equal(after[i]!.contributor_kind, before[i]!.contributor_kind);
      assert.equal(after[i]!.contributor_ref, before[i]!.contributor_ref);
    }
    assert.ok(after.slice(2).every((l) => l.contributor_kind === "rule" && l.contributor_ref === versionId));
  } finally {
    await dropScratchOrg(ctx.org.orgId);
  }
});

test("void reverses secondary-book allocation entries too", { skip: !DB }, async () => {
  const ctx = await setupCtx();
  try {
    const secBook = randomUUID();
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${secBook}, ${ctx.org.orgId}, 'SEC', 'Secondary', false, true, true)`);
    await seedPostRule(ctx, {
      key: "sec-void",
      impact: "net_zero_pair",
      bookScope: "books",
      bookIds: [secBook],
      targets: [{ departmentId: ctx.deptA, fixedPercent: "100.0000" }],
    });
    const documentId = await seedBill(ctx, "BILL-SECV-1", "100.0000");
    await postBill(ctx, documentId);
    const result = await requestDocumentVoid({
      documentId,
      orgId: ctx.org.orgId,
      actorId: ctx.actor,
      reason: "secondary allocation void check",
      reversalDate: ctx.org.date,
      source: "api",
    });
    assert.equal(result.status, "voided");
    const reversed = (await db.execute<{ entry_number: string; origin: string; status: string }>(sql`
      select e.entry_number, e.origin, e.status
        from journal_entries e
       where e.org_id = ${ctx.org.orgId} and e.reverses_entry_id is not null
       order by e.entry_number`)).rows;
    // The primary entry and the secondary allocation entry are both reversed.
    assert.equal(reversed.length, 2);
    assert.ok(reversed.some((r) => r.origin === "allocation" && r.status === "posted"));
    const live = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries
       where org_id = ${ctx.org.orgId} and status = 'posted'`)).rows[0]!;
    assert.equal(live.n, 2);
  } finally {
    await dropScratchOrg(ctx.org.orgId);
  }
});
