import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "@openbooks/engine/testing/fixtures";
import { createSetupRecord, updateSetupRecord } from "./write.ts";

const skip = !process.env.OPENBOOKS_DB_URL;
const entity = "payroll-us-filing-account-employer-lineage";
async function setup() {
  const org = await withBypass(() => createScratchOrg());
  const actorId = await withBypass(() =>
    createScratchUser(org.orgId, "Payroll registration administrator", "admin"),
  );
  await withBypass(async () => {
    await db.execute(
      sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"payroll":true,"multiSubsidiary":true}'::jsonb) where id=${org.orgId}`,
    );
    await db.execute(
      sql`update subsidiaries set country='US' where org_id=${org.orgId} and id=${org.subsidiaryId}`,
    );
  });
  const actor = {
    orgId: org.orgId,
    id: actorId,
    permissions: ["admin.setup.manage"],
    allowedSubsidiaryIds: null,
  };
  const save = async (programType: string, name: string) => {
    const result = await withBypass(() =>
      createSetupRecord(actor, "payroll-filing-accounts", {
        country: "US",
        programType,
        name,
        accountNumber: randomUUID(),
        subsidiaryId: org.subsidiaryId,
        ...(programType === "us_state_sui" ? { stateCode: "NJ" } : {}),
        isActive: true,
      }),
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return String(result.body.id);
  };
  const ein = await save("us_ein", "Original federal employer");
  const state = await save("us_state_sui", "New Jersey registration");
  const body = {
    filingAccountId: state,
    federalAccountId: ein,
    subsidiaryId: org.subsidiaryId,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    sourceReference: "Original New Jersey employer registration letter",
    changeReason: "Qualify the original registered federal employer",
  };
  return { ...org, actor, body, ein, state };
}

test(
  "native Setup qualification replays exactly, audits evidence and refuses changed retry, missing evidence and scope",
  { skip },
  async () => {
    const f = await setup();
    try {
      const requestId = randomUUID();
      const save = (body = f.body) =>
        withBypass(() => createSetupRecord(f.actor, entity, body, { requestId }));
      const first = await save();
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.deepEqual(await save(), first);
      assert.equal(
        (await save({ ...f.body, sourceReference: "Different registration evidence" })).status,
        409,
      );
      assert.equal(
        (
          await withBypass(() =>
            createSetupRecord(f.actor, entity, { ...f.body, sourceReference: "" }),
          )
        ).status,
        400,
      );
      const outOfScope = { ...f.actor, allowedSubsidiaryIds: new Set([randomUUID()]) };
      assert.equal(
        (
          await withBypass(() =>
            createSetupRecord(outOfScope, entity, { ...f.body, effectiveFrom: "2027-01-01" }),
          )
        ).status,
        403,
      );
      const audit = await withBypass(() =>
        db.execute<{
          actor_id: string;
          changes: { after: { source_reference: string; change_reason: string } };
        }>(
          sql`
      select actor_id, changes from audit_log where org_id=${f.orgId} and table_name='payroll_us_filing_account_employer_lineage'
    `,
          "objects",
        ),
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.actor_id, f.actor.id);
      assert.equal(audit[0]!.changes.after.source_reference, f.body.sourceReference);
      assert.equal(audit[0]!.changes.after.change_reason, f.body.changeReason);
    } finally {
      await withBypass(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "overlapping affiliation races retain one original source; explicit closing permits the next inclusive window",
  { skip },
  async () => {
    const f = await setup();
    try {
      const outcomes = await Promise.all([
        withBypass(() => createSetupRecord(f.actor, entity, f.body)),
        withBypass(() =>
          createSetupRecord(f.actor, entity, {
            ...f.body,
            changeReason: "Second concurrent qualification",
          }),
        ),
      ]);
      assert.deepEqual(outcomes.map((result) => result.status).sort(), [200, 409]);
      const id = String(outcomes.find((result) => result.status === 200)!.body.id);
      const closed = await withBypass(() =>
        updateSetupRecord(f.actor, entity, {
          id,
          effectiveTo: "2026-06-30",
          changeReason: "Registration transferred after June 30",
        }),
      );
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      const next = await withBypass(() =>
        createSetupRecord(f.actor, entity, {
          ...f.body,
          effectiveFrom: "2026-07-01",
          changeReason: "Retain the next original registration interval",
        }),
      );
      assert.equal(next.status, 200, JSON.stringify(next.body));
      const mutation = await withBypass(() =>
        updateSetupRecord(f.actor, "payroll-filing-accounts", { id: f.state, stateCode: "NY" }),
      );
      assert.equal(mutation.status, 400);
      assert.match(String(mutation.body.error), /retained employer EIN history/);
    } finally {
      await withBypass(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "cross-organization EIN and wrong legal-employer registration are rejected by native authoring",
  { skip },
  async () => {
    const a = await setup();
    const b = await setup();
    try {
      const foreign = await withBypass(() =>
        createSetupRecord(a.actor, entity, { ...a.body, federalAccountId: b.ein }),
      );
      assert.equal(foreign.status, 400);
      assert.match(String(foreign.body.error), /same native legal employer/);
      const wrongEmployer = await withBypass(() =>
        createSetupRecord(a.actor, entity, { ...a.body, subsidiaryId: b.subsidiaryId }),
      );
      assert.equal(wrongEmployer.status, 400);
    } finally {
      await withBypass(() => dropScratchOrgReporting(a.orgId));
      await withBypass(() => dropScratchOrgReporting(b.orgId));
    }
  },
);
