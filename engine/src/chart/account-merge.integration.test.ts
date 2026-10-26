import { decideGate } from "../flows/gates.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { errorChainMatches } from "../testing/error-chain.ts";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { postEntry } from "../journal/post-entry.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import { installEngineSeams } from "../composition/install.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  dropScratchOrgReporting,
  seedApprovalFlow,
  grantScratchPermissions,
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
import {
  closeBookAccountMap,
  createBookAccountMap,
  createBookCurrencyVersion,
} from "../multibook/settings.ts";
import { changeBookReplication } from "../multibook/replication-runs.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "../sandbox/lifecycle.ts";

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
  await withBypassContext(() =>
    db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ accountMerges: enabled })}::jsonb)
     where id = ${orgId}`),
  );
}

async function post(
  org: ScratchOrg,
  lines: { accountId: string; amount: string; departmentId?: string | null }[],
  postingDate = org.date,
  periodId = org.periodId,
) {
  return withOrgContext(org.orgId, () =>
    postEntry(db, {
      orgId: org.orgId,
      bookId: org.bookId,
      subsidiaryId: org.subsidiaryId,
      entryNumber: `T-${randomUUID().slice(0, 8)}`,
      postingDate,
      periodId,
      origin: "manual",
      currency: "CAD",
      lines,
    }),
  );
}

async function scenario(options: { seedBalances?: boolean } = {}): Promise<Scenario> {
  installEngineSeams();
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  await enableMerges(org.orgId);
  return withBypassContext(async () => {
    const source = await seedPostingAccount(
      org.orgId,
      `6100-${randomUUID().slice(0, 4)}`,
      "Office supplies (duplicate)",
      "expense",
    );
    const target = await seedPostingAccount(
      org.orgId,
      `6000-${randomUUID().slice(0, 4)}`,
      "Office supplies",
      "expense",
    );
    const department = randomUUID();
    await db.execute(
      sql`insert into departments (id, org_id, name) values (${department}, ${org.orgId}, 'Operations')`,
    );
    const vendorRole = randomUUID();
    await db.execute(sql`insert into vendor_roles (id, org_id, party_id, default_expense_account_id)
      values (${vendorRole}, ${org.orgId}, ${org.vendorId}, ${source})`);
    if (options.seedBalances !== false) {
      await post(org, [
        { accountId: source, amount: "120.0000", departmentId: department },
        { accountId: org.accounts.bank, amount: "-120.0000" },
      ]);
      await post(org, [
        { accountId: source, amount: "30.0000" },
        { accountId: org.accounts.bank, amount: "-30.0000" },
      ]);
    }
    return { org, actorId: actors.adminId, source, target, department, vendorRole };
  });
}

async function balance(orgId: string, accountId: string): Promise<string> {
  return withBypassContext(
    async () =>
      (
        await db.execute<{ total: string }>(
          sql`
    select coalesce(sum(l.amount), 0)::text as total from journal_lines l
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id and e.status in ('posted', 'reversed')
     where l.org_id = ${orgId} and l.account_id = ${accountId}`,
          "objects",
        )
      )[0]!.total,
  );
}

function request(
  s: Pick<Scenario, "source" | "target" | "actorId">,
  overrides: Partial<Parameters<typeof requestAccountMerge>[1]> = {},
) {
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

async function camPool(
  s: Scenario,
  status: "open" | "finalized" | "invoiced",
  expenseAccountIds: string[],
): Promise<string> {
  const propertyId = randomUUID();
  const poolId = randomUUID();
  await withOrgContext(s.org.orgId, async () => {
    await db.execute(sql`insert into managed_properties(id,org_id,subsidiary_id,code,name,property_type,currency)
      values(${propertyId},${s.org.orgId},${s.org.subsidiaryId},${`MERGE-${propertyId.slice(0, 8)}`},'Merge test property','commercial','CAD')`);
    await db.execute(sql`insert into cam_pools(id,org_id,property_id,name,fiscal_year,period_starts_on,period_ends_on,
      expense_account_ids,status,actual_amount)
      values(${poolId},${s.org.orgId},${propertyId},'Merge test pool',2026,'2026-07-01','2026-07-31',
        ${JSON.stringify(expenseAccountIds)}::jsonb,${status},${status === "open" ? null : "100.0000"})`);
  });
  return poolId;
}

test(
  "P&L merge balances and period locks follow each subsidiary's fiscal calendar",
  { skip: !DB },
  async () => {
    const s = await scenario({ seedBalances: false });
    try {
      const januaryPeriod = randomUUID();
      const marchPeriod = randomUUID();
      const entityCalendar = randomUUID();
      const entityPeriods = [
        { id: randomUUID(), month: 4, name: "2026-04", start: "2026-04-01", end: "2026-04-30" },
        { id: randomUUID(), month: 5, name: "2026-05", start: "2026-05-01", end: "2026-05-31" },
        { id: randomUUID(), month: 6, name: "2026-06", start: "2026-06-01", end: "2026-06-30" },
        { id: randomUUID(), month: 7, name: "2026-07", start: "2026-07-01", end: "2026-07-31" },
      ];
      const defaultCalendar = (
        await db.execute<{ id: string }>(
          sql`
      select fiscal_calendar_id as id from accounting_periods where org_id=${s.org.orgId} and id=${s.org.periodId}`,
          "objects",
        )
      )[0]!.id;
      await withOrgContext(s.org.orgId, async () => {
        await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on)
        values(${januaryPeriod},${s.org.orgId},${defaultCalendar},2026,1,'2026-01','2026-01-01','2026-01-31'),
              (${marchPeriod},${s.org.orgId},${defaultCalendar},2026,3,'2026-03','2026-03-01','2026-03-31')`);
        await postEntry(db, {
          orgId: s.org.orgId,
          bookId: s.org.bookId,
          subsidiaryId: s.org.subsidiaryId,
          entryNumber: `PRE-FY-${randomUUID().slice(0, 8)}`,
          postingDate: "2026-01-15",
          periodId: januaryPeriod,
          origin: "manual",
          currency: "CAD",
          lines: [
            { accountId: s.source, amount: "500" },
            { accountId: s.org.accounts.bank, amount: "-500" },
          ],
        });
        await postEntry(db, {
          orgId: s.org.orgId,
          bookId: s.org.bookId,
          subsidiaryId: s.org.subsidiaryId,
          entryNumber: `PRE-FY-${randomUUID().slice(0, 8)}`,
          postingDate: "2026-03-15",
          periodId: marchPeriod,
          origin: "manual",
          currency: "CAD",
          lines: [
            { accountId: s.source, amount: "300" },
            { accountId: s.org.accounts.bank, amount: "-300" },
          ],
        });
        await db.execute(sql`insert into fiscal_calendars(id,org_id,name,year_start_month,is_default,is_active)
        values(${entityCalendar},${s.org.orgId},'April fiscal year',4,false,true)`);
        for (const period of entityPeriods) {
          await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on)
          values(${period.id},${s.org.orgId},${entityCalendar},2027,${period.month - 3},${period.name},${period.start},${period.end})`);
        }
        await db.execute(sql`insert into subsidiary_accounting_preferences
        (org_id,subsidiary_id,effective_from,fiscal_calendar_id,reason,created_by)
        values(${s.org.orgId},${s.org.subsidiaryId},'2026-04-01',${entityCalendar},'April fiscal-year calendar',${s.actorId})`);
      });

      await post(
        s.org,
        [
          { accountId: s.source, amount: "120.0000", departmentId: s.department },
          { accountId: s.org.accounts.bank, amount: "-120.0000" },
        ],
        "2026-07-15",
        entityPeriods[3]!.id,
      );
      await post(
        s.org,
        [
          { accountId: s.source, amount: "30.0000" },
          { accountId: s.org.accounts.bank, amount: "-30.0000" },
        ],
        "2026-07-15",
        entityPeriods[3]!.id,
      );

      const requestInput = {
        sourceAccountId: s.source,
        targetAccountId: s.target,
        effectiveDate: EFFECTIVE,
      };
      const open = await previewAccountMerge(s.org.orgId, requestInput, null);
      assert.deepEqual(open.refusals, []);
      assert.equal(open.balanceFrom, "2026-04-01");
      assert.deepEqual(open.balances.map((row) => row.amount).sort(), ["120.0000", "30.0000"]);

      await setPeriodLockState({
        orgId: s.org.orgId,
        periodId: entityPeriods[3]!.id,
        bookId: s.org.bookId,
        subsidiaryId: s.org.subsidiaryId,
        module: "gl",
        state: "closed",
        actorId: s.actorId,
        reason: "Close the entity fiscal period",
      });
      const closed = await previewAccountMerge(s.org.orgId, requestInput, null);
      assert.ok(closed.refusals.some((refusal) => refusal.code === "period_closed"));
      assert.deepEqual(closed.balances.map((row) => row.amount).sort(), ["120.0000", "30.0000"]);
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "account merge deduplicates editable CAM account arrays and blocks sealed pools",
  { skip: !DB },
  async () => {
    const editable = await scenario();
    const sealed = await scenario();
    try {
      const editablePoolId = await camPool(editable, "open", [editable.source, editable.target]);
      const preview = await previewAccountMerge(
        editable.org.orgId,
        {
          sourceAccountId: editable.source,
          targetAccountId: editable.target,
          effectiveDate: EFFECTIVE,
        },
        null,
      );
      assert.deepEqual(preview.refusals, []);
      assert.ok(
        preview.references.some(
          (ref) => ref.key === "cam_pools.expense_account_ids" && ref.redirect === 1,
        ),
      );
      const outcome = await requestAccountMerge(
        editable.org.orgId,
        request(editable, { expectedDigest: preview.digest }),
      );
      assert.equal(outcome.status, "completed");
      const saved = (
        await db.execute<{ expense_account_ids: string[] }>(
          sql`
      select expense_account_ids from cam_pools where org_id=${editable.org.orgId} and id=${editablePoolId}`,
          "objects",
        )
      )[0];
      assert.deepEqual(saved?.expense_account_ids, [editable.target]);

      const finalizedPool = await camPool(sealed, "finalized", [sealed.source]);
      const invoicedPool = await camPool(sealed, "invoiced", [sealed.source]);
      const blocked = await previewAccountMerge(
        sealed.org.orgId,
        {
          sourceAccountId: sealed.source,
          targetAccountId: sealed.target,
          effectiveDate: EFFECTIVE,
        },
        null,
      );
      assert.ok(blocked.refusals.some((refusal) => refusal.code === "reference_in_flight"));
      assert.ok(
        blocked.references.some(
          (ref) =>
            ref.key === "cam_pools.expense_account_ids" && ref.blocked === 2 && ref.redirect === 0,
        ),
      );
      const preserved = await db.execute<{ id: string; expense_account_ids: string[] }>(
        sql`
      select id,expense_account_ids from cam_pools where org_id=${sealed.org.orgId}
        and id in (${finalizedPool},${invoicedPool}) order by id`,
        "objects",
      );
      assert.deepEqual(
        preserved.map((row) => row.expense_account_ids),
        [[sealed.source], [sealed.source]],
      );
    } finally {
      await dropScratchOrg(editable.org.orgId);
      await dropScratchOrg(sealed.org.orgId);
    }
  },
);

test(
  "a merge moves the balance by a balanced reclass, moves configuration, and marks the source merged",
  { skip: !DB },
  async () => {
    const s = await scenario();
    try {
      const preview = await previewAccountMerge(
        s.org.orgId,
        { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE },
        null,
      );
      assert.deepEqual(preview.refusals, []);
      assert.equal(preview.balances.length, 2, "one balance per dimension tuple");
      assert.ok(
        preview.references.some(
          (ref) => ref.key === "vendor_roles.default_expense_account_id" && ref.redirect === 1,
        ),
      );
      const outcome = await requestAccountMerge(
        s.org.orgId,
        request(s, { expectedDigest: preview.digest }),
      );
      assert.equal(outcome.status, "completed");
      if (outcome.status !== "completed") return;
      assert.equal(outcome.entryIds.length, 1);

      await withBypassContext(async () => {
        const account = (
          await db.execute<{ is_active: boolean; merged_into_id: string; merge_reason: string }>(
            sql`
        select is_active, merged_into_id, merge_reason from accounts where org_id = ${s.org.orgId} and id = ${s.source}`,
            "objects",
          )
        )[0]!;
        assert.deepEqual(account, {
          is_active: false,
          merged_into_id: s.target,
          merge_reason: "Duplicate account created by the opening import",
        });
        const entry = (
          await db.execute<{ origin: string; posting_date: string; status: string }>(
            sql`
        select origin, posting_date::text as posting_date, status from journal_entries where org_id = ${s.org.orgId} and id = ${outcome.entryIds[0]}`,
            "objects",
          )
        )[0]!;
        assert.deepEqual(entry, {
          origin: "account_merge",
          posting_date: EFFECTIVE,
          status: "posted",
        });
        const lines = await db.execute<{
          account_id: string;
          amount: string;
          department_id: string | null;
        }>(
          sql`
        select account_id, amount::text as amount, department_id from journal_lines
         where org_id = ${s.org.orgId} and entry_id = ${outcome.entryIds[0]} order by line_number`,
          "objects",
        );
        assert.equal(lines.length, 4);
        assert.ok(
          lines.some(
            (line) =>
              line.account_id === s.target &&
              line.amount === "120.0000" &&
              line.department_id === s.department,
          ),
        );
        assert.ok(
          lines.some(
            (line) =>
              line.account_id === s.source &&
              line.amount === "-120.0000" &&
              line.department_id === s.department,
          ),
        );
        // Posted history keeps its account: the original lines were not touched.
        const original = (
          await db.execute<{ n: number }>(
            sql`
        select count(*)::int as n from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
         where l.org_id = ${s.org.orgId} and l.account_id = ${s.source} and e.origin = 'manual'`,
            "objects",
          )
        )[0]!.n;
        assert.equal(original, 2);
        const role = (
          await db.execute<{ default_expense_account_id: string }>(
            sql`
        select default_expense_account_id from vendor_roles where org_id = ${s.org.orgId} and id = ${s.vendorRole}`,
            "objects",
          )
        )[0]!;
        assert.equal(role.default_expense_account_id, s.target);
        const audits = await db.execute<{ table_name: string; action: string }>(
          sql`
        select table_name, action from audit_log where org_id = ${s.org.orgId} and (row_id = ${s.source} or row_id = ${outcome.mergeId})`,
          "objects",
        );
        assert.ok(audits.some((row) => row.table_name === "accounts" && row.action === "merge"));
        assert.ok(
          audits.some((row) => row.table_name === "vendor_roles" && row.action === "update"),
        );
      });
      assert.equal(await balance(s.org.orgId, s.source), "0.0000");
      assert.equal(await balance(s.org.orgId, s.target), "150.0000");
      const history = await listAccountMerges(s.org.orgId, {
        limit: 10,
        offset: 0,
        accountId: s.target,
      });
      assert.equal(history.total, 1);
      assert.equal(history.rows[0]!.status, "completed");

      const outOfScopeSubsidiary = randomUUID();
      await withOrgContext(s.org.orgId, async () => {
        await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${outOfScopeSubsidiary}, ${s.org.orgId}, ${s.org.subsidiaryId}, 'Merge history entity', 'CAD', 'CA')`);
        await db.execute(sql`update accounts set subsidiary_id = ${outOfScopeSubsidiary}
        where org_id = ${s.org.orgId} and id in (${s.source}, ${s.target})`);
      });
      const restrictedHistory = await listAccountMerges(
        s.org.orgId,
        { limit: 10, offset: 0 },
        new Set([s.org.subsidiaryId]),
      );
      assert.equal(
        restrictedHistory.total,
        0,
        "a merge is hidden when either account is outside the caller's scope",
      );
      assert.deepEqual(restrictedHistory.rows, []);
      const visibleHistory = await listAccountMerges(
        s.org.orgId,
        { limit: 10, offset: 0 },
        new Set([outOfScopeSubsidiary]),
      );
      assert.equal(visibleHistory.total, 1);
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "a merge preserves dated book mappings and refuses until their window ends before its effective date",
  { skip: !DB },
  async () => {
    const s = await scenario();
    try {
      const bookId = randomUUID();
      await withOrgContext(s.org.orgId, async () => {
        await db.execute(
          sql`update orgs set settings = jsonb_set(settings, '{features,multiBookAccounting}', 'true'::jsonb) where id = ${s.org.orgId}`,
        );
        await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
        values (${bookId}, ${s.org.orgId}, 'LOCAL', 'Local reporting', false, true, true)`);
      });
      const mapping = await createBookAccountMap({
        orgId: s.org.orgId,
        actorId: s.actorId,
        allowedSubsidiaryIds: null,
        input: {
          bookId,
          sourceAccountId: s.source,
          targetAccountId: s.target,
          effectiveFrom: "2026-07-01",
          effectiveTo: EFFECTIVE,
        },
        reason: "Map expenses for local reporting",
      });
      const input = {
        sourceAccountId: s.source,
        targetAccountId: s.target,
        effectiveDate: EFFECTIVE,
      };
      const blocked = await previewAccountMerge(s.org.orgId, input, null);
      assert.ok(
        blocked.refusals.some(
          (row) => row.code === "reference_in_flight" && /mapping/.test(row.message),
        ),
      );
      assert.ok(
        blocked.references.some(
          (row) =>
            row.key === "accounting_book_account_maps.source_account_id" &&
            row.blocked === 1 &&
            row.redirect === 0,
        ),
      );
      await closeBookAccountMap({
        orgId: s.org.orgId,
        actorId: s.actorId,
        allowedSubsidiaryIds: null,
        id: mapping.id,
        effectiveTo: "2026-07-30",
        reason: "End mapping before the account merge",
      });
      const preview = await previewAccountMerge(s.org.orgId, input, null);
      assert.deepEqual(preview.refusals, []);
      assert.ok(
        preview.references.some(
          (row) =>
            row.key === "accounting_book_account_maps.source_account_id" && row.history === 1,
        ),
      );
      assert.equal(
        (await requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest })))
          .status,
        "completed",
      );
      await withOrgContext(s.org.orgId, async () => {
        const saved = (
          await db.execute<{
            source_account_id: string;
            target_account_id: string;
            effective_to: string;
          }>(
            sql`
        select source_account_id, target_account_id, effective_to::text as effective_to
        from accounting_book_account_maps where org_id = ${s.org.orgId} and id = ${mapping.id}`,
            "objects",
          )
        )[0];
        assert.deepEqual(saved, {
          source_account_id: s.source,
          target_account_id: s.target,
          effective_to: "2026-07-30",
        });
      });
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "active capitalization rules block a merge and inactive rules retain their source account",
  { skip: !DB },
  async () => {
    const s = await scenario();
    try {
      const ruleId = randomUUID();
      await withOrgContext(s.org.orgId, () =>
        db.execute(sql`
      insert into asset_capitalization_rules (id, org_id, name, match_kind, account_id, effective_from)
      values (${ruleId}, ${s.org.orgId}, 'Capital purchases', 'account', ${s.source}, '2026-07-01')`),
      );
      const input = {
        sourceAccountId: s.source,
        targetAccountId: s.target,
        effectiveDate: EFFECTIVE,
      };
      const blocked = await previewAccountMerge(s.org.orgId, input, null);
      assert.ok(
        blocked.refusals.some(
          (row) => row.code === "reference_in_flight" && /capitalization/.test(row.message),
        ),
      );
      await withOrgContext(s.org.orgId, () =>
        db.execute(sql`
      update asset_capitalization_rules set is_active = false, effective_to = '2026-07-30'
      where org_id = ${s.org.orgId} and id = ${ruleId}`),
      );
      const preview = await previewAccountMerge(s.org.orgId, input, null);
      assert.deepEqual(preview.refusals, []);
      assert.equal(
        (await requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest })))
          .status,
        "completed",
      );
      await withOrgContext(s.org.orgId, async () => {
        const saved = (
          await db.execute<{ account_id: string }>(
            sql`
        select account_id from asset_capitalization_rules where org_id = ${s.org.orgId} and id = ${ruleId}`,
            "objects",
          )
        )[0];
        assert.equal(saved?.account_id, s.source);
      });
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "a merge reclasses each book's recorded balance once at its recorded exchange rate",
  { skip: !DB },
  async () => {
    const s = await scenario();
    try {
      const bookId = randomUUID();
      await withOrgContext(s.org.orgId, async () => {
        await db.execute(
          sql`update orgs set settings = jsonb_set(settings, '{features,multiBookAccounting}', 'true'::jsonb) where id = ${s.org.orgId}`,
        );
        await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
        values (${bookId}, ${s.org.orgId}, 'GAAP', 'GAAP', false, true, true)`);
        await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
        values (${s.org.orgId}, 'CAD', 'EUR', '2026-07-01', 'spot', '0.68'),
               (${s.org.orgId}, 'CAD', 'EUR', '2026-07-31', 'spot', '0.91')`);
      });
      await createBookCurrencyVersion({
        orgId: s.org.orgId,
        actorId: s.actorId,
        allowedSubsidiaryIds: null,
        input: {
          bookId,
          subsidiaryId: s.org.subsidiaryId,
          currency: "EUR",
          rateType: "spot",
          effectiveFrom: "2026-07-01",
        },
        reason: "Report the secondary book in euros",
      });
      await changeBookReplication({
        orgId: s.org.orgId,
        actorId: s.actorId,
        allowedSubsidiaryIds: null,
        input: {
          bookId,
          kind: "activation",
          replicationFrom: "2026-07-01",
          openingStrategy: "full_history",
        },
        reason: "Bring the secondary book into operation",
      });
      const preview = await previewAccountMerge(
        s.org.orgId,
        { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE },
        null,
      );
      assert.deepEqual(preview.refusals, []);
      assert.equal(preview.balances.length, 4);
      assert.ok(
        preview.balances
          .filter((row) => row.bookId === bookId)
          .every((row) => row.functionalCurrency === "EUR"),
      );
      const outcome = await requestAccountMerge(
        s.org.orgId,
        request(s, { expectedDigest: preview.digest }),
      );
      assert.equal(outcome.status, "completed");
      if (outcome.status !== "completed") return;
      assert.equal(
        outcome.entryIds.length,
        2,
        "one reclass per book, with no extra replicated reclass",
      );
      await withOrgContext(s.org.orgId, async () => {
        const balances = await db.execute<{ book_id: string; account_id: string; amount: string }>(
          sql`
        select e.book_id, l.account_id, sum(l.amount)::text as amount from journal_lines l
        join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
        where e.org_id = ${s.org.orgId} and e.status in ('posted', 'reversed') and l.account_id in (${s.source}, ${s.target})
        group by e.book_id, l.account_id`,
          "objects",
        );
        assert.equal(
          balances.find((row) => row.book_id === s.org.bookId && row.account_id === s.target)
            ?.amount,
          "150.0000",
        );
        assert.equal(
          balances.find((row) => row.book_id === bookId && row.account_id === s.target)?.amount,
          "102.0000",
        );
        assert.ok(
          balances
            .filter((row) => row.account_id === s.source)
            .every((row) => row.amount === "0.0000"),
        );
        const copies = (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from journal_entries
        where org_id = ${s.org.orgId} and origin = 'account_merge'`,
            "objects",
          )
        )[0]!;
        assert.equal(copies.count, 2);
      });
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "a retried merge returns the same record, and a stale preview is refused",
  { skip: !DB },
  async () => {
    const s = await scenario();
    try {
      const preview = await previewAccountMerge(
        s.org.orgId,
        { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE },
        null,
      );
      await assert.rejects(
        requestAccountMerge(s.org.orgId, request(s, { expectedDigest: "0".repeat(64) })),
        (error: unknown) =>
          error instanceof AccountMergeError &&
          error.code === "account_merge_preview_changed" &&
          error.status === 409,
      );
      const key = randomUUID();
      const first = await requestAccountMerge(
        s.org.orgId,
        request(s, { expectedDigest: preview.digest, idempotencyKey: key }),
      );
      const again = await requestAccountMerge(
        s.org.orgId,
        request(s, { expectedDigest: preview.digest, idempotencyKey: key }),
      );
      assert.equal(first.status, "completed");
      assert.equal(again.status, "completed");
      if (first.status !== "completed" || again.status !== "completed") return;
      assert.equal(again.mergeId, first.mergeId);
      assert.equal(again.replayed, true);
      await assert.rejects(
        requestAccountMerge(
          s.org.orgId,
          request(s, {
            expectedDigest: preview.digest,
            idempotencyKey: key,
            reason: "Different request terms under the same key",
          }),
        ),
        (error: unknown) =>
          error instanceof AccountMergeError && error.code === "account_merge_key_conflict",
      );
      const entries = await withBypassContext(
        async () =>
          (
            await db.execute<{ n: number }>(
              sql`
      select count(*)::int as n from journal_entries where org_id = ${s.org.orgId} and origin = 'account_merge'`,
              "objects",
            )
          )[0]!.n,
      );
      assert.equal(entries, 1, "a retry posts nothing twice");
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "concurrent merges of one account produce exactly one merge and one reclass",
  { skip: !DB },
  async () => {
    const s = await scenario();
    try {
      const preview = await previewAccountMerge(
        s.org.orgId,
        { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE },
        null,
      );
      const results = await Promise.allSettled([
        requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest })),
        requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest })),
      ]);
      assert.ok(results.some((result) => result.status === "fulfilled"));
      await withBypassContext(async () => {
        const merges = (
          await db.execute<{ n: number }>(
            sql`select count(*)::int as n from account_merges where org_id = ${s.org.orgId}`,
            "objects",
          )
        )[0]!.n;
        const reclasses = (
          await db.execute<{ n: number }>(
            sql`select count(*)::int as n from journal_entries where org_id = ${s.org.orgId} and origin = 'account_merge'`,
            "objects",
          )
        )[0]!.n;
        assert.equal(merges, 1);
        assert.equal(reclasses, 1);
      });
      assert.equal(await balance(s.org.orgId, s.source), "0.0000");
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "the preview refuses incompatible survivors and late postings, naming the remedy",
  { skip: !DB },
  async () => {
    const s = await scenario();
    try {
      const income = await withBypassContext(() =>
        seedPostingAccount(s.org.orgId, `4000-${randomUUID().slice(0, 4)}`, "Sales", "income"),
      );
      const typed = await previewAccountMerge(
        s.org.orgId,
        { sourceAccountId: s.source, targetAccountId: income, effectiveDate: EFFECTIVE },
        null,
      );
      assert.ok(
        typed.refusals.some(
          (refusal) => refusal.code === "type_mismatch" && refusal.remedy.length > 0,
        ),
      );

      const early = await previewAccountMerge(
        s.org.orgId,
        { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: "2026-07-10" },
        null,
      );
      assert.ok(early.refusals.some((refusal) => refusal.code === "postings_after_date"));

      await withBypassContext(() =>
        db.execute(
          sql`update accounts set is_active = false where org_id = ${s.org.orgId} and id = ${s.target}`,
        ),
      );
      const inactive = await previewAccountMerge(
        s.org.orgId,
        { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE },
        null,
      );
      assert.ok(inactive.refusals.some((refusal) => refusal.code === "target_inactive"));
      await assert.rejects(
        requestAccountMerge(s.org.orgId, request(s, { expectedDigest: inactive.digest })),
        (error: unknown) => error instanceof AccountMergeError && error.code === "target_inactive",
      );
      await assert.rejects(
        previewAccountMerge(
          s.org.orgId,
          { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE },
          new Set([s.org.subsidiaryId]),
        ),
        (error: unknown) =>
          error instanceof AccountMergeError && error.code === "account_merge_scope",
      );
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "a merged account refuses new postings, new references and reactivation",
  { skip: !DB },
  async () => {
    const s = await scenario();
    try {
      const preview = await previewAccountMerge(
        s.org.orgId,
        { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE },
        null,
      );
      await requestAccountMerge(s.org.orgId, request(s, { expectedDigest: preview.digest }));
      await assert.rejects(
        withBypassContext(() =>
          post(
            s.org,
            [
              { accountId: s.source, amount: "5.0000" },
              { accountId: s.org.accounts.bank, amount: "-5.0000" },
            ],
            EFFECTIVE,
          ),
        ),
        /was merged into/,
      );
      await assert.rejects(
        withBypassContext(() =>
          db.execute(
            sql`update vendor_roles set default_expense_account_id = ${s.source} where org_id = ${s.org.orgId} and id = ${s.vendorRole}`,
          ),
        ),
        (error: unknown) => errorChainMatches(error, /was merged into account/),
      );
      await assert.rejects(
        withBypassContext(() =>
          db.execute(
            sql`update accounts set is_active = true where org_id = ${s.org.orgId} and id = ${s.source}`,
          ),
        ),
        (error: unknown) => errorChainMatches(error, /cannot be reactivated/),
      );
      await assert.rejects(
        withBypassContext(() =>
          db.execute(
            sql`update account_merges set reason = 'Rewritten reason text' where org_id = ${s.org.orgId}`,
          ),
        ),
        (error: unknown) => errorChainMatches(error, /permanent history/),
      );
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "merges are confined to their organization and to the feature switch",
  { skip: !DB },
  async () => {
    const s = await scenario();
    const other = await createScratchOrg();
    try {
      await enableMerges(other.orgId);
      await assert.rejects(
        previewAccountMerge(
          other.orgId,
          { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE },
          null,
        ),
        (error: unknown) => error instanceof AccountMergeError && error.status === 404,
      );
      await assert.rejects(
        previewAccountMerge(
          s.org.orgId,
          {
            sourceAccountId: s.source,
            targetAccountId: other.accounts.cogs,
            effectiveDate: EFFECTIVE,
          },
          null,
        ),
        (error: unknown) => error instanceof AccountMergeError && error.status === 404,
      );
      await enableMerges(s.org.orgId, false);
      await assert.rejects(
        previewAccountMerge(
          s.org.orgId,
          { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE },
          null,
        ),
        (error: unknown) => error instanceof AccountMergeError && error.code === "feature_disabled",
      );
    } finally {
      await dropScratchOrg(other.orgId);
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "with an Accounting event flow a merge is proposed, approved, then applied against its preview",
  { skip: !DB },
  async () => {
    const s = await scenario();
    try {
      const actors = await seedFlowActors(s.org.orgId);
      await grantScratchPermissions(s.org.orgId, actors.approver1Id, ["gl.manage"]);
      await withBypassContext(() =>
        seedApprovalFlow(s.org.orgId, {
          subjectKind: "financial_change",
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "any",
        }),
      );
      const preview = await previewAccountMerge(
        s.org.orgId,
        { sourceAccountId: s.source, targetAccountId: s.target, effectiveDate: EFFECTIVE },
        null,
      );
      const proposed = await requestAccountMerge(
        s.org.orgId,
        request(s, { expectedDigest: preview.digest }),
      );
      assert.equal(proposed.status, "pending_approval");
      if (proposed.status !== "pending_approval") return;
      assert.equal(
        await balance(s.org.orgId, s.source),
        "150.0000",
        "nothing moves before approval",
      );
      await assert.rejects(
        applyApprovedAccountMerge(s.org.orgId, {
          changeId: proposed.changeId,
          actorId: s.actorId,
          allowedSubsidiaryIds: null,
        }),
        /approval|Flows/i,
      );
      const gates = await withBypassContext(() =>
        db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${s.org.orgId} and subject_kind='financial_change' and subject_id=${proposed.changeId} and status='pending'`,
          "objects",
        ),
      );
      assert.equal(gates.length, 1);
      await decideGate({ gateId: gates[0]!.id, userId: actors.approver1Id, decision: "approved" });
      const applied = await applyApprovedAccountMerge(s.org.orgId, {
        changeId: proposed.changeId,
        actorId: s.actorId,
        allowedSubsidiaryIds: null,
      });
      assert.equal(applied.status, "completed");
      assert.equal(await balance(s.org.orgId, s.source), "0.0000");
      const change = await withBypassContext(
        async () =>
          (
            await db.execute<{ status: string }>(
              sql`
      select status from financial_changes where org_id = ${s.org.orgId} and id = ${proposed.changeId}`,
              "objects",
            )
          )[0]!.status,
      );
      assert.equal(change, "applied");
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "every live foreign key into accounts is classified and guarded against merged-account references",
  { skip: !DB },
  async () => {
    await withBypassContext(async () => {
      const columns = await discoverAccountReferenceColumns(db);
      assert.ok(columns.length > 50);
      const unclassified = columns.filter((column) => classifyAccountReference(column) === null);
      assert.deepEqual(unclassified, []);
      const guarded = new Set(
        (
          await db.execute<{ table_name: string; column_name: string }>(
            sql`
      select c.relname::text as table_name,a.attname::text as column_name
        from pg_trigger t join pg_class c on c.oid=t.tgrelid
        join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
        join pg_attribute a on a.attrelid=t.tgrelid and a.attnum=any(t.tgattr::smallint[]) and not a.attisdropped
       where t.tgname=left(c.relname,40)||'_merged_account_guard'
         and t.tgfoid='public.refuse_merged_account_reference()'::regprocedure
         and t.tgtype=23 and t.tgenabled in ('O','A') and not t.tgisinternal
         and t.tgconstraint=0 and not t.tgdeferrable and not t.tginitdeferred
         and t.tgqual is null and t.tgoldtable is null and t.tgnewtable is null
         and t.tgnargs=cardinality(t.tgattr::smallint[])
         and t.tgargs=(select decode(string_agg(encode(convert_to(ga.attname::text,'UTF8'),'hex')||'00','' order by ga.attname::text COLLATE "C"),'hex')
           from unnest(t.tgattr::smallint[]) k(attnum)
           join pg_attribute ga on ga.attrelid=t.tgrelid and ga.attnum=k.attnum and not ga.attisdropped)
    `,
            "objects",
          )
        ).map((row) => `${row.table_name}.${row.column_name}`),
      );
      const unguarded = columns
        .filter((column) => classifyAccountReference(column) !== "owned")
        .map((column) => `${column.table}.${column.column}`)
        .filter((column) => !guarded.has(column));
      assert.deepEqual(
        unguarded,
        [],
        "every account FK column has an unconditional native insert and column-update guard",
      );
    });
  },
);

test(
  "balancing policy successors fence the requested merge date and retained merged-account policies clone unchanged",
  { skip: !DB },
  async () => {
    installEngineSeams();
    const org = await createScratchOrg();
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      const actors = await seedFlowActors(org.orgId);
      await enableMerges(org.orgId);
      const source = await withBypassContext(() =>
        seedPostingAccount(org.orgId, "1491", "Duplicate clearing", "asset_other"),
      );
      const target = await withBypassContext(() =>
        seedPostingAccount(org.orgId, "1490", "Clearing", "asset_other"),
      );
      const policyId = randomUUID();
      const translationId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`insert into segment_definitions(org_id,key,name,plural_name,is_balancing)
        values(${org.orgId},'clearing_group','Clearing group','Clearing groups',true)`);
        await db.execute(sql`insert into segment_balancing_policies(id,org_id,segment_key,effective_from,clearing_account_id,reason)
        values(${policyId},${org.orgId},'clearing_group','2026-07-01',${source},'Initial clearing policy'),
          (${randomUUID()},${org.orgId},'clearing_group','2026-07-30',${target},'Replacement clearing policy')`);
        await db.execute(sql`insert into account_translation_policies(id,org_id,account_id,effective_from,general_rate_type,cash_flow_rate_type,reason)
        values(${translationId},${org.orgId},${source},'2026-07-01','current','current','Initial reporting policy')`);
      });
      const earlier = await previewAccountMerge(
        org.orgId,
        { sourceAccountId: source, targetAccountId: target, effectiveDate: "2026-07-29" },
        null,
      );
      assert.equal(
        earlier.references.find(
          (row) => row.key === "segment_balancing_policies.clearing_account_id",
        )?.blocked,
        1,
      );
      assert.ok(earlier.refusals.some((row) => row.code === "reference_in_flight"));
      await assert.rejects(
        requestAccountMerge(
          org.orgId,
          request(
            { source, target, actorId: actors.adminId },
            {
              effectiveDate: "2026-07-29",
              expectedDigest: earlier.digest,
            },
          ),
        ),
        (error) => error instanceof AccountMergeError && error.code === "reference_in_flight",
      );

      const onDate = await previewAccountMerge(
        org.orgId,
        { sourceAccountId: source, targetAccountId: target, effectiveDate: "2026-07-30" },
        null,
      );
      assert.deepEqual(onDate.refusals, []);
      const outcome = await requestAccountMerge(
        org.orgId,
        request(
          { source, target, actorId: actors.adminId },
          {
            effectiveDate: "2026-07-30",
            expectedDigest: onDate.digest,
          },
        ),
      );
      assert.equal(outcome.status, "completed");
      const retained = async (orgId: string) =>
        await withBypassContext(() =>
          db.execute<{ account_id: string; clearing_account_id: string }>(
            sql`
      select p.account_id,b.clearing_account_id from account_translation_policies p
        join segment_balancing_policies b on b.org_id=p.org_id and b.effective_from=p.effective_from
       where p.org_id=${orgId}`,
            "objects",
          ),
        );
      assert.deepEqual(await retained(org.orgId), [
        { account_id: source, clearing_account_id: source },
      ]);
      await assert.rejects(
        () =>
          withBypassContext(() =>
            db.execute(sql`
      insert into account_translation_policies(org_id,account_id,effective_from,general_rate_type,cash_flow_rate_type,reason)
      values(${org.orgId},${source},'2026-07-31','current','current','New reporting policy')`),
          ),
        (error) => errorChainMatches(error, /was merged into account/),
      );
      await assert.rejects(
        () =>
          withBypassContext(() =>
            db.execute(sql`
      insert into segment_balancing_policies(org_id,segment_key,effective_from,clearing_account_id,reason)
      values(${org.orgId},'clearing_group','2026-07-31',${source},'New clearing policy')`),
          ),
        (error) => errorChainMatches(error, /was merged into account/),
      );
      await assert.rejects(
        () =>
          withBypassContext(() =>
            db.execute(sql`
      update account_translation_policies set account_id=${target} where org_id=${org.orgId} and id=${translationId}`),
          ),
        (error) => errorChainMatches(error, /retained history/),
      );

      sandbox = await withBypassContext(() =>
        createSandbox({
          productionOrgId: org.orgId,
          name: "Retained merged policies",
          tier: "full",
          masked: false,
        }),
      );
      const clonedSource = (
        await withBypassContext(() =>
          db.execute<{ id: string }>(
            sql`
      select ob_rebase(${source}::uuid,o.sandbox_seed)::text as id from orgs o where o.id=${sandbox!.sandboxOrgId}`,
            "objects",
          ),
        )
      )[0]!.id;
      assert.deepEqual(await retained(sandbox.sandboxOrgId), [
        { account_id: clonedSource, clearing_account_id: clonedSource },
      ]);
      await refreshSandbox(sandbox.sandboxId);
      assert.deepEqual(await retained(sandbox.sandboxOrgId), [
        { account_id: clonedSource, clearing_account_id: clonedSource },
      ]);
      assert.deepEqual(await retained(org.orgId), [
        { account_id: source, clearing_account_id: source },
      ]);
      await deleteSandbox(sandbox.sandboxId);
      sandbox = undefined;
    } finally {
      if (sandbox) await dropScratchOrgReporting(sandbox.sandboxOrgId);
      await dropScratchOrg(org.orgId);
    }
  },
);
