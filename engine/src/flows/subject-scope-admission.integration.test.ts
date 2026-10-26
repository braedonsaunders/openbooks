import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  grantScratchPermissions,
  type FlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { submitForApproval } from "./submit.ts";
import { retryFlowRun, runRecordFlows } from "./run.ts";
import { getFlowAdapter } from "./registry.ts";
import { lockFlowSubjectAdmission } from "./subject-admission.ts";
import { lockSubjectScope, tableScope } from "./subject-scope.ts";
import { payRunApprovalState } from "../payroll/approval.ts";

/**
 * Legal-entity-scoped flow admission.
 *
 * A flow whose graph carries `subjectScope` applies only to subjects whose
 * resolved legal entity is listed. Admission is decided BEFORE the flow is
 * planned or any run/gate/audit row exists: an out-of-scope original must
 * be completely untouched by a policy authored for a new entity, an
 * in-scope subject gates normally (human gate, maker segregation and all),
 * an ownerless subject fails closed, and pay-run `policyExists` reports the
 * same admission. Unscoped flows keep organization-wide semantics.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function withOrgFixture(
  fn: (org: ScratchOrg, actors: FlowActors) => Promise<void>,
): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await fn(org, actors);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

async function seedSecondSubsidiary(orgId: string, parentId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries
      (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${orgId}, ${parentId}, 'Second Entity', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

async function seedDocument(
  orgId: string,
  opts: { kind: string; createdBy: string; subsidiaryId: string | null },
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, document_date, currency,
       subtotal, tax_total, total, created_by, subsidiary_id)
    values (${id}, ${orgId}, ${opts.kind}, 'draft', ${`S-${id.slice(0, 8)}`},
            '2026-07-15', 'CAD', '100.00', '0.00', '100.00', ${opts.createdBy}, ${opts.subsidiaryId})`);
  return id;
}

async function seedScopedApprovalFlow(
  orgId: string,
  opts: {
    subjectKind: string;
    subsidiaryIds?: readonly string[];
    assignees: Array<{ type: "user"; userId: string } | { type: "role"; role: string }>;
  },
): Promise<string> {
  const flowId = randomUUID();
  const graph = {
    schemaVersion: 1,
    ...(opts.subsidiaryIds ? { subjectScope: { subsidiaryIds: [...opts.subsidiaryIds] } } : {}),
    nodes: [
      {
        id: "trigger",
        position: { x: 0, y: 0 },
        data: { kind: "trigger", trigger: { trigger: "on_submit" } },
      },
      {
        id: "gate",
        position: { x: 220, y: 0 },
        data: {
          kind: "gate",
          gate: {
            title: "Approval",
            assignees: opts.assignees,
            mode: "any",
            preventSelfApproval: true,
          },
        },
      },
    ],
    edges: [{ id: "e1", source: "trigger", target: "gate", sourceHandle: "next" }],
  };
  await db.execute(sql`
    insert into flows (id, org_id, name, subject_kind, enabled, graph)
    values (${flowId}, ${orgId}, 'Scoped approval', ${opts.subjectKind}, true, ${JSON.stringify(graph)}::jsonb)`);
  return flowId;
}

async function flowRowsFor(subjectId: string): Promise<{ runs: number; gates: number }> {
  const runs = (
    await db.execute<{ n: string }>(
      sql`
    select count(*) as n from flow_runs where subject_id = ${subjectId}`,
      "objects",
    )
  )[0]!;
  const gates = (
    await db.execute<{ n: string }>(
      sql`
    select count(*) as n from flow_gates where subject_id = ${subjectId}`,
      "objects",
    )
  )[0]!;
  return { runs: Number(runs.n), gates: Number(gates.n) };
}

async function docStatus(id: string): Promise<string> {
  const row = (
    await db.execute<{ status: string }>(
      sql`
    select status::text as status from documents where id = ${id}`,
      "objects",
    )
  )[0]!;
  return row.status;
}

test(
  "a flow scoped to a new entity cannot catch the original entity's records",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      const second = await seedSecondSubsidiary(org.orgId, org.subsidiaryId);
      await seedScopedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        subsidiaryIds: [second],
        assignees: [{ type: "user", userId: actors.approver1Id }],
      });

      // The original entity's bill: the scoped policy does not apply at all —
      // no gate, and no run row is created for it either.
      const original = await seedDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
        subsidiaryId: org.subsidiaryId,
      });
      const originalResult = await submitForApproval("vendor_bill", original, actors.submitterId);
      assert.equal(originalResult.gated, false);
      assert.equal(originalResult.flowError, null);
      assert.deepEqual(await flowRowsFor(original), { runs: 0, gates: 0 });
      assert.equal(await docStatus(original), "draft");

      // The new entity's bill gates through the human approval as authored.
      const scoped = await seedDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
        subsidiaryId: second,
      });
      const scopedResult = await submitForApproval("vendor_bill", scoped, actors.submitterId);
      assert.equal(scopedResult.gated, true);
      assert.deepEqual(await flowRowsFor(scoped), { runs: 1, gates: 1 });
      assert.equal(await docStatus(scoped), "pending_approval");
    });
  },
);

test("an unscoped flow keeps organization-wide semantics (control)", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const second = await seedSecondSubsidiary(org.orgId, org.subsidiaryId);
    await seedScopedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    for (const subsidiaryId of [org.subsidiaryId, second]) {
      const doc = await seedDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
        subsidiaryId,
      });
      const result = await submitForApproval("vendor_bill", doc, actors.submitterId);
      assert.equal(result.gated, true);
      assert.equal(await docStatus(doc), "pending_approval");
    }
  });
});

test("an ownerless record fails closed under a scoped flow", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const second = await seedSecondSubsidiary(org.orgId, org.subsidiaryId);
    await seedScopedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      subsidiaryIds: [second],
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });
    const ownerless = await seedDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
      subsidiaryId: null,
    });
    await assert.rejects(
      submitForApproval("vendor_bill", ownerless, actors.submitterId),
      /legal entity could not be resolved/,
    );
    assert.equal(await docStatus(ownerless), "draft");
    const rows = await flowRowsFor(ownerless);
    assert.equal(rows.gates, 0);
    assert.equal(rows.runs, 0, "a refused submission rolls its routing back atomically");
  });
});

test(
  "admission reads the subject's current entity, with case-canonical scope ids",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      const second = await seedSecondSubsidiary(org.orgId, org.subsidiaryId);
      await seedScopedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        subsidiaryIds: [second.toUpperCase()],
        assignees: [{ type: "user", userId: actors.approver1Id }],
      });

      // Rehomed to the original entity before submission: the flow no longer
      // admits it, however it was owned when the record was created.
      const rehomed = await seedDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
        subsidiaryId: second,
      });
      await db.execute(sql`
      update documents set subsidiary_id = ${org.subsidiaryId} where id = ${rehomed} and org_id = ${org.orgId}`);
      const rehomedResult = await submitForApproval("vendor_bill", rehomed, actors.submitterId);
      assert.equal(rehomedResult.gated, false);
      assert.deepEqual(await flowRowsFor(rehomed), { runs: 0, gates: 0 });

      // Still in the second entity: admitted even though the stored scope id
      // was spelled in uppercase (graph parsing canonicalizes uuid case).
      const inScope = await seedDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
        subsidiaryId: second,
      });
      const inScopeResult = await submitForApproval("vendor_bill", inScope, actors.submitterId);
      assert.equal(inScopeResult.gated, true);
    });
  },
);

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function settlesWithin(promise: Promise<unknown>, ms = 300): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

async function untilSet(flag: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !flag(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(flag(), "the holding transaction reached its lock point");
}

test(
  "locked admission freezes the scope owner until the dispatch transaction ends",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      const second = await seedSecondSubsidiary(org.orgId, org.subsidiaryId);
      const doc = await seedDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
        subsidiaryId: second,
      });
      const adapter = getFlowAdapter("vendor_bill")!;
      const graph = { subjectScope: { subsidiaryIds: [second] } };

      // Admission inside a transaction that stays open, as a dispatch's
      // planning/effects phase would: the verdict is in-scope...
      const hold = deferred();
      let admitted: string | null = null;
      const admissionTx = withOrgTransaction(org.orgId, async () => {
        const result = await lockFlowSubjectAdmission(
          org.orgId,
          adapter,
          "vendor_bill",
          doc,
          graph,
        );
        admitted = result.admission;
        await hold.promise;
      });
      await untilSet(() => admitted !== null);
      assert.equal(admitted, "admitted");

      // ...and a concurrent rehome of the admitted subject cannot complete
      // while that transaction is open, so no effect of the dispatch can
      // land after the subject left the flow's scope.
      const rehome = db.execute(sql`
      update documents set subsidiary_id = ${org.subsidiaryId} where id = ${doc} and org_id = ${org.orgId}`);
      assert.equal(
        await settlesWithin(rehome),
        false,
        "the rehome must wait for the admission lock",
      );
      hold.release();
      await admissionTx;
      await rehome;
      const row = (
        await db.execute<{ subsidiaryId: string }>(
          sql`
      select subsidiary_id as "subsidiaryId" from documents where id = ${doc}`,
          "objects",
        )
      )[0]!;
      assert.equal(
        row.subsidiaryId,
        org.subsidiaryId,
        "the rehome lands only after the dispatch transaction",
      );
    });
  },
);

test("a rehome already in flight is what locked admission resolves", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const second = await seedSecondSubsidiary(org.orgId, org.subsidiaryId);
    const doc = await seedDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
      subsidiaryId: second,
    });
    const adapter = getFlowAdapter("vendor_bill")!;
    const graph = { subjectScope: { subsidiaryIds: [second] } };

    // The rehome updates first and holds its row lock uncommitted.
    const hold = deferred();
    let moved = false;
    const rehomeTx = withOrgTransaction(org.orgId, async () => {
      await db.execute(sql`
        update documents set subsidiary_id = ${org.subsidiaryId} where id = ${doc} and org_id = ${org.orgId}`);
      moved = true;
      await hold.promise;
    });
    await untilSet(() => moved);

    // Admission cannot resolve past the in-flight rehome...
    const admissionTx = withOrgTransaction(org.orgId, () =>
      lockFlowSubjectAdmission(org.orgId, adapter, "vendor_bill", doc, graph),
    );
    assert.equal(
      await settlesWithin(admissionTx),
      false,
      "admission must wait for the in-flight rehome",
    );
    hold.release();
    await rehomeTx;
    // ...and when it does resolve, it sees the committed rehome: the
    // subject is now out of scope and the flow must skip it entirely.
    const result = await admissionTx;
    assert.equal(result.subsidiaryId, org.subsidiaryId);
    assert.equal(result.admission, "out-of-scope");
  });
});

test("linked scopes lock the referring row, not only the owner", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const second = await seedSecondSubsidiary(org.orgId, org.subsidiaryId);
    // The org's vendor and customer parties become the two owners; a
    // document pointing at the vendor is the referring subject row.
    await db.execute(
      sql`update parties set subsidiary_id = ${org.subsidiaryId} where id = ${org.vendorId}`,
    );
    await db.execute(
      sql`update parties set subsidiary_id = ${second} where id = ${org.customerId}`,
    );
    const doc = await seedDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
      subsidiaryId: org.subsidiaryId,
    });
    await db.execute(sql`update documents set party_id = ${org.vendorId} where id = ${doc}`);
    const scope = tableScope("party", "documents", "party_id");

    const hold = deferred();
    let locked = false;
    const lockTx = withOrgTransaction(org.orgId, async () => {
      await lockSubjectScope(org.orgId, "vendor_bill", scope, doc, null);
      locked = true;
      await hold.promise;
    });
    await untilSet(() => locked);

    // Relinking the subject to the other owner moves its legal entity;
    // it must wait for BOTH locks, not slip past the frozen owner row.
    const relink = db.execute(sql`
      update documents set party_id = ${org.customerId} where id = ${doc} and org_id = ${org.orgId}`);
    assert.equal(
      await settlesWithin(relink),
      false,
      "the relink must wait for the referring-row lock",
    );
    hold.release();
    await lockTx;
    await relink;
    const row = (
      await db.execute<{ partyId: string }>(
        sql`
      select party_id as "partyId" from documents where id = ${doc}`,
        "objects",
      )
    )[0]!;
    assert.equal(row.partyId, org.customerId, "the relink lands only after the lock transaction");
  });
});

test("pay-run policyExists follows the same admission", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const second = await seedSecondSubsidiary(org.orgId, org.subsidiaryId);
    await seedScopedApprovalFlow(org.orgId, {
      subjectKind: "pay_run",
      subsidiaryIds: [second],
      assignees: [{ type: "user", userId: actors.approver1Id }],
    });

    const originalRun = await seedDocument(org.orgId, {
      kind: "pay_run",
      createdBy: actors.submitterId,
      subsidiaryId: org.subsidiaryId,
    });
    const originalState = await payRunApprovalState(org.orgId, originalRun);
    assert.equal(
      originalState.policyExists,
      false,
      "an out-of-scope template is not this run's policy",
    );
    assert.equal(originalState.released, true);

    const scopedRun = await seedDocument(org.orgId, {
      kind: "pay_run",
      createdBy: actors.submitterId,
      subsidiaryId: second,
    });
    const scopedState = await payRunApprovalState(org.orgId, scopedRun);
    assert.equal(scopedState.policyExists, true);
    assert.equal(scopedState.released, false, "an unsubmitted in-scope run is not released");

    const ownerlessRun = await seedDocument(org.orgId, {
      kind: "pay_run",
      createdBy: actors.submitterId,
      subsidiaryId: null,
    });
    const ownerlessState = await payRunApprovalState(org.orgId, ownerlessRun);
    assert.equal(
      ownerlessState.policyExists,
      true,
      "an unresolved entity still counts the scoped policy",
    );
    assert.equal(ownerlessState.released, false);
  });
});

test(
  "retry refuses when the record leaves its frozen Flow scope, preserving the failed run",
  { skip: !DB },
  async () => {
    await withOrgFixture(async (org, actors) => {
      await grantScratchPermissions(org.orgId, actors.adminId, ["flows.manage"]);
      const second = await seedSecondSubsidiary(org.orgId, org.subsidiaryId);
      await seedScopedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        subsidiaryIds: [second],
        // A role with no members: the in-scope submit fails its run, leaving
        // the failed run a retry could otherwise re-drive.
        assignees: [{ type: "role", role: "nonexistent_role" }],
      });
      const doc = await seedDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
        subsidiaryId: second,
      });
      const submitted = await withOrgTransaction(org.orgId, () =>
        runRecordFlows({ kind: "on_submit", source: "ui" }, "vendor_bill", doc, {
          orgId: org.orgId,
          userId: actors.submitterId,
        }),
      );
      assert.equal(submitted.failed, true);
      const failedRun = (
        await db.execute<{ id: string }>(
          sql`
      select id from flow_runs where subject_id = ${doc} and status = 'failed' limit 1`,
          "objects",
        )
      )[0];
      assert.ok(failedRun);

      // Rehoming the editable record cannot bypass the scope frozen on its failed run.
      await db.execute(sql`update documents set subsidiary_id=${org.subsidiaryId}
      where id=${doc} and org_id=${org.orgId}`);

      await assert.rejects(
        retryFlowRun(failedRun.id, { orgId: org.orgId, userId: actors.adminId }),
        /do not include this record's legal entity/,
      );
      const after = (
        await db.execute<{ status: string }>(
          sql`
      select status::text as status from flow_runs where id = ${failedRun.id}`,
          "objects",
        )
      )[0]!;
      assert.equal(after.status, "failed", "the refused retry leaves the failed run untouched");
      assert.equal(await docStatus(doc), "draft", "no silent completion or release");
      assert.deepEqual(await flowRowsFor(doc), { runs: 1, gates: 0 });
    });
  },
);
