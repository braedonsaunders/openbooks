import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "@openbooks/engine/testing/fixtures";
import { seedEmployment } from "@openbooks/engine/testing/hrm-harness";
import { createSetupRecord, updateSetupRecord } from "./write.ts";

/**
 * Leave-policy targeting through the Setup write path: picker and tier
 * slots persist into the rule jsonb, the change reason rides the audit
 * before/after image, same-specificity overlaps refuse typed (409
 * overlap) naming the conflicting policy on create and on window edits,
 * and different-specificity overlaps keep resolving instead of refusing.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedOrg() {
  const org = await withBypass(() => createScratchOrg());
  const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId;
  await withBypass(() =>
    db.execute(sql`
    update orgs set settings = settings || '{"features": {"hrm": true}}'::jsonb
     where id = ${org.orgId}`),
  );
  const actor = { orgId: org.orgId, id: actorId, permissions: [] as string[] };
  const type = await withBypass(() =>
    createSetupRecord(actor, "leave-types", {
      code: "VAC",
      name: "Vacation",
      paid: true,
      valueCrossing: "none",
      isActive: true,
    }),
  );
  assert.equal(type.status, 200, `type refused: ${JSON.stringify(type.body)}`);
  return {
    orgId: org.orgId,
    subsidiaryId: org.subsidiaryId,
    actor,
    typeId: String((type.body as { id?: string }).id),
  };
}

function policyBody(overrides: Record<string, unknown> = {}) {
  return {
    accrualKind: "per_year",
    accrualHours: "120",
    carryoverKind: "none",
    minimumNoticeDays: 0,
    isActive: true,
    reason: "annual policy review",
    ...overrides,
  };
}

async function seedClassification(orgId: string, code: string): Promise<string> {
  return (
    await withBypass(() =>
      db.execute<{ id: string }>(
        sql`
    insert into hrm_work_classifications (org_id, code, name, trade)
    values (${orgId}, ${code}, ${code}, 'trade') returning id`,
        "objects",
      ),
    )
  )[0]!.id;
}

async function storedPolicy(orgId: string, id: string) {
  return (
    await withBypass(() =>
      db.execute<{ applies_to: unknown; accrual_rule: unknown }>(
        sql`
    select applies_to, accrual_rule from hrm_leave_policies where org_id = ${orgId} and id = ${id}`,
        "objects",
      ),
    )
  )[0];
}

async function auditReasons(orgId: string, rowId: string): Promise<unknown[]> {
  const rows = await withBypass(() =>
    db.execute<{ changes: unknown }>(
      sql`
    select changes from audit_log where org_id = ${orgId} and row_id = ${rowId} order by id`,
      "objects",
    ),
  );
  return rows.map((row) => (row.changes as Record<string, unknown>).reason);
}

test(
  "a targeted tiered create persists the fold and audits the reason",
  { skip: !DB },
  async () => {
    const org = await seedOrg();
    try {
      const { employmentId } = await withBypass(() =>
        seedEmployment(org.orgId, org.subsidiaryId, { from: "2020-01-01" }),
      );
      const cls = await seedClassification(org.orgId, "JOURNEY");
      const created = await withBypass(() =>
        createSetupRecord(
          org.actor,
          "leave-policies",
          policyBody({
            leaveTypeId: org.typeId,
            effectiveFrom: "2026-01-01",
            appliesEmploymentIds: [employmentId],
            appliesClassificationIds: [cls],
            accrualTiers: [{ after_years: 5, hours: "160" }],
          }),
        ),
      );
      assert.equal(created.status, 200, `targeted create refused: ${JSON.stringify(created.body)}`);
      const id = String((created.body as { id?: string }).id);
      const stored = await storedPolicy(org.orgId, id);
      assert.deepEqual(stored?.applies_to, {
        employer_subsidiary_id: null,
        department_id: null,
        employment_ids: [employmentId],
        classification_ids: [cls],
      });
      assert.deepEqual((stored?.accrual_rule as Record<string, unknown>).tiers, [
        { after_years: 5, hours: "160" },
      ]);
      assert.deepEqual(await auditReasons(org.orgId, id), ["annual policy review"]);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "two overlapping wildcard windows are still refused by storage itself",
  { skip: !DB },
  async () => {
    const org = await seedOrg();
    try {
      const first = await withBypass(() =>
        createSetupRecord(
          org.actor,
          "leave-policies",
          policyBody({
            leaveTypeId: org.typeId,
            effectiveFrom: "2026-01-01",
          }),
        ),
      );
      assert.equal(first.status, 200, `first policy refused: ${JSON.stringify(first.body)}`);
      // Raw SQL bypasses the advisory-lock preflight: the wildcard-only
      // exclusion must still arbitrate the race at the storage floor.
      const raced = await withBypass(() =>
        db
          .execute(
            sql`
      insert into hrm_leave_policies (org_id, leave_type_id, applies_to, accrual_rule, carryover_rule, effective_from)
      values (${org.orgId}, ${org.typeId},
        '{"employer_subsidiary_id": null, "department_id": null}'::jsonb,
        '{"kind": "per_year", "hours": "120"}'::jsonb,
        '{"kind": "none"}'::jsonb,
        '2026-06-01')
      returning id`,
          )
          .catch((error: unknown) => error),
      );
      // The driver surfaces the PG fields on cause: the code proves an
      // exclusion fired, the constraint name proves it is this guard.
      const cause = ((raced as { cause?: Record<string, unknown> }).cause ?? {}) as Record<
        string,
        unknown
      >;
      assert.equal(
        String(cause.code ?? ""),
        "23P01",
        `expected the exclusion to fire, got ${String(cause.code ?? "")}`,
      );
      assert.equal(cause.constraint, "hrm_leave_policies_no_same_scope_overlap");
      const count =
        (
          await withBypass(() =>
            db.execute<{ n: number }>(
              sql`
      select count(*)::int as n from hrm_leave_policies where org_id = ${org.orgId} and leave_type_id = ${org.typeId}`,
              "objects",
            ),
          )
        )[0]?.n ?? -1;
      assert.equal(count, 1, "the storage refusal stores no second window");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test("a pinned policy overlaps the general policy through the drawer", { skip: !DB }, async () => {
  const org = await seedOrg();
  try {
    const { employmentId } = await withBypass(() =>
      seedEmployment(org.orgId, org.subsidiaryId, { from: "2020-01-01" }),
    );
    const general = await withBypass(() =>
      createSetupRecord(
        org.actor,
        "leave-policies",
        policyBody({
          leaveTypeId: org.typeId,
          effectiveFrom: "2026-01-01",
        }),
      ),
    );
    assert.equal(general.status, 200, `general policy refused: ${JSON.stringify(general.body)}`);
    // Same type, scope, and dates as the general policy: a different
    // specificity class overlaps freely instead of conflicting.
    const pinned = await withBypass(() =>
      createSetupRecord(
        org.actor,
        "leave-policies",
        policyBody({
          leaveTypeId: org.typeId,
          effectiveFrom: "2026-01-01",
          appliesEmploymentIds: [employmentId],
          accrualHours: "200",
          reason: "senior cover",
        }),
      ),
    );
    assert.equal(pinned.status, 200, `pinned policy refused: ${JSON.stringify(pinned.body)}`);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a policy change without a reason is refused and stores nothing", { skip: !DB }, async () => {
  const org = await seedOrg();
  try {
    const { reason, ...withoutReason } = policyBody({
      leaveTypeId: org.typeId,
      effectiveFrom: "2026-01-01",
    });
    void reason;
    const created = await withBypass(() =>
      createSetupRecord(org.actor, "leave-policies", withoutReason),
    );
    assert.equal(created.status, 400);
    assert.match(
      String((created.body as { error?: string }).error),
      /reason is required|needs a reason/,
    );
    const count =
      (
        await withBypass(() =>
          db.execute<{ n: number }>(
            sql`
      select count(*)::int as n from hrm_leave_policies where org_id = ${org.orgId} and leave_type_id = ${org.typeId}`,
            "objects",
          ),
        )
      )[0]?.n ?? -1;
    assert.equal(count, 0, "the reasonless create stores nothing");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test(
  "same-specificity intersecting targets conflict typed naming the policy",
  { skip: !DB },
  async () => {
    const org = await seedOrg();
    try {
      const a = await withBypass(() =>
        seedEmployment(org.orgId, org.subsidiaryId, { from: "2020-01-01" }),
      );
      const first = await withBypass(() =>
        createSetupRecord(
          org.actor,
          "leave-policies",
          policyBody({
            leaveTypeId: org.typeId,
            effectiveFrom: "2026-01-01",
            appliesEmploymentIds: [a.employmentId],
          }),
        ),
      );
      assert.equal(first.status, 200, `first policy refused: ${JSON.stringify(first.body)}`);
      const firstId = String((first.body as { id?: string }).id);
      const clash = await withBypass(() =>
        createSetupRecord(
          org.actor,
          "leave-policies",
          policyBody({
            leaveTypeId: org.typeId,
            effectiveFrom: "2026-06-01",
            appliesEmploymentIds: [a.employmentId],
          }),
        ),
      );
      assert.equal(clash.status, 409);
      assert.equal((clash.body as { code?: string }).code, "overlap");
      assert.match(
        String((clash.body as { error?: string }).error),
        new RegExp(`Policy ${firstId} already covers`),
      );
      // A different class at a different scope pin (department-wide where
      // the first pins employments org-wide) overlaps freely: specificity
      // resolves, and storage only guards identical scope pins.
      const departmentId = (
        await withBypass(() =>
          db.execute<{ id: string }>(
            sql`
      insert into departments (org_id, name) values (${org.orgId}, 'Field') returning id`,
            "objects",
          ),
        )
      )[0]!.id;
      const broader = await withBypass(() =>
        createSetupRecord(
          org.actor,
          "leave-policies",
          policyBody({
            leaveTypeId: org.typeId,
            effectiveFrom: "2026-06-01",
            appliesDepartmentId: departmentId,
          }),
        ),
      );
      assert.equal(broader.status, 200, `broader policy refused: ${JSON.stringify(broader.body)}`);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "stretching a window into a same-class neighbour conflicts typed and moves nothing",
  { skip: !DB },
  async () => {
    const org = await seedOrg();
    try {
      const a = await withBypass(() =>
        seedEmployment(org.orgId, org.subsidiaryId, { from: "2020-01-01" }),
      );
      const b = await withBypass(() =>
        seedEmployment(org.orgId, org.subsidiaryId, { from: "2020-01-01" }),
      );
      const first = await withBypass(() =>
        createSetupRecord(
          org.actor,
          "leave-policies",
          policyBody({
            leaveTypeId: org.typeId,
            effectiveFrom: "2026-01-01",
            effectiveTo: "2026-06-30",
            appliesEmploymentIds: [a.employmentId, b.employmentId],
          }),
        ),
      );
      assert.equal(first.status, 200, `first policy refused: ${JSON.stringify(first.body)}`);
      const second = await withBypass(() =>
        createSetupRecord(
          org.actor,
          "leave-policies",
          policyBody({
            leaveTypeId: org.typeId,
            effectiveFrom: "2026-07-01",
            appliesEmploymentIds: [a.employmentId],
          }),
        ),
      );
      assert.equal(second.status, 200, `second policy refused: ${JSON.stringify(second.body)}`);
      const neighbourId = String((second.body as { id?: string }).id);
      // Ending the first policy late moves it onto the neighbour's window:
      // same class, intersecting set — refused, and the window does not move.
      const stretched = await withBypass(() =>
        updateSetupRecord(org.actor, "leave-policies", {
          id: String((first.body as { id?: string }).id),
          effectiveTo: "2026-12-31",
          reason: "extend first-half cover",
        }),
      );
      assert.equal(stretched.status, 409);
      assert.equal((stretched.body as { code?: string }).code, "overlap");
      assert.match(
        String((stretched.body as { error?: string }).error),
        new RegExp(`Policy ${neighbourId} already covers`),
      );
      const window = (
        await withBypass(() =>
          db.execute<{ effective_to: string }>(
            sql`
      select effective_to::text as effective_to from hrm_leave_policies
       where org_id = ${org.orgId} and id = ${String((first.body as { id?: string }).id)}`,
            "objects",
          ),
        )
      )[0];
      assert.equal(String(window?.effective_to).slice(0, 10), "2026-06-30");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "an unrelated edit to the same window saves with its reason audited",
  { skip: !DB },
  async () => {
    const org = await seedOrg();
    try {
      const first = await withBypass(() =>
        createSetupRecord(
          org.actor,
          "leave-policies",
          policyBody({
            leaveTypeId: org.typeId,
            effectiveFrom: "2026-01-01",
          }),
        ),
      );
      assert.equal(first.status, 200, `first policy refused: ${JSON.stringify(first.body)}`);
      const id = String((first.body as { id?: string }).id);
      const edited = await withBypass(() =>
        updateSetupRecord(org.actor, "leave-policies", {
          id,
          minimumNoticeDays: 3,
          reason: "three-day notice agreed",
        }),
      );
      assert.equal(edited.status, 200, `self edit refused: ${JSON.stringify(edited.body)}`);
      assert.deepEqual(await auditReasons(org.orgId, id), [
        "annual policy review",
        "three-day notice agreed",
      ]);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
