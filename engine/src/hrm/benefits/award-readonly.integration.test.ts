import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../../composition/install.ts";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { seedPayrollBenefitProgram } from "../../testing/benefit-fixtures.ts";
import {
  mkHr,
  mkSecondSubsidiary,
  seedComponent,
  seedEmployment,
  setFeatures,
  setupHarness,
  withHarness,
} from "../../testing/hrm-harness.ts";
import { createBenefitAward, getBenefitAward } from "./awards.ts";
import { assertHrmReadEnabled } from "./shared.ts";
const DB = !!process.env.OPENBOOKS_DB_URL;
const spec = {
  users: [
    {
      key: "managerId",
      name: "Benefit reader",
      handle: "benefit_reader",
      permissions: ["hrm.benefits.read", "hrm.benefits.manage"],
      link: true,
    },
    {
      key: "ungrantedId",
      name: "Ungrant reader",
      handle: "ungrant_reader",
      permissions: [],
      link: true,
    },
  ],
} as const;
async function setup() {
  installEngineSeams();
  const h = await setupHarness(spec);
  assert.equal(
    (
      await db.execute(
        sql`update subsidiaries set base_currency='USD'
  where org_id=${h.org.orgId} and id=${h.org.subsidiaryId} returning id`,
        "objects",
      )
    ).length,
    1,
  );
  const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
  const component = await seedComponent(h.org.orgId, {
    kind: "earning",
    code: "READ_REWARD",
  });
  const program = await seedPayrollBenefitProgram(
    {
      orgId: h.org.orgId,
      actorId: h.managerId,
      subsidiaryId: h.org.subsidiaryId,
      componentId: component,
      currency: "USD",
    },
    {
      code: "READ_REWARD",
      name: "Declared reward",
      family: "reward",
      valuation: "fixed",
      fixedAmount: "100",
    },
    { employmentIds: [worker.employmentId] },
  );
  const award = await createBenefitAward({
    orgId: h.org.orgId,
    actorId: h.managerId,
    programId: program.id,
    employmentId: worker.employmentId,
    periodFrom: "2026-03-01",
    periodTo: "2026-03-31",
    currency: "USD",
    value: "100",
    sourceKey: "original-reward",
    evidence: { source: "Declared employer reward" },
  });
  return { ...h, worker, program, award };
}
const readOnly = { readOnly: true, isolationLevel: "REPEATABLE READ" } as const;
test(
  "native award reads succeed on an actual readonly snapshot without changing protected evidence",
  { skip: !DB },
  () =>
    withHarness(setup, async (h) => {
      const retained = async () =>
        await db.execute(
          sql`select to_jsonb(a) as snapshot from hrm_benefit_awards a
  where org_id=${h.org.orgId} and id=${h.award.id}`,
          "objects",
        );
      const before = await retained();
      await withOrgTransaction(
        h.org.orgId,
        async () => {
          const actual = (
            await db.execute<{ mode: string }>(
              sql`select current_setting('transaction_read_only') as mode`,
              "objects",
            )
          )[0];
          assert.equal(actual!.mode, "on");
          const read = await getBenefitAward(db, h.org.orgId, h.managerId, h.award.id);
          assert.equal(read.id, h.award.id);
          assert.equal(read.employmentId, h.worker.employmentId);
          assert.equal(read.value, "100.0000");
          assert.deepEqual(await retained(), before);
        },
        readOnly,
      );
      assert.deepEqual(await retained(), before);
    }),
);
test(
  "readonly award admission preserves disabled-feature refusal and retained award history",
  { skip: !DB },
  () =>
    withHarness(setup, async (h) => {
      await setFeatures(h.org.orgId, { hrm: false });
      await withOrgTransaction(
        h.org.orgId,
        async () => {
          await assert.rejects(
            getBenefitAward(db, h.org.orgId, h.managerId, h.award.id),
            /benefits are unavailable while the hrm feature is off/,
          );
          assert.equal(
            (
              await db.execute(
                sql`select id from hrm_benefit_awards where org_id=${h.org.orgId} and id=${h.award.id}`,
                "objects",
              )
            ).length,
            1,
          );
        },
        readOnly,
      );
    }),
);
test(
  "readonly award admission retains actual read-duty and immutable employer scope",
  { skip: !DB },
  () =>
    withHarness(setup, async (h) => {
      const other = await mkSecondSubsidiary(h.org.orgId, h.org.subsidiaryId);
      const own = await mkHr(
        h.org.orgId,
        "Own employer reader",
        "own_award_reader",
        [h.org.subsidiaryId],
        ["hrm.benefits.read"],
      );
      const foreign = await mkHr(
        h.org.orgId,
        "Other employer reader",
        "foreign_award_reader",
        [other],
        ["hrm.benefits.read"],
      );
      await withOrgTransaction(
        h.org.orgId,
        async () => {
          await assert.rejects(
            getBenefitAward(db, h.org.orgId, h.ungrantedId, h.award.id),
            /hrm.benefits.read/,
          );
          await assert.rejects(
            getBenefitAward(db, h.org.orgId, foreign, h.award.id),
            /benefit award not found in this organization/,
          );
          assert.equal((await getBenefitAward(db, h.org.orgId, own, h.award.id)).id, h.award.id);
        },
        readOnly,
      );
    }),
);
test(
  "readonly feature admission explicitly refuses a missing organization instead of registry defaults",
  { skip: !DB },
  () =>
    withHarness(setup, async (h) => {
      await withOrgTransaction(
        h.org.orgId,
        async () => {
          await assert.rejects(
            assertHrmReadEnabled(db, randomUUID()),
            /benefits are unavailable while the hrm feature is off/,
          );
          await assertHrmReadEnabled(db, h.org.orgId);
          await assert.rejects(
            getBenefitAward(db, h.org.orgId, h.managerId, randomUUID()),
            /benefit award not found in this organization/,
          );
        },
        readOnly,
      );
    }),
);
