import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../composition/install.ts";
import { decideGate } from "../flows/gates.ts";
import { db, withBypass, withBypassContext, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { postEntry } from "../journal/post-entry.ts";
import { createFund, setFundPair } from "./funds.ts";
import { NonprofitError } from "./errors.ts";
import { setFramework } from "./frameworks.ts";
import { provisionFundAccounting } from "./provision.ts";
import { createFundRelease, submitFundRelease, voidFundRelease } from "./releases.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, seedApprovalFlow } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
test("fund releases route approval, post and reverse, and refuse unsafe class or balance changes", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const drafter = await withBypass(() => createScratchUser(org.orgId, "Release Drafter", "accountant"));
    const approver = await withBypass(() => createScratchUser(org.orgId, "Release Approver", "approver"));
    installEngineSeams();

    await assert.rejects(
      setFramework({ orgId: org.orgId, framework: "us_asc958", actorId: drafter, reason: "Initial framework" }),
      (error) => error instanceof NonprofitError && error.code === "feature_off" &&
      error.message.includes("fundAccounting") && error.remedy.includes("Company Settings → Features"),
    );
    await withOrgContext(org.orgId, async () => {
      const enabled = await db.execute(sql`
        update orgs
           set settings = jsonb_set(
             coalesce(settings, '{}'::jsonb), '{features}',
             coalesce(settings->'features', '{}'::jsonb) || '{"nonprofit":true,"fundAccounting":true}'::jsonb,
             true
           )
         where id = ${org.orgId}
        returning id
      `);
      assert.equal(enabled.rows.length, 1);
    });
    const setup = await provisionFundAccounting({
      orgId: org.orgId,
      defaultFund: { code: "UNRESTRICTED", name: "Unrestricted Fund" },
      classifications: {
        UNRESTRICTED: { kind: "operating", restrictionClass: "without_donor_restrictions" },
      },
      actorId: drafter,
    });
    const restricted = await createFund({
      orgId: org.orgId,
      code: "SCHOLARSHIP",
      name: "Scholarship Fund",
      kind: "restricted",
      restrictionClass: "with_donor_restrictions",
      actorId: drafter,
    });
    await setFramework({ orgId: org.orgId, framework: "us_asc958", actorId: drafter, reason: "Adopt US nonprofit reporting" });
    await setFundPair({ orgId: org.orgId, fromFundId: setup.defaultFundId, toFundId: restricted.id,
      dueFromAccountId: org.accounts.ar, dueToAccountId: org.accounts.ap, actorId: drafter, reason: "Settle interfund balances for release fixtures" });
    await withOrgTransaction(org.orgId, () => postEntry(db, {
      orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId,
      entryNumber: `RELEASE-OPEN-${randomUUID()}`, postingDate: org.date, periodId: org.periodId,
      currency: "CAD", actorId: drafter, origin: "journal", memo: "Restricted support",
      lines: [
        { accountId: org.accounts.bank, amount: "1000.0000", extraDims: { fund: restricted.id } },
        { accountId: org.accounts.revenue, amount: "-1000.0000", extraDims: { fund: restricted.id } },
      ],
    }));
    await withBypassContext(() => seedApprovalFlow(org.orgId, {
      subjectKind: "fund_release", assignees: [
        { type: "user", userId: drafter }, { type: "user", userId: approver },
      ],
      mode: "any", gateTitle: "Restricted release approval",
    }));
    const gatedDraft = await createFundRelease({
      orgId: org.orgId,
      fromFundId: restricted.id,
      toFundId: setup.defaultFundId,
      releaseAccountId: org.accounts.revenue,
      releaseDate: org.date,
      amount: "200.0000",
      purpose: "Award expenses met",
      satisfactionRef: "Scholarship award terms",
      actorId: drafter,
    });
    const pending = await submitFundRelease({ orgId: org.orgId, releaseId: gatedDraft.id, actorId: drafter });
    assert.equal(pending.status, "pending_approval");
    const gate = await withOrgContext(org.orgId, async () =>
      (await db.execute<{ id: string; assignee: string }>(sql`
        select id, assignee_user_id::text as assignee from flow_gates
         where org_id = ${org.orgId} and subject_id = ${gatedDraft.id} and status = 'pending'
      `)).rows[0],
    );
    assert.equal(gate?.assignee, approver, "Flows must exclude the drafter from the approval gate");
    await withOrgContext(org.orgId, () => decideGate({ gateId: gate!.id, decision: "approved", userId: approver }));
    const gatedStatus = await withOrgContext(org.orgId, async () =>
      (await db.execute<{ status: string; posted_entry_id: string }>(sql`
        select status, posted_entry_id::text from fund_releases where org_id = ${org.orgId} and id = ${gatedDraft.id}
      `)).rows[0],
    );
    assert.equal(gatedStatus?.status, "posted", "approval must post the release entry");
    assert.ok(gatedStatus?.posted_entry_id);
    await withOrgContext(org.orgId, () => db.execute(sql`
      update flows set enabled = false where org_id = ${org.orgId} and subject_kind = 'fund_release'
    `));
    const directDraft = await createFundRelease({
      orgId: org.orgId,
      fromFundId: restricted.id,
      toFundId: setup.defaultFundId,
      releaseAccountId: org.accounts.revenue,
      releaseDate: org.date,
      amount: "100.0000",
      purpose: "Award expenses met",
      satisfactionRef: "Second scholarship award",
      actorId: drafter,
    });
    const direct = await submitFundRelease({ orgId: org.orgId, releaseId: directDraft.id, actorId: drafter });
    assert.equal(direct.status, "posted", "an ungated organization posts directly");
    const voided = await voidFundRelease({
      orgId: org.orgId,
      releaseId: direct.id,
      actorId: drafter,
      voidDate: org.date,
      reason: "The award charge was entered twice",
    });
    assert.equal(voided.status, "void");
    assert.ok(voided.voidEntryId);
    const excess = await createFundRelease({
      orgId: org.orgId,
      fromFundId: restricted.id,
      toFundId: setup.defaultFundId,
      releaseAccountId: org.accounts.revenue,
      releaseDate: org.date,
      amount: "900.0000",
      purpose: "Award expenses met",
      satisfactionRef: "Excess request",
      actorId: drafter,
    });
    await assert.rejects(
      submitFundRelease({ orgId: org.orgId, releaseId: excess.id, actorId: drafter }),
      (error) => error instanceof NonprofitError && error.code === "fund_release_over_available" &&
        error.message.includes("800.0000") && error.message.includes("900.0000"),
    );
    await assert.rejects(
      createFundRelease({
        orgId: org.orgId,
        fromFundId: setup.defaultFundId,
        toFundId: restricted.id,
        releaseAccountId: org.accounts.revenue,
        releaseDate: org.date,
        amount: "1.0000",
        purpose: "Invalid class movement",
        satisfactionRef: "No authorized pair",
        actorId: drafter,
      }),
      (error) => error instanceof NonprofitError && error.code === "fund_release_class_pair_undeclared" &&
        error.message.includes("without_donor_restrictions") &&
        error.message.includes("with_donor_restrictions") && error.message.includes("us_asc958"),
    );
    await assert.rejects(
      setFramework({ orgId: org.orgId, framework: "ew_sorp_frs102", actorId: drafter, reason: "Change reporting basis" }),
      (error) => error instanceof NonprofitError && error.code === "nonprofit_framework_has_posted_history" &&
        error.message.includes("posted fund-tagged journal line"),
    );
    await assert.rejects(
      withOrgContext(org.orgId, () => db.execute(sql`
        update nonprofit_frameworks set framework = 'ew_sorp_frs102' where org_id = ${org.orgId}
      `)),
      (error) => error instanceof Error && error.cause instanceof Error &&
        /cannot change or be removed while \d+ posted fund-tagged journal lines exist/.test(error.cause.message),
      "the database guard must protect direct setup writes as well as the service",
    );
    await withOrgContext(org.orgId, () => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features,fundAccounting}', 'false'::jsonb, true) where id = ${org.orgId}
    `));
    await assert.rejects(
      submitFundRelease({ orgId: org.orgId, releaseId: excess.id, actorId: drafter }),
      (error) => error instanceof NonprofitError && error.code === "feature_off" &&
        error.message.includes("fundAccounting") && error.remedy.includes("Company Settings → Features"),
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
