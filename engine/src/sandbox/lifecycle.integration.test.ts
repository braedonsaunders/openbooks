import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createSandbox, deleteSandbox, refreshSandbox, resetSandbox } from "./lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("a clean-schema full sandbox clones tenant evidence without pre-seed collisions or residue", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const sandboxName = `Lifecycle ${randomUUID()}`;
  let sandboxId: string | null = null;
  let sandboxOrgId: string | null = null;
  try {
    const created = await createSandbox({
      productionOrgId: org.orgId,
      name: sandboxName,
      tier: "full",
      masked: false,
    });
    sandboxId = created.sandboxId;
    sandboxOrgId = created.sandboxOrgId;

    const state = (await db.execute<{
        status: string;
        storage_rows: number;
        env_kind: string;
        sandbox_of: string;
      }>(sql`
      select sandbox.status, sandbox.storage_rows, org.env_kind, org.sandbox_of
        from sandboxes sandbox
        join orgs org on org.id = sandbox.org_id
       where sandbox.id = ${sandboxId}`));
    assert.equal(state.rows[0]?.status, "ready");
    assert.ok(Number(state.rows[0]?.storage_rows) > 0);
    assert.equal(state.rows[0]?.env_kind, "sandbox");
    assert.equal(state.rows[0]?.sandbox_of, org.orgId);

    const controls = (await db.execute<{ key: string; account_id: string; org_id: string | null }>(sql`
      select control.key, control.value as account_id, account.org_id
        from orgs sandbox
        cross join lateral jsonb_each_text(
          sandbox.settings -> 'controlAccounts'
        ) control
        left join accounts account on account.id = control.value::uuid
       where sandbox.id = ${sandboxOrgId}
       order by control.key
    `));
    assert.ok(controls.rows.length >= 3);
    assert.ok(
      controls.rows.every(
        (row) =>
          row.org_id === sandboxOrgId &&
          !Object.values(org.accounts).includes(row.account_id),
      ),
    );

    const segments = (await db.execute<{ key: string; source_id: string; clone_id: string }>(sql`
      select source.key,
             source.id as source_id,
             clone.id as clone_id
        from segment_definitions source
        join segment_definitions clone
          on clone.key = source.key
         and clone.org_id = ${sandboxOrgId}
       where source.org_id = ${org.orgId}
       order by source.key`));
    const sourceSegmentCount = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from segment_definitions
       where org_id = ${org.orgId}`));
    assert.equal(segments.rows.length, sourceSegmentCount.rows[0]?.count);
    assert.equal(new Set(segments.rows.map((row) => row.key)).size, segments.rows.length);
    assert.ok(segments.rows.every((row) => row.source_id !== row.clone_id));

    await refreshSandbox(sandboxId, { keepCustomizations: false });
    const refreshed = (await db.execute<{ status: string; last_error: string | null }>(sql`
      select status, last_error from sandboxes where id = ${sandboxId}`));
    assert.deepEqual(refreshed.rows, [{ status: "ready", last_error: null }]);
    const refreshedControls = await db.execute(sql`
      select count(*)::int as count
        from orgs sandbox
        cross join lateral jsonb_each_text(
          sandbox.settings -> 'controlAccounts'
        ) control
        join accounts account
          on account.id = control.value::uuid
         and account.org_id = sandbox.id
       where sandbox.id = ${sandboxOrgId}
    `);
    assert.equal(
      Number((refreshedControls.rows[0] as { count: number }).count),
      controls.rows.length,
    );

    await deleteSandbox(sandboxId);
    sandboxId = null;
    const residue = (await db.execute<{ orgs: number; segments: number; entries: number }>(sql`
      select
        (select count(*)::int from orgs where id = ${sandboxOrgId}) as orgs,
        (select count(*)::int from segment_definitions where org_id = ${sandboxOrgId}) as segments,
        (select count(*)::int from journal_entries where org_id = ${sandboxOrgId}) as entries`));
    assert.deepEqual(residue.rows, [{ orgs: 0, segments: 0, entries: 0 }]);
  } finally {
    if (sandboxId) {
      await deleteSandbox(sandboxId).catch(() => undefined);
    } else {
      const failed = (await db.execute<{ id: string }>(sql`
        select id from sandboxes
         where production_org_id = ${org.orgId}
           and name = ${sandboxName}`));
      for (const row of failed.rows) {
        await deleteSandbox(row.id).catch(() => undefined);
      }
    }
    await dropScratchOrg(org.orgId);
  }
});

test("refresh rebuilds maintained aggregates instead of accumulating cloned rows", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const sandboxName = `Aggregate refresh ${randomUUID()}`;
  let sandboxId: string | null = null;
  try {
    const invoiceEntryId = randomUUID();
    const invoiceLineId = randomUUID();
    const paymentEntryId = randomUUID();
    const paymentLineId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values
        (${invoiceEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`AGG-INV-${invoiceEntryId.slice(0, 8)}`},
         ${org.date}, ${org.periodId}, 'draft', 'manual'),
        (${paymentEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`AGG-PAY-${paymentEntryId.slice(0, 8)}`},
         ${org.date}, ${org.periodId}, 'draft', 'manual')`);
    await db.execute(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, is_open_item)
      values
        (${invoiceLineId}, ${org.orgId}, ${invoiceEntryId}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, 100, 'CAD', 100, 1, ${org.customerId}, true),
        (${randomUUID()}, ${org.orgId}, ${invoiceEntryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, -100, 'CAD', -100, 1, null, false),
        (${paymentLineId}, ${org.orgId}, ${paymentEntryId}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, -100, 'CAD', -100, 1, ${org.customerId}, true),
        (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, 100, 'CAD', 100, 1, null, false)`);
    await db.execute(sql`
      update journal_entries
         set status = 'posted', posted_at = now()
       where org_id = ${org.orgId}
         and id in (${invoiceEntryId}, ${paymentEntryId})`);
    await db.execute(sql`
      insert into applications
        (id, org_id, from_line_id, to_line_id, amount, source_amount,
         source_transaction_amount, source_transaction_currency, target_transaction_amount,
         target_transaction_currency, settlement_rate, settlement_rate_source,
         settlement_rate_reference, applied_on)
      values
        (${randomUUID()}, ${org.orgId}, ${paymentLineId}, ${invoiceLineId}, 100, 100,
         100, 'CAD', 100, 'CAD', 1, 'same_currency', 'aggregate refresh test', ${org.date})`);
    const created = await createSandbox({
      productionOrgId: org.orgId,
      name: sandboxName,
      tier: "full",
      masked: false,
    });
    sandboxId = created.sandboxId;

    const aggregateSnapshot = async (): Promise<{ gl: unknown[]; payments: unknown[] }> => ({
      gl: (await db.execute(sql`
        select account_id::text, book_id::text, month::text, subsidiary_id::text,
               debit_total::text, credit_total::text, line_count::text
          from gl_month_activity
         where org_id = ${created.sandboxOrgId}
         order by account_id, book_id, month, subsidiary_id`)).rows,
      payments: (await db.execute(sql`
        select party_id::text, account_type, settled_on::text, n::text, sum_days::text, sum_days_sq::text
          from party_payment_stats
         where org_id = ${created.sandboxOrgId}
         order by party_id, account_type, settled_on`)).rows,
    });
    const before = await aggregateSnapshot();
    assert.ok(before.gl.length >= 3, "the initial clone must maintain GL aggregates from posted lines");
    assert.deepEqual(before.payments.length, 1, "the initial clone must maintain payment aggregates from applications");

    await refreshSandbox(sandboxId, { keepCustomizations: false });
    assert.deepEqual(await aggregateSnapshot(), before, "refresh must rebuild, not double-count, maintained aggregates");
  } finally {
    if (sandboxId) await deleteSandbox(sandboxId).catch(() => undefined);
    else {
      const failed = (await db.execute<{ id: string }>(sql`
        select id from sandboxes where production_org_id = ${org.orgId} and name = ${sandboxName}`));
      for (const row of failed.rows) await deleteSandbox(row.id).catch(() => undefined);
    }
    await dropScratchOrg(org.orgId);
  }
});

test("an as-of sandbox refuses posted activity after its cutoff instead of failing on a deferred foreign key", { skip: !DB }, async () => {
  // Trimming journal entries past the cutoff while copying every document
  // leaves post-cutoff documents pointing at entries that were never copied,
  // which dies at commit with a cryptic documents_posted_entry_id_fkey
  // violation. Refuse up front with an actionable error naming the cutoff.
  const org = await createScratchOrg();
  const sandboxName = `As-of cutoff ${randomUUID()}`;
  try {
    const cal = (await db.execute<{ fiscal_calendar_id: string }>(sql`
      select fiscal_calendar_id from accounting_periods where id = ${org.periodId} and org_id = ${org.orgId}`)).rows[0]!.fiscal_calendar_id;
    const laterPeriodId = randomUUID();
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${laterPeriodId}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${cal})`);
    const docId = randomUUID();
    const entryId = randomUUID();
    await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, status, subtotal, tax_total, total, custom)
      values (${docId}, ${org.orgId}, 'customer_invoice', 'INV-ASOF', ${org.customerId}, ${org.subsidiaryId},
              '2026-08-05', '2026-08-05', 'CAD', 'approved', 100, 0, 100, '{}'::jsonb)`);
    await db.execute(sql`
      insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, source_document_id, origin)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'INV-ASOF', '2026-08-05', ${laterPeriodId},
              'Post-cutoff invoice', 'draft', ${docId}, 'document')`);
    await db.execute(sql`
      insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, is_open_item)
      values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, 100, 'CAD', 100, 1, ${org.customerId}, true),
             (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, -100, 'CAD', -100, 1, null, false)`);
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId} and org_id = ${org.orgId}`);
    await db.execute(sql`update documents set posted_entry_id = ${entryId}, posting_period_id = ${laterPeriodId}, status = 'posted' where id = ${docId} and org_id = ${org.orgId}`);

    await assert.rejects(
      createSandbox({ productionOrgId: org.orgId, name: sandboxName, tier: "as_of", masked: false, asOfPeriodId: org.periodId }),
      /later periods/,
    );
  } finally {
    const failed = (await db.execute<{ id: string }>(sql`
      select id from sandboxes where production_org_id = ${org.orgId} and name = ${sandboxName}`));
    for (const row of failed.rows) {
      await deleteSandbox(row.id).catch(() => undefined);
    }
    await dropScratchOrg(org.orgId);
  }
});

test("an as-of sandbox rejects missing or foreign cutoff periods", { skip: !DB }, async () => {
  const production = await createScratchOrg();
  const external = await createScratchOrg();
  const foreignName = `Foreign cutoff ${randomUUID()}`;
  const missingName = `Missing cutoff ${randomUUID()}`;
  try {
    await assert.rejects(
      createSandbox({
        productionOrgId: production.orgId,
        name: foreignName,
        tier: "as_of",
        masked: false,
        asOfPeriodId: external.periodId,
      }),
      /as-of cutoff period must belong to the production organization/,
    );
    await assert.rejects(
      createSandbox({
        productionOrgId: production.orgId,
        name: missingName,
        tier: "as_of",
        masked: false,
        asOfPeriodId: null,
      }),
      /as-of sandbox requires a cutoff period/,
    );
  } finally {
    const failed = (await db.execute<{ id: string }>(sql`
      select id from sandboxes where production_org_id = ${production.orgId} and name in (${foreignName}, ${missingName})`));
    for (const row of failed.rows) await deleteSandbox(row.id).catch(() => undefined);
    await dropScratchOrg(production.orgId);
    await dropScratchOrg(external.orgId);
  }
});

test("a failed refresh rolls back the wipe instead of leaving a partial sandbox", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const sandboxName = `Refresh rollback ${randomUUID()}`;
  let sandboxId: string | null = null;
  let sandboxOrgId: string | null = null;
  const fault = `openbooks_sandbox_refresh_${randomUUID().replaceAll("-", "")}`;
  try {
    const created = await createSandbox({
      productionOrgId: org.orgId,
      name: sandboxName,
      tier: "full",
      masked: false,
    });
    sandboxId = created.sandboxId;
    sandboxOrgId = created.sandboxOrgId;

    const before = (await db.execute<{ accounts: number; journal_entries: number }>(sql`
      select
        (select count(*)::int from accounts where org_id = ${sandboxOrgId}) as accounts,
        (select count(*)::int from journal_entries where org_id = ${sandboxOrgId}) as journal_entries`)).rows;
    assert.ok(Number(before[0]?.accounts) > 0);

    // Fail on the first clone INSERT, after refresh has already entered the
    // destructive wipe path. The trigger is sandbox-specific, so production
    // rows and fixture cleanup remain unaffected.
    await db.execute(sql.raw(`
      create function "${fault}"() returns trigger language plpgsql as $fn$
      begin
        if new.org_id = '${sandboxOrgId}'::uuid then
          raise exception 'forced sandbox refresh clone failure';
        end if;
        return new;
      end
      $fn$`));
    await db.execute(sql.raw(`
      create trigger "${fault}_trg"
        before insert on accounts
        for each row
        execute function "${fault}"()`));

    await assert.rejects(
      refreshSandbox(sandboxId, { keepCustomizations: false }),
      (error: unknown) => {
        let current: unknown = error;
        while (current) {
          if (
            current instanceof Error &&
            /forced sandbox refresh clone failure/.test(current.message)
          ) {
            return true;
          }
          current =
            typeof current === "object" && current !== null
              ? (current as { cause?: unknown }).cause
              : undefined;
        }
        return false;
      },
    );

    const after = (await db.execute<{ accounts: number; journal_entries: number }>(sql`
      select
        (select count(*)::int from accounts where org_id = ${sandboxOrgId}) as accounts,
        (select count(*)::int from journal_entries where org_id = ${sandboxOrgId}) as journal_entries`)).rows;
    assert.deepEqual(after, before, "a failed refresh must preserve every pre-refresh tenant row");

    const status = (await db.execute<{ status: string; last_error: string | null }>(sql`
      select status, last_error from sandboxes where id = ${sandboxId}`)).rows[0];
    assert.equal(status?.status, "failed");
    assert.match(status?.last_error ?? "", /Failed query: insert into "accounts"/);
  } finally {
    await db.execute(sql.raw(`drop trigger if exists "${fault}_trg" on accounts`)).catch(() => undefined);
    await db.execute(sql.raw(`drop function if exists "${fault}"()`)).catch(() => undefined);
    if (sandboxId) {
      await deleteSandbox(sandboxId).catch(() => undefined);
    } else {
      const failed = (await db.execute<{ id: string }>(sql`
        select id from sandboxes
         where production_org_id = ${org.orgId}
           and name = ${sandboxName}`));
      for (const row of failed.rows) {
        await deleteSandbox(row.id).catch(() => undefined);
      }
    }
    await dropScratchOrg(org.orgId);
  }
});

async function withSandboxCleanup(
  org: { orgId: string },
  sandboxName: string,
  work: (handle: { sandboxId: string | null }) => Promise<void>,
): Promise<void> {
  const handle: { sandboxId: string | null } = { sandboxId: null };
  try {
    await work(handle);
  } finally {
    // Cleanup failures are surfaced, not swallowed: a sandbox that cannot be
    // deleted would also block the production org teardown behind it.
    const rows = (await db.execute<{ id: string }>(sql`
      select id from sandboxes where production_org_id = ${org.orgId} and name = ${sandboxName}`)).rows;
    for (const row of rows) await deleteSandbox(row.id);
    await dropScratchOrg(org.orgId);
  }
}

test("a sandbox never holds production API keys or SFTP logins (global credential indexes)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const sandboxName = `Credential exclusion ${randomUUID()}`;
  await withSandboxCleanup(org, sandboxName, async (handle) => {
    const ownerId = await createScratchUser(org.orgId, "Integrator", "integrator");
    await db.execute(sql`
      insert into api_keys (org_id, user_id, name, key_prefix, key_hash, key_preview, scopes)
      values (${org.orgId}, ${ownerId}, 'Prod sync', 'ob_live_abc', ${randomUUID().replaceAll("-", "")}, 'abcd', '["gl.read"]'::jsonb)`);
    await db.execute(sql`
      insert into sftp_servers (org_id, name, username, password_encrypted, root_prefix)
      values (${org.orgId}, 'Bank drop', ${`u${randomUUID().replaceAll("-", "")}`}, 'sealed', ${`sftp/${org.orgId}`})`);

    const created = await createSandbox({ productionOrgId: org.orgId, name: sandboxName, tier: "full", masked: false });
    handle.sandboxId = created.sandboxId;

    const state = (await db.execute<{ status: string; api_keys: number; sftp_servers: number; schedules: number }>(sql`
      select (select status from sandboxes where id = ${created.sandboxId}) as status,
             (select count(*)::int from api_keys where org_id = ${created.sandboxOrgId}) as api_keys,
             (select count(*)::int from sftp_servers where org_id = ${created.sandboxOrgId}) as sftp_servers,
             (select count(*)::int from sftp_import_schedules where org_id = ${created.sandboxOrgId}) as schedules`)).rows[0]!;
    assert.deepEqual(state, { status: "ready", api_keys: 0, sftp_servers: 0, schedules: 0 });

    await refreshSandbox(created.sandboxId);
    const refreshed = (await db.execute<{ status: string; api_keys: number; sftp_servers: number }>(sql`
      select (select status from sandboxes where id = ${created.sandboxId}) as status,
             (select count(*)::int from api_keys where org_id = ${created.sandboxOrgId}) as api_keys,
             (select count(*)::int from sftp_servers where org_id = ${created.sandboxOrgId}) as sftp_servers`)).rows[0]!;
    assert.deepEqual(refreshed, { status: "ready", api_keys: 0, sftp_servers: 0 });
  });
});

test("refresh and reset leave a sandbox as credential-free and inert as create does", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const sandboxName = `Neuter on refresh ${randomUUID()}`;
  await withSandboxCleanup(org, sandboxName, async (handle) => {
    await db.execute(sql`
      insert into psp_provider_configs (org_id, provider, display_name, is_enabled, secrets, publishable_key)
      values (${org.orgId}, 'stripe', 'Stripe', true, 'sealed-secret', 'pk_live_x')`);
    await db.execute(sql`
      insert into bank_feed_connections (org_id, account_id, name, provider, status, credentials, is_active, sync_cadence, next_sync_at)
      values (${org.orgId}, ${org.accounts.bank}, 'Main feed', 'plaid', 'connected', 'sealed-credentials', true, 'daily', now())`);
    await db.execute(sql`
      update orgs set settings = coalesce(settings, '{}'::jsonb) || '{"email":{"provider":"smtp"}}'::jsonb where id = ${org.orgId}`);

    const created = await createSandbox({ productionOrgId: org.orgId, name: sandboxName, tier: "full", masked: false });
    handle.sandboxId = created.sandboxId;

    const inert = async (): Promise<Record<string, unknown>> =>
      (await db.execute(sql`
        select (select count(*)::int from psp_provider_configs where org_id = ${created.sandboxOrgId}
                 and (is_enabled or secrets is not null or publishable_key is not null)) as live_psp,
               (select count(*)::int from bank_feed_connections where org_id = ${created.sandboxOrgId}
                 and (is_active or credentials is not null or status <> 'disconnected' or next_sync_at is not null)) as live_feeds,
               (select settings ? 'email' from orgs where id = ${created.sandboxOrgId}) as email_configured,
               (select status from sandboxes where id = ${created.sandboxId}) as status`)).rows[0] as Record<string, unknown>;

    assert.deepEqual(await inert(), { live_psp: 0, live_feeds: 0, email_configured: false, status: "ready" });

    await refreshSandbox(created.sandboxId, { keepCustomizations: true });
    assert.deepEqual(await inert(), { live_psp: 0, live_feeds: 0, email_configured: false, status: "ready" }, "refresh must not rehydrate credentials");

    await resetSandbox(created.sandboxId);
    assert.deepEqual(await inert(), { live_psp: 0, live_feeds: 0, email_configured: false, status: "ready" }, "reset must not rehydrate credentials");
  });
});

test("a masked sandbox carries no bank routing, taxpayer ids or org tax ids", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const sandboxName = `Masking coverage ${randomUUID()}`;
  await withSandboxCleanup(org, sandboxName, async (handle) => {
    const partyId = randomUUID();
    const employeeId = randomUUID();
    const bankId = randomUUID();
    const scheduleId = randomUUID();
    const filingId = randomUUID();
    // Distinctive production identifiers: the masked clone must drop the
    // ciphertext, the last-three, and the frozen filing TIN — not merely the
    // vendor-role last-four the older assertion already covered.
    const employeeSinCipher = "sealed-employee-sin-ciphertext";
    const employeeSinLast3 = "321";
    const filingTin = "987654321";
    await db.execute(sql`update orgs set tax_ids = '{"CA_BN":"123456789RT0001"}'::jsonb where id = ${org.orgId}`);
    await db.execute(sql`update subsidiaries set tax_ids = '{"CA_BN":"123456789RT0001"}'::jsonb where id = ${org.subsidiaryId}`);
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, tax_ids)
      values (${partyId}, ${org.orgId}, 'vendor', 'Masked Vendor', '{"US_EIN":"12-3456789"}'::jsonb)`);
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name)
      values (${employeeId}, ${org.orgId}, 'person', 'Masked Employee')`);
    await db.execute(sql`
      insert into vendor_roles (org_id, party_id, tin_encrypted, tin_last4, tin_type)
      values (${org.orgId}, ${partyId}, 'sealed-tin', '6789', 'ein')`);
    await db.execute(sql`
      insert into party_bank_accounts (id, org_id, party_id, bank_name, routing, account_number_encrypted, account_last_four)
      values (${bankId}, ${org.orgId}, ${partyId}, 'Bank', '{"institution":"001","transit":"12345"}'::jsonb, 'sealed-account', '4321')`);
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
      values (${scheduleId}, ${org.orgId}, 'Masking schedule', 'biweekly', 26, '2026-07-18')`);
    await db.execute(sql`
      insert into employee_payroll_profiles
        (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis, sin_encrypted, sin_last3)
      values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'hourly', ${employeeSinCipher}, ${employeeSinLast3})`);
    await db.execute(sql`
      insert into information_return_filings
        (id, org_id, tax_year, form_type, status, threshold, currency, finalized_at, payer_snapshot)
      values (${filingId}, ${org.orgId}, 2026, '1099-NEC', 'finalized', '600', 'CAD', now(),
              '{"name":"Main Co","taxIds":{"CA_BN":"123456789RT0001"}}'::jsonb)`);
    await db.execute(sql`
      insert into information_return_recipients
        (org_id, filing_id, party_id, recipient_snapshot, tin_last4, tin_type)
      values (${org.orgId}, ${filingId}, ${partyId},
              ${JSON.stringify({
                legalName: "Masked Vendor",
                tin: filingTin,
                tinType: "ssn",
                address: { line1: "123 Filing Street" },
              })}::jsonb,
              '4321', 'ssn')`);

    const created = await createSandbox({ productionOrgId: org.orgId, name: sandboxName, tier: "masked", masked: true });
    handle.sandboxId = created.sandboxId;

    const masked = async (): Promise<Record<string, unknown>> =>
      (await db.execute(sql`
        select (select tax_ids from orgs where id = ${created.sandboxOrgId}) as org_tax_ids,
               (select count(*)::int from parties where org_id = ${created.sandboxOrgId}
                 and coalesce(tax_ids, '{}'::jsonb) <> '{}'::jsonb) as identified_parties,
               (select count(*)::int from vendor_roles where org_id = ${created.sandboxOrgId}
                 and (tin_encrypted is not null or tin_last4 is not null or tin_type is not null)) as identified_vendors,
               (select count(*)::int from subsidiaries where org_id = ${created.sandboxOrgId}
                 and tax_ids <> '{}'::jsonb) as identified_subsidiaries,
               (select count(*)::int from party_bank_accounts where org_id = ${created.sandboxOrgId}
                 and (routing <> '{}'::jsonb or account_number_encrypted is not null or account_last_four is not null)) as routable_accounts,
               (select count(*)::int from party_bank_accounts where org_id = ${created.sandboxOrgId}) as bank_accounts,
               (select count(*)::int from employee_payroll_profiles where org_id = ${created.sandboxOrgId}
                 and (sin_encrypted is not null or sin_last3 is not null)) as identified_sins,
               (select count(*)::int from employee_payroll_profiles where org_id = ${created.sandboxOrgId}) as payroll_profiles,
               (select count(*)::int from information_return_recipients where org_id = ${created.sandboxOrgId}
                 and (recipient_snapshot <> '{}'::jsonb or tin_last4 is not null or tin_type is not null)) as identified_recipients,
               (select count(*)::int from information_return_recipients where org_id = ${created.sandboxOrgId}) as recipients,
               (select count(*)::int from employee_payroll_profiles where org_id = ${created.sandboxOrgId}
                 and (sin_encrypted = ${employeeSinCipher} or sin_last3 = ${employeeSinLast3})) as sin_ciphertext_leaks,
               (select count(*)::int from information_return_recipients where org_id = ${created.sandboxOrgId}
                 and recipient_snapshot::text like ${`%${filingTin}%`}) as filing_tin_leaks,
               (select count(*)::int from information_return_filings where org_id = ${created.sandboxOrgId}
                 and (payer_snapshot ? 'taxIds' or payer_snapshot::text like '%123456789RT0001%')) as identified_payer_snapshots,
               (select count(*)::int from information_return_filings where org_id = ${created.sandboxOrgId}) as filings,
               (select status from sandboxes where id = ${created.sandboxId}) as status`)).rows[0] as Record<string, unknown>;

    const expected = {
      org_tax_ids: {}, identified_parties: 0, identified_vendors: 0, identified_subsidiaries: 0,
      routable_accounts: 0, bank_accounts: 1, identified_sins: 0, payroll_profiles: 1,
      identified_recipients: 0, recipients: 1, sin_ciphertext_leaks: 0, filing_tin_leaks: 0,
      identified_payer_snapshots: 0, filings: 1,
      status: "ready",
    };
    assert.deepEqual(await masked(), expected);

    await refreshSandbox(created.sandboxId);
    assert.deepEqual(await masked(), expected, "refresh keeps the masked sandbox identifier-free");
  });
});

test("a masked sandbox scrubs custom JSON and copied user credentials", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const sandboxName = `Mask custom data ${randomUUID()}`;
  await withSandboxCleanup(org, sandboxName, async (handle) => {
    const userId = await createScratchUser(org.orgId, "Production Operator", "mask_operator");
    await db.execute(sql`
      update parties
         set custom = '{"government_id":"123-45-6789","source_email":"person@example.com"}'::jsonb
       where id = ${org.customerId} and org_id = ${org.orgId}`);
    await db.execute(sql`
      update users
         set email = 'person@example.com', name = 'Production Operator', password_hash = 'production-password-hash'
       where id = ${userId} and org_id = ${org.orgId}`);

    const created = await createSandbox({ productionOrgId: org.orgId, name: sandboxName, tier: "masked", masked: true });
    handle.sandboxId = created.sandboxId;
    const leaked = (await db.execute<{ custom_leaks: number; user_leaks: number }>(sql`
      select
        (select count(*)::int from parties
          where org_id = ${created.sandboxOrgId}
            and custom::text like any (array['%123-45-6789%', '%person@example.com%'])) as custom_leaks,
        (select count(*)::int from users
          where org_id = ${created.sandboxOrgId}
            and (email = 'person@example.com' or name = 'Production Operator' or password_hash = 'production-password-hash')) as user_leaks`)).rows[0]!;
    assert.deepEqual(leaked, { custom_leaks: 0, user_leaks: 0 });
  });
});


test("a full sandbox clones an org with live posted documents and lines", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let sandboxId: string | null = null;
  try {
    const userId = await createScratchUser(org.orgId, `CloneLines ${randomUUID()}`, "accountant");
    const invoiceId = randomUUID();
    await db.execute(sql`insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${`CLONE-${randomUUID()}`},
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
              'CAD', '1', '100', '0', '100', ${userId})`);
    await db.execute(sql`insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
    await db.execute(sql`update documents set status='approved' where id=${invoiceId} and org_id=${org.orgId}`);
    await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    const created = await createSandbox({ productionOrgId: org.orgId, name: `CloneLines ${randomUUID()}`, tier: "full", masked: false });
    sandboxId = created.sandboxId;
    const counts = (await db.execute<{ documents: number; lines: number; entries: number }>(sql`
      select (select count(*)::int from documents where org_id = ${created.sandboxOrgId}) as documents,
             (select count(*)::int from document_lines where org_id = ${created.sandboxOrgId}) as lines,
             (select count(*)::int from journal_entries where org_id = ${created.sandboxOrgId}) as entries
    `)).rows[0]!;
    assert.deepEqual(counts, { documents: 1, lines: 1, entries: 1 });
  } finally {
    if (sandboxId) {
      await deleteSandbox(sandboxId).catch(() => undefined);
    } else {
      // A failed create still records a 'failed' sandbox row pinning the org;
      // remove it so the scratch org can drop.
      const rows = (await db.execute<{ id: string }>(sql`select id from sandboxes where production_org_id = ${org.orgId}`)).rows;
      for (const r of rows) await deleteSandbox(r.id).catch(() => undefined);
    }
    await dropScratchOrg(org.orgId);
  }
});

test("a sandbox holding posted documents can be deleted without stranding its org", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const sandboxName = `DeletePosted ${randomUUID()}`;
  let sandboxId: string | null = null;
  try {
    const created = await createSandbox({ productionOrgId: org.orgId, name: sandboxName, tier: "full", masked: false });
    sandboxId = created.sandboxId;
    const accountByNumber = async (number: string): Promise<string> =>
      (await db.execute<{ id: string }>(sql`select id::text as id from accounts where org_id = ${created.sandboxOrgId} and number = ${number}`)).rows[0]!.id;
    const customer = (await db.execute<{ id: string }>(sql`select id::text as id from parties where org_id = ${created.sandboxOrgId} and display_name = 'Acme Customer'`)).rows[0]!.id;
    const subsidiary = (await db.execute<{ id: string }>(sql`select id::text as id from subsidiaries where org_id = ${created.sandboxOrgId}`)).rows[0]!.id;
    const userId = await createScratchUser(created.sandboxOrgId, `SbxPost ${randomUUID()}`, "accountant");
    const invoiceId = randomUUID();
    await db.execute(sql`insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${created.sandboxOrgId}, 'customer_invoice', 'draft', ${`SBX-${randomUUID()}`},
              ${subsidiary}, ${customer}, ${org.date}, ${org.date},
              'CAD', '1', '100', '0', '100', ${userId})`);
    await db.execute(sql`insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${created.sandboxOrgId}, ${invoiceId}, 1, ${await accountByNumber("4000")}, '1', '100', '100', '0', '0')`);
    await db.execute(sql`update documents set status='approved' where id=${invoiceId} and org_id=${created.sandboxOrgId}`);
    await postDocument(invoiceId, {
      control: { ar: await accountByNumber("1100"), ap: await accountByNumber("2000"), bank: await accountByNumber("1000") },
    });
    await deleteSandbox(sandboxId);
    sandboxId = null;
    const residue = (await db.execute<{ orgs: number; documents: number; entries: number }>(sql`
      select (select count(*)::int from orgs where id = ${created.sandboxOrgId}) as orgs,
             (select count(*)::int from documents where org_id = ${created.sandboxOrgId}) as documents,
             (select count(*)::int from journal_entries where org_id = ${created.sandboxOrgId}) as entries
    `)).rows[0]!;
    assert.deepEqual(residue, { orgs: 0, documents: 0, entries: 0 });
    const prod = (await db.execute<{ orgs: number; documents: number }>(sql`
      select (select count(*)::int from orgs where id = ${org.orgId}) as orgs,
             (select count(*)::int from documents where org_id = ${org.orgId}) as documents
    `)).rows[0]!;
    assert.deepEqual(prod, { orgs: 1, documents: 0 });
  } finally {
    if (sandboxId) await deleteSandbox(sandboxId).catch(() => undefined);
    else {
      const failed = (await db.execute<{ id: string }>(sql`
        select id from sandboxes where production_org_id = ${org.orgId} and name = ${sandboxName}`));
      for (const row of failed.rows) await deleteSandbox(row.id).catch(() => undefined);
    }
    await dropScratchOrg(org.orgId);
  }
});
