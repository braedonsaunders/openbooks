import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { errorChainMatches } from "../testing/error-chain.ts";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { postEntry } from "../journal/post-entry.ts";
import { installEngineSeams } from "../composition/install.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedFlowActors,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  AccountMergeError,
  applyApprovedAccountMerge,
  listAccountMerges,
  previewAccountMerge,
  requestAccountMerge,
} from "./account-merge.ts";
import { classifyAccountReference, discoverAccountReferenceColumns } from "./account-references.ts";
import { closeBookAccountMap, createBookAccountMap, createBookCurrencyVersion } from "../multibook/settings.ts";
import { changeBookReplication } from "../multibook/replication-runs.ts";

// Merging a duplicate account into its survivor: the preview names every
// refusal and consequence, execution moves the balance through the posting
// kernel and the configuration with it, and the merged account refuses
// every later posting and reference. Posted history keeps its account.

const DB = !!process.env.OPENBOOKS_DB_URL;
const EFFECTIVE = "2026-07-31";

interface Scenario {
  org: ScratchOrg;
  actorId: string;
  source: string;
  target: string;
  department: string;
  vendorRole: string;
}

async function enableMerges(orgId: string, enabled = true): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ accountMerges: enabled })}::jsonb)
     where id = ${orgId}`));
}

async function post(org: ScratchOrg, lines: { accountId: string; amount: string; departmentId?: string | null }[], postingDate = org.date) {
  return withOrgContext(org.orgId, () => postEntry(db, {
    orgId: org.orgId,
    bookId: org.bookId,
    subsidiaryId: org.subsidiaryId,
    entryNumber: `T-${randomUUID().slice(0, 8)}`,
    postingDate,
    periodId: org.periodId,
    origin: "manual",
    currency: "CAD",
    lines,
  }));
}

async function scenario(): Promise<Scenario> {
  installEngineSeams();
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  await enableMerges(org.orgId);
  return withBypassContext(async () => {
    const source = await seedPostingAccount(org.orgId, `6100-${randomUUID().slice(0, 4)}`, "Office supplies (duplicate)", "expense");
    const target = await seedPostingAccount(org.orgId, `6000-${randomUUID().slice(0, 4)}`, "Office supplies", "expense");
    const department = randomUUID();
    await db.execute(sql`insert into departments (id, org_id, name) values (${department}, ${org.orgId}, 'Operations')`);
    const vendorRole = randomUUID();
    await db.execute(sql`insert into vendor_roles (id, org_id, party_id, default_expense_account_id)
      values (${vendorRole}, ${org.orgId}, ${org.vendorId}, ${source})`);
    await post(org, [
      { accountId: source, amount: "120.0000", departmentId: department },
      { accountId: org.accounts.bank, amount: "-120.0000" },
    ]);
    await post(org, [
      { accountId: source, amount: "30.0000" },
      { accountId: org.accounts.bank, amount: "-30.0000" },
    ]);
    return { org, actorId: actors.adminId, source, target, department, vendorRole };
  });
}

async function balance(orgId: string, accountId: string): Promise<string> {
  return withBypassContext(async () => (await db.execute<{ total: string }>(sql`
    select coalesce(sum(l.amount), 0)::text as total from journal_lines l
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id and e.status in ('posted', 'reversed')
     where l.org_id = ${orgId} and l.account_id = ${accountId}`)).rows[0]!.total);
}

function request(s: Scenario, overrides: Partial<Parameters<typeof requestAccountMerge>[1]> = {}) {
  return {
    sourceAccountId: s.source,
    targetAccountId: s.target,
    effectiveDate: EFFECTIVE,
    reason: "Duplicate account created by the opening import",
    idempotencyKey: randomUUID(),
    expectedDigest: "",
    actorId: s.actorId,
    allowedSubsidiaryIds: null,
    ...overrides,
  };
}

test("a merge moves the balance by a balanced reclass, moves configuration, and marks the source merged", { skip: !DB }, async () => {
  const s = await scenario();
  try {
    const preview = await previewAccountMerge(s.org.orgId, { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE }, null);
    assert.deepEqual(preview.refusals, []);
    assert.equal(preview.balances.length, 2, "one balance per dimension tuple");
    assert.ok(preview.references.some((ref) => ref.key === "vendor_roles.default_expense_account_id" && ref.redirect === 1));
    const outcome = await requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest }));
    assert.equal(outcome.status, "completed");
    if (outcome.status !== "completed") return;
    assert.equal(outcome.entryIds.length, 1);

    await withBypassContext(async () => {
      const account = (await db.execute<{ is_active: boolean; merged_into_id: string; merge_reason: string }>(sql`
        select is_active, merged_into_id, merge_reason from accounts where org_id = ${s.org.orgId} and id = ${s.source}`)).rows[0]!;
      assert.deepEqual(account, { is_active: false, merged_into_id: s.target, merge_reason: "Duplicate account created by the opening import" });
      const entry = (await db.execute<{ origin: string; posting_date: string; status: string }>(sql`
        select origin, posting_date::text as posting_date, status from journal_entries where org_id = ${s.org.orgId} and id = ${outcome.entryIds[0]}`)).rows[0]!;
      assert.deepEqual(entry, { origin: "account_merge", posting_date: EFFECTIVE, status: "posted" });
      const lines = (await db.execute<{ account_id: string; amount: string; department_id: string | null }>(sql`
        select account_id, amount::text as amount, department_id from journal_lines
         where org_id = ${s.org.orgId} and entry_id = ${outcome.entryIds[0]} order by line_number`)).rows;
      assert.equal(lines.length, 4);
      assert.ok(lines.some((line) => line.account_id === s.target && line.amount === "120.0000" && line.department_id === s.department));
      assert.ok(lines.some((line) => line.account_id === s.source && line.amount === "-120.0000" && line.department_id === s.department));
      // Posted history keeps its account: the original lines were not touched.
      const original = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
         where l.org_id = ${s.org.orgId} and l.account_id = ${s.source} and e.origin = 'manual'`)).rows[0]!.n;
      assert.equal(original, 2);
      const role = (await db.execute<{ default_expense_account_id: string }>(sql`
        select default_expense_account_id from vendor_roles where org_id = ${s.org.orgId} and id = ${s.vendorRole}`)).rows[0]!;
      assert.equal(role.default_expense_account_id, s.target);
      const audits = (await db.execute<{ table_name: string; action: string }>(sql`
        select table_name, action from audit_log where org_id = ${s.org.orgId} and (row_id = ${s.source} or row_id = ${outcome.mergeId})`)).rows;
      assert.ok(audits.some((row) => row.table_name === "accounts" && row.action === "merge"));
      assert.ok(audits.some((row) => row.table_name === "vendor_roles" && row.action === "update"));
    });
    assert.equal(await balance(s.org.orgId, s.source), "0.0000");
    assert.equal(await balance(s.org.orgId, s.target), "150.0000");
    const history = await listAccountMerges(s.org.orgId, { limit: 10, offset: 0, accountId: s.target });
    assert.equal(history.total, 1);
    assert.equal(history.rows[0]!.status, "completed");
  } finally {
    await dropScratchOrg(s.org.orgId);
  }
});

test("a merge preserves dated book mappings and refuses until their window ends before its effective date", { skip: !DB }, async () => {
  const s = await scenario();
  try {
    const bookId = randomUUID();
    await withOrgContext(s.org.orgId, async () => {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,multiBookAccounting}', 'true'::jsonb) where id = ${s.org.orgId}`);
      await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
        values (${bookId}, ${s.org.orgId}, 'LOCAL', 'Local reporting', false, true, true)`);
    });
    const mapping = await createBookAccountMap({ orgId: s.org.orgId, actorId: s.actorId, allowedSubsidiaryIds: null,
      input: { bookId, sourceAccountId: s.source, targetAccountId: s.target, effectiveFrom: "2026-07-01", effectiveTo: EFFECTIVE },
      reason: "Map expenses for local reporting" });
    const input = { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE };
    const blocked = await previewAccountMerge(s.org.orgId, input, null);
    assert.ok(blocked.refusals.some(row => row.code === "reference_in_flight" && /mapping/.test(row.message)));
    assert.ok(blocked.references.some(row => row.key === "accounting_book_account_maps.source_account_id" && row.blocked === 1 && row.redirect === 0));
    await closeBookAccountMap({ orgId: s.org.orgId, actorId: s.actorId, allowedSubsidiaryIds: null,
      id: mapping.id, effectiveTo: "2026-07-30", reason: "End mapping before the account merge" });
    const preview = await previewAccountMerge(s.org.orgId, input, null);
    assert.deepEqual(preview.refusals, []);
    assert.ok(preview.references.some(row => row.key === "accounting_book_account_maps.source_account_id" && row.history === 1));
    assert.equal((await requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest }))).status, "completed");
    await withOrgContext(s.org.orgId, async () => {
      const saved = (await db.execute<{ source_account_id: string; target_account_id: string; effective_to: string }>(sql`
        select source_account_id, target_account_id, effective_to::text as effective_to
        from accounting_book_account_maps where org_id = ${s.org.orgId} and id = ${mapping.id}`)).rows[0];
      assert.deepEqual(saved, { source_account_id: s.source, target_account_id: s.target, effective_to: "2026-07-30" });
    });
  } finally { await dropScratchOrg(s.org.orgId); }
});

test("active capitalization rules block a merge and inactive rules retain their source account", { skip: !DB }, async () => {
  const s = await scenario();
  try {
    const ruleId = randomUUID();
    await withOrgContext(s.org.orgId, () => db.execute(sql`
      insert into asset_capitalization_rules (id, org_id, name, match_kind, account_id, effective_from)
      values (${ruleId}, ${s.org.orgId}, 'Capital purchases', 'account', ${s.source}, '2026-07-01')`));
    const input = { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE };
    const blocked = await previewAccountMerge(s.org.orgId, input, null);
    assert.ok(blocked.refusals.some(row => row.code === "reference_in_flight" && /capitalization/.test(row.message)));
    await withOrgContext(s.org.orgId, () => db.execute(sql`
      update asset_capitalization_rules set is_active = false, effective_to = '2026-07-30'
      where org_id = ${s.org.orgId} and id = ${ruleId}`));
    const preview = await previewAccountMerge(s.org.orgId, input, null);
    assert.deepEqual(preview.refusals, []);
    assert.equal((await requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest }))).status, "completed");
    await withOrgContext(s.org.orgId, async () => {
      const saved = (await db.execute<{ account_id: string }>(sql`
        select account_id from asset_capitalization_rules where org_id = ${s.org.orgId} and id = ${ruleId}`)).rows[0];
      assert.equal(saved?.account_id, s.source);
    });
  } finally { await dropScratchOrg(s.org.orgId); }
});

test("a merge reclasses each book's recorded balance once at its recorded exchange rate", { skip: !DB }, async () => {
  const s = await scenario();
  try {
    const bookId = randomUUID();
    await withOrgContext(s.org.orgId, async () => {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,multiBookAccounting}', 'true'::jsonb) where id = ${s.org.orgId}`);
      await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
        values (${bookId}, ${s.org.orgId}, 'GAAP', 'GAAP', false, true, true)`);
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
        values (${s.org.orgId}, 'CAD', 'EUR', '2026-07-01', 'spot', '0.68'),
               (${s.org.orgId}, 'CAD', 'EUR', '2026-07-31', 'spot', '0.91')`);
    });
    await createBookCurrencyVersion({ orgId: s.org.orgId, actorId: s.actorId, allowedSubsidiaryIds: null,
      input: { bookId, subsidiaryId: s.org.subsidiaryId, currency: "EUR", rateType: "spot", effectiveFrom: "2026-07-01" }, reason: "Report the secondary book in euros" });
    await changeBookReplication({ orgId: s.org.orgId, actorId: s.actorId, allowedSubsidiaryIds: null,
      input: { bookId, kind: "activation", replicationFrom: "2026-07-01", openingStrategy: "full_history" }, reason: "Bring the secondary book into operation" });
    const preview = await previewAccountMerge(s.org.orgId, { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE }, null);
    assert.deepEqual(preview.refusals, []);
    assert.equal(preview.balances.length, 4);
    assert.ok(preview.balances.filter(row => row.bookId === bookId).every(row => row.functionalCurrency === "EUR"));
    const outcome = await requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest }));
    assert.equal(outcome.status, "completed");
    if (outcome.status !== "completed") return;
    assert.equal(outcome.entryIds.length, 2, "one reclass per book, with no extra replicated reclass");
    await withOrgContext(s.org.orgId, async () => {
      const balances = (await db.execute<{ book_id: string; account_id: string; amount: string }>(sql`
        select e.book_id, l.account_id, sum(l.amount)::text as amount from journal_lines l
        join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
        where e.org_id = ${s.org.orgId} and e.status in ('posted', 'reversed') and l.account_id in (${s.source}, ${s.target})
        group by e.book_id, l.account_id`)).rows;
      assert.equal(balances.find(row => row.book_id === s.org.bookId && row.account_id === s.target)?.amount, "150.0000");
      assert.equal(balances.find(row => row.book_id === bookId && row.account_id === s.target)?.amount, "102.0000");
      assert.ok(balances.filter(row => row.account_id === s.source).every(row => row.amount === "0.0000"));
      const copies = (await db.execute<{ count: number }>(sql`select count(*)::int as count from journal_entries
        where org_id = ${s.org.orgId} and origin = 'account_merge'`)).rows[0]!;
      assert.equal(copies.count, 2);
    });
  } finally {
    await dropScratchOrg(s.org.orgId);
  }
});

test("a retried merge returns the same record, and a stale preview is refused", { skip: !DB }, async () => {
  const s = await scenario();
  try {
    const preview = await previewAccountMerge(s.org.orgId, { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE }, null);
    await assert.rejects(
      requestAccountMerge(s.org.orgId, request(s, { expectedDigest: "0".repeat(64) })),
      (error: unknown) => error instanceof AccountMergeError && error.code === "account_merge_preview_changed" && error.status === 409,
    );
    const key = randomUUID();
    const first = await requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest, idempotencyKey: key }));
    const again = await requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest, idempotencyKey: key }));
    assert.equal(first.status, "completed");
    assert.equal(again.status, "completed");
    if (first.status !== "completed" || again.status !== "completed") return;
    assert.equal(again.mergeId, first.mergeId);
    assert.equal(again.replayed, true);
    const entries = await withBypassContext(async () => (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where org_id = ${s.org.orgId} and origin = 'account_merge'`)).rows[0]!.n);
    assert.equal(entries, 1, "a retry posts nothing twice");
  } finally {
    await dropScratchOrg(s.org.orgId);
  }
});

test("concurrent merges of one account produce exactly one merge and one reclass", { skip: !DB }, async () => {
  const s = await scenario();
  try {
    const preview = await previewAccountMerge(s.org.orgId, { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE }, null);
    const results = await Promise.allSettled([
      requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest })),
      requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest })),
    ]);
    assert.ok(results.some((result) => result.status === "fulfilled"));
    await withBypassContext(async () => {
      const merges = (await db.execute<{ n: number }>(sql`select count(*)::int as n from account_merges where org_id = ${s.org.orgId}`)).rows[0]!.n;
      const reclasses = (await db.execute<{ n: number }>(sql`select count(*)::int as n from journal_entries where org_id = ${s.org.orgId} and origin = 'account_merge'`)).rows[0]!.n;
      assert.equal(merges, 1);
      assert.equal(reclasses, 1);
    });
    assert.equal(await balance(s.org.orgId, s.source), "0.0000");
  } finally {
    await dropScratchOrg(s.org.orgId);
  }
});

test("the preview refuses incompatible survivors and late postings, naming the remedy", { skip: !DB }, async () => {
  const s = await scenario();
  try {
    const income = await withBypassContext(() => seedPostingAccount(s.org.orgId, `4000-${randomUUID().slice(0, 4)}`, "Sales", "income"));
    const typed = await previewAccountMerge(s.org.orgId, { sourceAccountId: s.source, targetAccountId: income, effectiveDate: EFFECTIVE }, null);
    assert.ok(typed.refusals.some((refusal) => refusal.code === "type_mismatch" && refusal.remedy.length > 0));

    const early = await previewAccountMerge(s.org.orgId, { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: "2026-07-10" }, null);
    assert.ok(early.refusals.some((refusal) => refusal.code === "postings_after_date"));

    await withBypassContext(() => db.execute(sql`update accounts set is_active = false where org_id = ${s.org.orgId} and id = ${s.target}`));
    const inactive = await previewAccountMerge(s.org.orgId, { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE }, null);
    assert.ok(inactive.refusals.some((refusal) => refusal.code === "target_inactive"));
    await assert.rejects(
      requestAccountMerge(s.org.orgId, request(s, { expectedDigest: inactive.digest })),
      (error: unknown) => error instanceof AccountMergeError && error.code === "target_inactive",
    );
    await assert.rejects(
      previewAccountMerge(s.org.orgId, { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE }, new Set([s.org.subsidiaryId])),
      (error: unknown) => error instanceof AccountMergeError && error.code === "account_merge_scope",
    );
  } finally {
    await dropScratchOrg(s.org.orgId);
  }
});

test("a merged account refuses new postings, new references and reactivation", { skip: !DB }, async () => {
  const s = await scenario();
  try {
    const preview = await previewAccountMerge(s.org.orgId, { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE }, null);
    await requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest }));
    await assert.rejects(
      withBypassContext(() => post(s.org, [{ accountId: s.source, amount: "5.0000" }, { accountId: s.org.accounts.bank, amount: "-5.0000" }], EFFECTIVE)),
      /was merged into/,
    );
    await assert.rejects(
      withBypassContext(() => db.execute(sql`update vendor_roles set default_expense_account_id = ${s.source} where org_id = ${s.org.orgId} and id = ${s.vendorRole}`)),
      (error: unknown) => errorChainMatches(error, /was merged into account/),
    );
    await assert.rejects(
      withBypassContext(() => db.execute(sql`update accounts set is_active = true where org_id = ${s.org.orgId} and id = ${s.source}`)),
      (error: unknown) => errorChainMatches(error, /cannot be reactivated/),
    );
    await assert.rejects(
      withBypassContext(() => db.execute(sql`update account_merges set reason = 'Rewritten reason text' where org_id = ${s.org.orgId}`)),
      (error: unknown) => errorChainMatches(error, /permanent history/),
    );
  } finally {
    await dropScratchOrg(s.org.orgId);
  }
});

test("merges are confined to their organization and to the feature switch", { skip: !DB }, async () => {
  const s = await scenario();
  const other = await createScratchOrg();
  try {
    await enableMerges(other.orgId);
    await assert.rejects(
      previewAccountMerge(other.orgId, { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE }, null),
      (error: unknown) => error instanceof AccountMergeError && error.status === 404,
    );
    await assert.rejects(
      previewAccountMerge(s.org.orgId, { sourceAccountId: s.source, targetAccountId: other.accounts.cogs, effectiveDate: EFFECTIVE }, null),
      (error: unknown) => error instanceof AccountMergeError && error.status === 404,
    );
    await enableMerges(s.org.orgId, false);
    await assert.rejects(
      previewAccountMerge(s.org.orgId, { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE }, null),
      (error: unknown) => error instanceof AccountMergeError && error.code === "feature_disabled",
    );
  } finally {
    await dropScratchOrg(other.orgId);
    await dropScratchOrg(s.org.orgId);
  }
});

test("with an Accounting event flow a merge is proposed, approved, then applied against its preview", { skip: !DB }, async () => {
  const s = await scenario();
  try {
    const actors = await seedFlowActors(s.org.orgId);
    await withBypassContext(() => seedApprovalFlow(s.org.orgId, {
      subjectKind: "financial_change",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    }));
    const preview = await previewAccountMerge(s.org.orgId, { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE }, null);
    assert.equal(preview.approvalRequired, true);
    const proposed = await requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest }));
    assert.equal(proposed.status, "pending_approval");
    if (proposed.status !== "pending_approval") return;
    assert.equal(await balance(s.org.orgId, s.source), "150.0000", "nothing moves before approval");
    await assert.rejects(
      applyApprovedAccountMerge(s.org.orgId, { changeId: proposed.changeId, actorId: s.actorId, allowedSubsidiaryIds: null }),
      /approval|Flows/i,
    );
    await withBypassContext(() => db.execute(sql`
      update financial_changes set status = 'approved', approved_by = ${actors.approver1Id}, approved_at = now()
       where org_id = ${s.org.orgId} and id = ${proposed.changeId}`));
    const applied = await applyApprovedAccountMerge(s.org.orgId, { changeId: proposed.changeId, actorId: s.actorId, allowedSubsidiaryIds: null });
    assert.equal(applied.status, "completed");
    assert.equal(await balance(s.org.orgId, s.source), "0.0000");
    const change = await withBypassContext(async () => (await db.execute<{ status: string }>(sql`
      select status from financial_changes where org_id = ${s.org.orgId} and id = ${proposed.changeId}`)).rows[0]!.status);
    assert.equal(change, "applied");
  } finally {
    await dropScratchOrg(s.org.orgId);
  }
});

test("every live foreign key into accounts is classified and guarded against merged-account references", { skip: !DB }, async () => {
  await withBypassContext(async () => {
    const columns = await discoverAccountReferenceColumns(db);
    assert.ok(columns.length > 50);
    const unclassified = columns.filter((column) => classifyAccountReference(column) === null);
    assert.deepEqual(unclassified, []);
    const guarded = new Set((await db.execute<{ table_name: string }>(sql`
      select c.relname::text as table_name from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal and t.tgname like '%merged_account_guard'`)).rows.map((row) => row.table_name));
    const unguarded = columns
      .filter((column) => classifyAccountReference(column) !== "owned")
      .filter((column) => !guarded.has(column.table))
      .map((column) => `${column.table}.${column.column}`);
    assert.deepEqual(unguarded, [], "every table referencing accounts refuses new references to merged accounts");
  });
});
