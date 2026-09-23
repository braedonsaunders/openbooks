import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  createSampleCompany,
  generateTemplate,
  SampleCompanyPreconditionError,
  SampleCompanyProvisioningError,
  sampleCompanyStageMessage,
} from "./service.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { db, withBypass, withBypassContext, withOrgContext } from "../platform/db.ts";
import { loadRun } from "../sim/runner.ts";
import type { RunManifest } from "../sim/manifest.ts";
import { SIM_ORG_PREFIX } from "../sim/db-guard.ts";
import { wipeSimOrg } from "../sim/world.ts";
import { createScriptJournal } from "../ledger/journal-writes.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropSampleCloneOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";

// SC-RESUME: a failed sample-company creation after cloning must leave a
// resumable company (never a stranded org, never silent success), and the
// retry must resume it instead of cloning a second company.

const DB = !!process.env.OPENBOOKS_DB_URL;

const INDUSTRY = "general_business";

interface Fixture {
  memberOrgId: string;
  memberUserId: string;
  templateOrgId: string;
  input: {
    industryKey: string;
    memberUserId: string;
    sourceOrgId: string;
    memberName: string;
    features: Record<string, boolean>;
  };
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
    // Numbered invoices with a gap: the resume must advance the canonical
    // sequence past the HIGHEST cloned number, so the next invoice is
    // INV-(7+1) and never reuses INV-0007 or fills the gap.
    for (const number of ["INV-0001", "INV-0002", "INV-0007"]) {
      await withBypass(() =>
        db.execute(sql`
          insert into documents (id, org_id, kind, document_number, document_date, currency, status)
          values (${randomUUID()}, ${template.orgId}, 'customer_invoice', ${number}, '2026-07-10', 'CAD', 'draft')`),
      );
    }
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
    createScratchUser(memberOrg.orgId, "Sample requester", "admin"),
  );
  const fixture: Fixture = {
    memberOrgId: memberOrg.orgId,
    memberUserId,
    templateOrgId,
    input: {
      industryKey: INDUSTRY,
      memberUserId,
      sourceOrgId: memberOrg.orgId,
      memberName: "Sample requester",
      features: {},
    },
    createdOrgIds: [],
  };
  return fixture;
}

async function dropFixture(fixture: Fixture): Promise<void> {
  for (const orgId of fixture.createdOrgIds) {
    try {
      await withBypass(() => dropSampleCloneOrg(orgId));
    } catch {
      // Best-effort cleanup: the test already failed if strays remain, and a
      // throwing cleanup would mask the assertion that matters.
    }
  }
  await withBypass(() => dropScratchOrg(fixture.templateOrgId));
  await withBypass(() => dropScratchOrg(fixture.memberOrgId));
}

function stubTemplate(fixture: Fixture) {
  return {
    prepareTemplate: async () => ({
      industryKey: INDUSTRY,
      profileId: "general-business",
      templateOrgId: fixture.templateOrgId,
      templateName: "Resume template",
      generated: false,
      coverage: { documents: 3, postedEntries: 0, parties: 0, periods: 1, adminRoles: 1 },
    }),
  };
}

async function sampleOrgsFor(memberUserId: string): Promise<
  Array<{ id: string; name: string; envKind: string; stage: string | null; hasAccess: boolean }>
> {
  return withBypassContext(async () => {
    const result = await db.execute<{
      id: string;
      name: string;
      envKind: string;
      stage: string | null;
      hasAccess: boolean;
    }>(sql`
      select o.id, o.name, o.env_kind as "envKind",
             o.settings->'sampleCompany'->>'provisioningStage' as stage,
             exists (
               select 1 from user_org_access access
                where access.org_id = o.id
                  and access.member_user_id = ${memberUserId}
                  and access.is_active
             ) as "hasAccess"
        from orgs o
       where o.settings->'sampleCompany'->>'ownerUserId' = ${memberUserId}
         and o.settings->'sampleCompany'->>'industryKey' = ${INDUSTRY}
       order by o.created_at asc
    `);
    return result.rows;
  });
}

async function orgStage(orgId: string): Promise<string | null> {
  return withBypassContext(async () => {
    const result = await db.execute<{ stage: string | null }>(sql`
      select settings->'sampleCompany'->>'provisioningStage' as stage
        from orgs where id = ${orgId}`);
    return result.rows[0]?.stage ?? null;
  });
}

async function maxInvoiceNumber(orgId: string): Promise<number> {
  return withBypassContext(async () => {
    const result = await db.execute<{ mx: number }>(sql`
      select coalesce(max(substring(document_number from length('INV-') + 1)::int), 0) as mx
        from documents
       where org_id = ${orgId}
         and kind = 'customer_invoice'
         and starts_with(document_number, 'INV-')`);
    return Number(result.rows[0]?.mx ?? 0);
  });
}

async function sequenceNext(orgId: string, kind: string): Promise<number | null> {
  return withBypassContext(async () => {
    const result = await db.execute<{ next_number: number }>(sql`
      select next_number from number_sequences
       where org_id = ${orgId} and document_kind = ${kind}`);
    return result.rows[0] ? Number(result.rows[0].next_number) : null;
  });
}

test(
  "a finalize failure leaves one resumable company with no access; retry completes it",
  { skip: !DB },
  async () => {
    const fixture = await seedFixture();
    try {
      let calls = 0;
      await assert.rejects(
        createSampleCompany(fixture.input, {
          ...stubTemplate(fixture),
          finalizeCompany: async () => {
            calls += 1;
            throw new Error("simulated finalize outage");
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof SampleCompanyProvisioningError);
          assert.equal(error.stage, "finalize");
          assert.equal(error.message, sampleCompanyStageMessage("finalize"));
          // The refusal must describe what actually exists: the company was
          // created and the retry resumes it — never "nothing was created".
          assert.match(error.message, /The company was created but its setup did not finish/);
          assert.match(error.message, /retry resumes it from where it stopped/);
          assert.doesNotMatch(error.message, /Nothing was created/);
          return true;
        },
      );
      assert.equal(calls, 1);

      const partials = await sampleOrgsFor(fixture.memberUserId);
      assert.equal(partials.length, 1, "exactly one partial company must exist");
      assert.equal(partials[0]!.stage, "cloned");
      assert.equal(partials[0]!.hasAccess, false, "no user may access a partial company");
      fixture.createdOrgIds.push(partials[0]!.id);

      const resumed = await createSampleCompany(fixture.input, stubTemplate(fixture));
      assert.equal(resumed.orgId, partials[0]!.id, "the retry must resume the partial, not clone again");
      assert.equal(resumed.created, true);

      const after = await sampleOrgsFor(fixture.memberUserId);
      assert.equal(after.length, 1, "retry must leave exactly one company, no strays");
      assert.equal(after[0]!.id, partials[0]!.id);
      assert.equal(after[0]!.stage, "ready");
      assert.equal(after[0]!.hasAccess, true);

      assert.equal(await maxInvoiceNumber(after[0]!.id), 7);
      assert.ok((await sequenceNext(after[0]!.id, "customer_invoice"))! >= 7);
    } finally {
      await dropFixture(fixture);
    }
  },
);

test(
  "a numbering failure leaves a finalized company with no access; retry resumes numbering",
  { skip: !DB },
  async () => {
    const fixture = await seedFixture();
    try {
      await assert.rejects(
        createSampleCompany(fixture.input, {
          ...stubTemplate(fixture),
          reconcileNumbering: async () => {
            throw new Error("simulated numbering outage");
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof SampleCompanyProvisioningError);
          assert.equal(error.stage, "numbering");
          assert.equal(error.message, sampleCompanyStageMessage("numbering"));
          assert.match(error.message, /The company was created but its document numbering was not finished/);
          assert.match(error.message, /retry resumes numbering/);
          return true;
        },
      );

      const partials = await sampleOrgsFor(fixture.memberUserId);
      assert.equal(partials.length, 1);
      assert.equal(partials[0]!.stage, "finalized");
      assert.equal(partials[0]!.hasAccess, false, "no user may access a company with unreconciled numbering");
      fixture.createdOrgIds.push(partials[0]!.id);

      const resumed = await createSampleCompany(fixture.input, stubTemplate(fixture));
      assert.equal(resumed.orgId, partials[0]!.id);
      assert.equal(await orgStage(resumed.orgId), "ready");

      const after = await sampleOrgsFor(fixture.memberUserId);
      assert.equal(after.length, 1, "retry must leave exactly one company, no strays");

      // The next invoice continues past the highest sample number (OM-01).
      assert.equal(await maxInvoiceNumber(resumed.orgId), 7);
      const next = await withBypass(() =>
        allocateDocumentNumber(db, resumed.orgId, "customer_invoice", "INV-"),
      );
      assert.match(next, /^INV-0*8$/, `next invoice must follow INV-0007, got ${next}`);
    } finally {
      await dropFixture(fixture);
    }
  },
);

test(
  "a forced simulator failure wipes the attempt org: retry leaves none behind",
  { skip: !DB },
  async () => {
    const fixture = await seedFixture();
    try {
      await assert.rejects(
        createSampleCompany(fixture.input, {
          prepareTemplate: async (industryKey: string) => {
            // The failure happens inside template generation; the service
            // stages it and the attempt must already be wiped when it does.
            const template = await generateTemplate("general-business", {
              simulateTemplate: async () => {
                throw new Error("simulated simulator outage");
              },
            });
            return {
              industryKey,
              profileId: "general-business",
              templateOrgId: template.id,
              templateName: template.name,
              generated: true,
              coverage: {
                documents: template.documents,
                postedEntries: template.postedEntries,
                parties: template.parties,
                periods: template.periods,
                adminRoles: template.adminRoles,
              },
            };
          },
        }),
        (error: unknown) => {
          // Staged with the fixed template message — and the message is
          // true because the attempt was wiped before it was reported.
          assert.ok(error instanceof SampleCompanyProvisioningError);
          assert.equal(
            (error as SampleCompanyProvisioningError).stage,
            "template",
          );
          assert.equal(error.message, sampleCompanyStageMessage("template"));
          assert.match(error.message, /Nothing was created; you can retry/);
          return true;
        },
      );
      assert.deepEqual(await templateAttemptOrgs("general-business"), []);
      assert.deepEqual(await simProfileOrgs("general-business"), []);
    } finally {
      await dropFixture(fixture);
    }
  },
);

test(
  "a successful retry after a simulator failure leaves exactly one template org",
  { skip: !DB },
  async () => {
    // A stale attempt from an earlier crashed generation must be swept
    // before provisioning, so the retry converges on exactly one org.
    const staleId = await seedStaleTemplateAttempt("general-business");
    try {
      const template = await generateTemplate("general-business", {
        simulateTemplate: fakeSuccessfulSimulate,
      });
      assert.ok(template.id);

      const remaining = await simProfileOrgs("general-business");
      assert.deepEqual(
        remaining.map((row) => row.id).sort(),
        [template.id].sort(),
        "the sweep must remove the stale attempt and the retry must provision exactly one org",
      );
      assert.ok(
        !(await hasTemplateAttemptMarker(template.id)),
        "the attempt marker must clear once the template converges",
      );
      assert.equal(await templateOracleStatus(template.id), "passed");
      assert.ok(staleId !== template.id);
    } finally {
      for (const row of await simProfileOrgs("general-business")) {
        await withBypass(() => wipeSimOrg(row.id));
      }
    }
  },
);

test(
  "a template attempt that cannot be wiped blocks before a second org is created",
  { skip: !DB },
  async () => {
    const staleId = await seedStaleTemplateAttempt("general-business");
    try {
      await assert.rejects(
        generateTemplate("general-business", {
          simulateTemplate: fakeSuccessfulSimulate,
          wipeTemplateAttempt: async () => {
            throw new Error("simulated environment refusal");
          },
        }),
        (error: unknown) => {
          // The blocked refusal is NOT staged: its specific message names
          // the stranded org and the remedy that clears it.
          assert.ok(error instanceof SampleCompanyPreconditionError);
          assert.match(String((error as Error).message), new RegExp(staleId));
          assert.match(
            String((error as Error).message),
            /npm run sim -- reset-org/,
          );
          return true;
        },
      );
      // Nothing new was provisioned beside the stuck attempt.
      assert.deepEqual(
        (await simProfileOrgs("general-business")).map((row) => row.id),
        [staleId],
      );
    } finally {
      await withBypass(() => wipeSimOrg(staleId));
    }
  },
);

async function templateAttemptOrgs(profileId: string): Promise<Array<{ id: string }>> {
  return withBypassContext(async () => {
    const result = await db.execute<{ id: string }>(sql`
      select id from orgs
       where settings->'sampleTemplateAttempt'->>'profileId' = ${profileId}`);
    return result.rows;
  });
}

async function simProfileOrgs(profileId: string): Promise<Array<{ id: string }>> {
  return withBypassContext(async () => {
    const result = await db.execute<{ id: string }>(sql`
      select id from orgs where settings->>'simProfile' = ${profileId}`);
    return result.rows;
  });
}

async function hasTemplateAttemptMarker(orgId: string): Promise<boolean> {
  return withBypassContext(async () => {
    const result = await db.execute<{ marked: boolean }>(sql`
      select (settings ? 'sampleTemplateAttempt') as marked from orgs where id = ${orgId}`);
    return result.rows[0]?.marked ?? false;
  });
}

async function templateOracleStatus(orgId: string): Promise<string | null> {
  return withBypassContext(async () => {
    const result = await db.execute<{ status: string | null }>(sql`
      select settings->'sampleTemplateOracle'->>'status' as status
        from orgs where id = ${orgId}`);
    return result.rows[0]?.status ?? null;
  });
}

/** A crashed generation's footprint: marked attempt, no oracle, no data. */
async function seedStaleTemplateAttempt(profileId: string): Promise<string> {
  const orgId = randomUUID();
  await withBypass(() =>
    db.execute(sql`
      insert into orgs (id, name, base_currency, country, settings, env_kind)
      values (${orgId}, ${`${SIM_ORG_PREFIX}stale attempt`}, 'USD', 'US',
              ${JSON.stringify({
                simHarness: true,
                simProfile: profileId,
                sampleTemplateAttempt: {
                  version: 1,
                  profileId,
                  seed: "openbooks-sample-v1",
                  stage: "provisioned",
                  attemptedAt: new Date().toISOString(),
                },
              })}::jsonb, 'production')`),
  );
  return orgId;
}

/**
 * Stand-in for the simulator day loop: it seeds the minimum coverage the
 * template verifier requires (8 documents, 4 posted entries) through the
 * product journal API, then reports a clean completed run. The test proves
 * the attempt state machine around the driver, not the driver itself.
 */
async function fakeSuccessfulSimulate(runDir: string): Promise<RunManifest> {
  const { manifest, world } = loadRun(runDir);
  for (let i = 1; i <= 8; i++) {
    await withBypass(() =>
      db.execute(sql`
        insert into documents (id, org_id, kind, document_number, document_date, currency, status)
        values (${randomUUID()}, ${world.orgId}, 'customer_invoice', ${`SIM-000${i}`}, ${manifest.startDate}, ${world.currency}, 'draft')`),
    );
  }
  for (let i = 0; i < 4; i++) {
    await withOrgContext(world.orgId, () =>
      createScriptJournal(
        world.orgId,
        world.actors.controller,
        {
          documentDate: manifest.startDate,
          memo: `Resume coverage ${i}`,
          lines: [
            { accountId: world.accounts.bank!, amount: 100 },
            { accountId: world.accounts.ar!, amount: -100 },
          ],
        },
        { post: true },
      ),
    );
  }
  return { ...manifest, status: "completed", defects: [] };
}

test(
  "an interrupted clone is compensated, never resumed; retry provisions exactly one company",
  { skip: !DB },
  async () => {
    const fixture = await seedFixture();
    try {
      const first = await createSampleCompany(fixture.input, stubTemplate(fixture));
      assert.equal(await orgStage(first.orgId), "ready");

      // Simulate a clone that copied rows but never reported back: the
      // birth marker says 'cloned', the clone engine never marked it ready,
      // and no access was ever granted. The data may be half-copied, so the
      // retry must delete it and provision fresh — never resume it.
      await withBypass(() =>
        db.execute(sql`
          update orgs
             set settings = jsonb_set(settings, '{sampleCompany,provisioningStage}', '"cloned"', true)
           where id = ${first.orgId}`),
      );
      await withBypass(() =>
        db.execute(sql`
          delete from user_org_access
           where org_id = ${first.orgId} and member_user_id = ${fixture.memberUserId}`),
      );
      await withBypass(() =>
        db.execute(sql`
          update sandboxes set status = 'provisioning', updated_at = now()
           where org_id = ${first.orgId}`),
      );

      const second = await createSampleCompany(fixture.input, stubTemplate(fixture));
      assert.notEqual(
        second.orgId,
        first.orgId,
        "the interrupted clone must be replaced, not resumed",
      );
      fixture.createdOrgIds.push(second.orgId);

      const after = await sampleOrgsFor(fixture.memberUserId);
      assert.equal(after.length, 1, "compensation must leave exactly one company");
      assert.equal(after[0]!.id, second.orgId);
      assert.equal(after[0]!.stage, "ready");
      assert.equal(after[0]!.hasAccess, true);

      const leftover = await withBypassContext(async () => {
        const result = await db.execute<{ n: number }>(sql`
          select count(*)::int as n from orgs where id = ${first.orgId}`);
        return result.rows[0]!.n;
      });
      assert.equal(leftover, 0, "the interrupted clone must actually be gone");
    } finally {
      await dropFixture(fixture);
    }
  },
);

test(
  "an unresumable partial is compensated through deletion before re-provisioning",
  { skip: !DB },
  async () => {
    const fixture = await seedFixture();
    try {
      await assert.rejects(
        createSampleCompany(fixture.input, {
          ...stubTemplate(fixture),
          finalizeCompany: async () => {
            throw new Error("simulated finalize outage");
          },
        }),
        /setup did not finish/,
      );
      const partials = await sampleOrgsFor(fixture.memberUserId);
      assert.equal(partials.length, 1);
      const strandedId = partials[0]!.id;

      // Corrupt the marker beyond any resumable stage.
      await withBypass(() =>
        db.execute(sql`
          update orgs
             set settings = jsonb_set(settings, '{sampleCompany,provisioningStage}', '"abandoned"', true)
           where id = ${strandedId}`),
      );

      const fresh = await createSampleCompany(fixture.input, stubTemplate(fixture));
      assert.notEqual(fresh.orgId, strandedId, "the unresumable partial must be replaced, not adopted");
      fixture.createdOrgIds.push(fresh.orgId);

      const after = await sampleOrgsFor(fixture.memberUserId);
      assert.equal(after.length, 1, "compensation must leave exactly one company");
      assert.equal(after[0]!.id, fresh.orgId);
      assert.equal(after[0]!.stage, "ready");

      const stranded = await withBypassContext(async () => {
        const result = await db.execute<{ n: number }>(sql`
          select count(*)::int as n from orgs where id = ${strandedId}`);
        return result.rows[0]!.n;
      });
      assert.equal(stranded, 0, "the compensated partial must actually be gone");
    } finally {
      await dropFixture(fixture);
    }
  },
);
