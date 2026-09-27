import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { ScopeNotFoundError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
import { filterFlowRunSubjectsToScope, loadFlowSubjectSubsidiary, loadGateHeader, lockFlowSubjectScope } from "../../_lib.ts";

test("allocation flow scope includes every subsidiary touched by the run", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const subB = randomUUID();
    const flowId = randomUUID();
    const flowRunId = randomUUID();
    const runId = randomUUID();
    const gateId = randomUUID();
    const ruleId = randomUUID();
    const versionId = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into subsidiaries
      (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'West Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`));
    await withBypassContext(() => db.execute(sql`insert into allocation_rules (id, org_id, key, name, mode)
      values (${ruleId}, ${org.orgId}, ${`scope-${ruleId}`}, 'Scope run', 'period')`));
    await withBypassContext(() => db.execute(sql`insert into allocation_rule_versions
      (id, org_id, rule_id, version_no, status, effective_from, definition_hash)
      values (${versionId}, ${org.orgId}, ${ruleId}, 1, 'published', '2026-01-01', 'scope-test')`));
    const computation = { sources: [{ subsidiaryId: org.subsidiaryId }], targets: [{ coordinate: { subsidiaryId: subB } }], lines: [] };
    await withBypassContext(() => db.execute(sql`insert into allocation_runs
      (id, org_id, rule_id, version_id, definition_hash, period_id, book_id, subsidiary_id, status, computation)
      values (${runId}, ${org.orgId}, ${ruleId}, ${versionId}, 'scope-test', ${org.periodId}, ${org.bookId},
        ${org.subsidiaryId}, 'pending_approval', ${JSON.stringify(computation)}::jsonb)`));
    await withBypassContext(() => db.execute(sql`insert into flows (id, org_id, name, subject_kind, enabled, graph)
      values (${flowId}, ${org.orgId}, 'Allocation approvals', 'allocation_run', true, '{}'::jsonb)`));
    await withBypassContext(() => db.execute(sql`insert into flow_runs
      (id, org_id, flow_id, subject_kind, subject_id, trigger, status)
      values (${flowRunId}, ${org.orgId}, ${flowId}, 'allocation_run', ${runId}, 'on_submit', 'waiting')`));
    await withBypassContext(() => db.execute(sql`insert into flow_gates
      (id, org_id, flow_id, run_id, node_id, subject_kind, subject_id, title, group_key, status)
      values (${gateId}, ${org.orgId}, ${flowId}, ${flowRunId}, 'gate-1', 'allocation_run', ${runId}, 'Approve', 'gate-1', 'pending')`));

    const onlyA = new Set([org.subsidiaryId]);
    assert.equal(await loadGateHeader(gateId, org.orgId, onlyA), null);
    assert.equal(await loadFlowSubjectSubsidiary('allocation_run', runId, org.orgId, onlyA), null);
    assert.deepEqual(await filterFlowRunSubjectsToScope(org.orgId, onlyA, [{ kind: 'allocation_run', id: runId }]), []);
    assert.equal((await loadGateHeader(gateId, org.orgId, new Set([org.subsidiaryId, subB])))?.subsidiary_id, org.subsidiaryId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("work-order flow scope locks an in-scope order and hides an out-of-scope order", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const otherSubsidiary = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into subsidiaries
      (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${otherSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'West Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`));
    const inScopeOrder = randomUUID();
    const outOfScopeOrder = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into mfg_work_orders
      (id, org_id, number, produced_item_id, quantity_ordered, unit, subsidiary_id)
      values (${inScopeOrder}, ${org.orgId}, 'WO-SCOPE-A', ${org.items.assembly}, 1, 'ea', ${org.subsidiaryId}),
             (${outOfScopeOrder}, ${org.orgId}, 'WO-SCOPE-B', ${org.items.assembly}, 1, 'ea', ${otherSubsidiary})`));

    const onlyA = new Set([org.subsidiaryId]);
    await withOrgTransaction(org.orgId, () =>
      lockFlowSubjectScope("work_order", inScopeOrder, org.orgId, onlyA),
    );
    await assert.rejects(
      withOrgTransaction(org.orgId, () =>
        lockFlowSubjectScope("work_order", outOfScopeOrder, org.orgId, onlyA),
      ),
      (error: unknown) =>
        error instanceof ScopeNotFoundError && error.status === 404 && error.message === "not found",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
