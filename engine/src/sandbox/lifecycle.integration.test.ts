import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../test-fixtures.ts";
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
    const bankId = randomUUID();
    await db.execute(sql`update orgs set tax_ids = '{"CA_BN":"123456789RT0001"}'::jsonb where id = ${org.orgId}`);
    await db.execute(sql`update subsidiaries set tax_ids = '{"CA_BN":"123456789RT0001"}'::jsonb where id = ${org.subsidiaryId}`);
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, tax_ids)
      values (${partyId}, ${org.orgId}, 'vendor', 'Masked Vendor', '{"US_EIN":"12-3456789"}'::jsonb)`);
    await db.execute(sql`
      insert into vendor_roles (org_id, party_id, tin_encrypted, tin_last4, tin_type)
      values (${org.orgId}, ${partyId}, 'sealed-tin', '6789', 'ein')`);
    await db.execute(sql`
      insert into party_bank_accounts (id, org_id, party_id, bank_name, routing, account_number_encrypted, account_last_four)
      values (${bankId}, ${org.orgId}, ${partyId}, 'Bank', '{"institution":"001","transit":"12345"}'::jsonb, 'sealed-account', '4321')`);

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
               (select status from sandboxes where id = ${created.sandboxId}) as status`)).rows[0] as Record<string, unknown>;

    const expected = {
      org_tax_ids: {}, identified_parties: 0, identified_vendors: 0, identified_subsidiaries: 0,
      routable_accounts: 0, bank_accounts: 1, status: "ready",
    };
    assert.deepEqual(await masked(), expected);

    await refreshSandbox(created.sandboxId);
    assert.deepEqual(await masked(), expected, "refresh keeps the masked sandbox identifier-free");
  });
});
