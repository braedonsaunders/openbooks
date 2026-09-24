import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  cloneSampleCompanyTemplate,
  createSampleCompany,
  sampleCompanyStatuses,
} from "./service.ts";
import { db, withBypass, withBypassContext, withOrgContext } from "../platform/db.ts";
import { createScriptJournal } from "../ledger/journal-writes.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropSampleCloneOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";

// OM-13-CLONE: the manufacturing sample-company birth must copy the
// template's posted history end to end. The Atlas birth failed
// deterministically with PG 23505 because the clone carried globally-unique
// operational keys verbatim (scheduler_outbox.occurrence_key first;
// flow_runs.occurrence_key and hrm_document_signers.token_hash on the same
// sweep). The template below carries all three plus real posted history, so
// this test fires on any of them.

const DB = !!process.env.OPENBOOKS_DB_URL;

const INDUSTRY = "manufacturing";

interface Fixture {
  memberOrgId: string;
  memberUserId: string;
  templateOrgId: string;
  createdOrgIds: string[];
}

async function seedTemplateOrg(): Promise<string> {
  const template = await withBypass(() => createScratchOrg());
  try {
    await withBypass(() =>
      db.execute(sql`
        insert into app_roles (org_id, key, name, is_built_in, permissions)
        values (${template.orgId}, 'admin', 'admin', true, '[]'::jsonb)
        on conflict (org_id, key) do update set updated_at = now()`),
    );
    const period = (await withBypass(() => db.execute<{ id: string }>(sql`
      select id from accounting_periods
       where org_id = ${template.orgId}
         and starts_on <= '2026-07-10' and ends_on >= '2026-07-10'
       limit 1`))).rows[0]?.id;
    assert.ok(period, "scratch org seeds no period covering the template posting date");
    const journal = await withOrgContext(template.orgId, () =>
      createScriptJournal(template.orgId, null, {
        documentDate: "2026-07-10",
        memo: "Atlas template seed",
        lines: [
          { accountId: template.accounts.bank, amount: 1000 },
          { accountId: template.accounts.ar, amount: -1000 },
        ],
      }, { post: true }),
    );
    assert.ok(journal.entryId, "template seed journal did not post");
    await withBypass(() =>
      db.execute(sql`
        insert into documents (id, org_id, kind, document_number, document_date, currency, status, posted_entry_id, posting_period_id)
        values (${randomUUID()}, ${template.orgId}, 'customer_invoice', 'INV-0001', '2026-07-10', 'CAD', 'posted', ${journal.entryId}, ${period})`),
    );
    await withBypass(() =>
      db.execute(sql`
        insert into scheduler_outbox (id, org_id, kind, subject_id, payload, occurrence_key, status)
        values (${randomUUID()}, ${template.orgId}, 'flow_email', ${randomUUID()}, '{}'::jsonb, ${`atlas-outbox-${randomUUID()}`}, 'pending')`),
    );
    const flowId = randomUUID();
    await withBypass(() =>
      db.execute(sql`
        insert into flows (id, org_id, name, subject_kind, graph, enabled)
        values (${flowId}, ${template.orgId}, 'Atlas approval', 'customer', '{}'::jsonb, true)`),
    );
    await withBypass(() =>
      db.execute(sql`
        insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger, occurrence_key, status)
        values (${randomUUID()}, ${template.orgId}, ${flowId}, 'customer', ${randomUUID()}, 'manual', ${`atlas-flow-${randomUUID()}`}, 'completed')`),
    );
    const signerPartyId = randomUUID();
    await withBypass(() =>
      db.execute(sql`
        insert into parties (id, org_id, kind, display_name)
        values (${signerPartyId}, ${template.orgId}, 'employee', 'Atlas Signer')`),
    );
    const hrmDocId = randomUUID();
    await withBypass(() =>
      db.execute(sql`
        insert into hrm_documents (id, org_id, title, category_key)
        values (${hrmDocId}, ${template.orgId}, 'Atlas safety policy', 'policy')`),
    );
    await withBypass(() =>
      db.execute(sql`
        insert into hrm_document_signers (id, org_id, document_id, ord, signer_party_id, role, status, token_hash)
        values (${randomUUID()}, ${template.orgId}, ${hrmDocId}, 0, ${signerPartyId}, 'employee', 'pending', ${`atlas-sign-token-${randomUUID()}`})`),
    );
    return template.orgId;
  } catch (error) {
    await withBypass(() => dropScratchOrg(template.orgId));
    throw error;
  }
}

async function seedFixture(): Promise<Fixture> {
  const memberOrg = await withBypass(() => createScratchOrg());
  const templateOrgId = await seedTemplateOrg();
  const memberUserId = await withBypass(() =>
    createScratchUser(memberOrg.orgId, "Atlas requester", "admin"),
  );
  return {
    memberOrgId: memberOrg.orgId,
    memberUserId,
    templateOrgId,
    createdOrgIds: [],
  };
}

async function dropFixture(fixture: Fixture): Promise<void> {
  for (const orgId of fixture.createdOrgIds) {
    try {
      await withBypass(() => dropSampleCloneOrg(orgId));
    } catch (error) {
      console.error(`clone-global-keys teardown: could not drop clone org ${orgId}`, error);
    }
  }
  await withBypass(() => dropScratchOrg(fixture.templateOrgId));
  await withBypass(() => dropScratchOrg(fixture.memberOrgId));
}

function stubTemplate(fixture: Fixture) {
  return {
    prepareTemplate: async () => ({
      industryKey: INDUSTRY,
      profileId: INDUSTRY,
      templateOrgId: fixture.templateOrgId,
      templateName: "Atlas Components Manufacturing",
      generated: false,
      coverage: { documents: 1, postedEntries: 1, parties: 1, periods: 1, adminRoles: 1 },
    }),
  };
}

async function count(orgId: string, table: string): Promise<number> {
  return withBypassContext(async () => (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from ${sql.identifier(table)} where org_id = ${orgId}
  `)).rows[0]!.n);
}

test(
  "a manufacturing clone carries posted history and drops global operational keys",
  { skip: !DB },
  async () => {
    const fixture = await seedFixture();
    try {
      const result = await createSampleCompany(
        {
          industryKey: INDUSTRY,
          memberUserId: fixture.memberUserId,
          sourceOrgId: fixture.memberOrgId,
          memberName: "Atlas requester",
          features: {},
        },
        stubTemplate(fixture),
      );
      assert.equal(result.created, true);
      fixture.createdOrgIds.push(result.orgId);

      // Posted financial history survived the birth.
      assert.equal(await count(result.orgId, "documents"), 2);
      const postedEntries = await withBypassContext(async () => (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_entries
         where org_id = ${result.orgId} and status = 'posted'
      `)).rows[0]!.n);
      assert.equal(postedEntries, 1);

      // Executable scheduler work stays behind: never replay the source's
      // side effects, never collide with its dedup keys.
      assert.equal(await count(result.orgId, "scheduler_outbox"), 0);

      // Flow run history is kept but its global dedup key is cleared.
      assert.equal(await count(result.orgId, "flow_runs"), 1);
      const keys = await withBypassContext(async () => (await db.execute<{ occurrence_key: string | null }>(sql`
        select occurrence_key from flow_runs where org_id = ${result.orgId}
      `)).rows);
      assert.deepEqual(keys.map((row) => row.occurrence_key), [null]);

      // The signing-link bearer token stays behind with its document's
      // signers; the HR document itself is ordinary history and is kept.
      assert.equal(await count(result.orgId, "hrm_document_signers"), 0);
      assert.equal(await count(result.orgId, "hrm_documents"), 1);

      // The company is ready, granted, and discoverable: the status the
      // /data/import API serves names it.
      const statuses = await sampleCompanyStatuses(fixture.memberUserId);
      const manufacturing = statuses.find((s) => s.industryKey === INDUSTRY);
      assert.equal(manufacturing?.existingOrgId, result.orgId);
      const access = await withBypassContext(async () => (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from user_org_access
         where org_id = ${result.orgId} and member_user_id = ${fixture.memberUserId} and is_active
      `)).rows[0]!.n);
      assert.equal(access, 1);
    } finally {
      await dropFixture(fixture);
    }
  },
);

test(
  "a mid-copy clone failure leaves no shell org and the status stays truthful",
  { skip: !DB },
  async () => {
    // OM-14: "Nothing was created" and existingOrgId=null are only true
    // when the failed birth's shell is compensated before the refusal is
    // reported. Inject the failure after a real clone commits its shell, so
    // only the compensation stands between the test and a stranded org.
    const fixture = await seedFixture();
    try {
      const cloneCompany: typeof cloneSampleCompanyTemplate = async (args) => {
        const cloned = await cloneSampleCompanyTemplate(args);
        throw new Error(`injected mid-copy failure after ${cloned.sandboxOrgId}`);
      };
      await assert.rejects(
        createSampleCompany(
          {
            industryKey: INDUSTRY,
            memberUserId: fixture.memberUserId,
            sourceOrgId: fixture.memberOrgId,
            memberName: "Atlas requester",
            features: {},
          },
          { ...stubTemplate(fixture), cloneCompany },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /copying the template's posted history failed/);
          assert.match(error.message, /Nothing was created; you can retry/);
          return true;
        },
      );
      // No org row carries this attempt's birth marker: the shell is gone,
      // not merely unlisted.
      const shells = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
        select id from orgs
         where settings->'sampleCompany'->>'ownerUserId' = ${fixture.memberUserId}
           and settings->'sampleCompany'->>'industryKey' = ${INDUSTRY}
      `)).rows);
      assert.deepEqual(shells, []);
      // ...and the API state matches: no ready company, no resumable
      // partial, so existingOrgId=null tells the truth.
      const statuses = await sampleCompanyStatuses(fixture.memberUserId);
      const manufacturing = statuses.find((s) => s.industryKey === INDUSTRY);
      assert.equal(manufacturing?.existingOrgId, null);
    } finally {
      await dropFixture(fixture);
    }
  },
);
