import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import {
  AllocationRuleError,
  createDraftVersion,
  createRule,
  publishVersion,
  replaceTargets,
  retireVersion,
  updateDraftVersion,
  updateRule,
} from "./rules.ts";

/**
 * H-ALLOC-RULES configuration-write proofs (DB-owned — gated remotely).
 *
 * Publish, retire, rule edits, version edits, and target replacements all
 * require the caller's scope over every subsidiary the rule's sources and
 * targets touch (org-wide needs unrestricted scope). Denied versions
 * refuse AllocationRuleError NOT_FOUND with the bare "not found" message —
 * the same code the missing-id path produces — so one entity's manager can
 * neither reshape nor probe another entity's rule.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;
const AUDIT = { actorId: null, reason: "rule scope test" };

async function subB(orgId: string, parentId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${orgId}, ${parentId}, 'Entity B', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

async function scopedDraft(
  orgId: string,
  subA: string,
  over: { sources?: string[]; targetSub?: string | null; key?: string } = {},
): Promise<{ ruleId: string; versionId: string }> {
  const created = await createRule(
    { orgId, key: over.key ?? `scope-${Math.random().toString(36).slice(2, 8)}`, name: "Scoped", mode: "period" },
    AUDIT,
  );
  const draft = await createDraftVersion(
    created.rule.id,
    {
      orgId,
      effectiveFrom: "2026-01-01",
      dimensionFilters: { subsidiaryIds: over.sources ?? [subA] },
      targets: [{ fixedPercent: "100", subsidiaryId: over.targetSub === undefined ? subA : over.targetSub }],
      allowedSubsidiaryIds: null,
    },
    AUDIT,
  );
  return { ruleId: created.rule.id, versionId: draft.version.id };
}

function deniedMessage(error: unknown): string {
  assert.ok(error instanceof AllocationRuleError, `refusal is an AllocationRuleError, got ${String(error)}`);
  assert.equal((error as AllocationRuleError).code, "NOT_FOUND");
  return (error as Error).message;
}

test("publish needs scope over the rule's sources and targets", { skip: !DB }, async () => {
  const scratch = await createScratchOrg();
  try {
    const other = await subB(scratch.orgId, scratch.subsidiaryId);
    const { versionId } = await scopedDraft(scratch.orgId, scratch.subsidiaryId);
    const scopeB = new Set([other]);
    const message = await publishVersion(versionId, { orgId: scratch.orgId, ...AUDIT, allowedSubsidiaryIds: scopeB }).then(
      () => { throw new Error("expected the scope refusal"); },
      (error) => deniedMessage(error),
    );
    assert.equal(message, "not found");
    const published = await publishVersion(versionId, { orgId: scratch.orgId, ...AUDIT, allowedSubsidiaryIds: new Set([scratch.subsidiaryId]) });
    assert.equal(published.version.status, "published");
  } finally {
    await dropScratchOrg(scratch.orgId);
  }
});

test("retire and rule edits refuse uniformly", { skip: !DB }, async () => {
  const scratch = await createScratchOrg();
  try {
    const other = await subB(scratch.orgId, scratch.subsidiaryId);
    const { ruleId, versionId } = await scopedDraft(scratch.orgId, scratch.subsidiaryId);
    await publishVersion(versionId, { orgId: scratch.orgId, ...AUDIT, allowedSubsidiaryIds: null });
    const scopeB = new Set([other]);
    assert.equal(
      await retireVersion(versionId, { orgId: scratch.orgId, ...AUDIT, allowedSubsidiaryIds: scopeB }).then(
        () => { throw new Error("expected the scope refusal"); },
        (error) => deniedMessage(error),
      ),
      "not found",
    );
    assert.equal(
      await updateRule(ruleId, { orgId: scratch.orgId, name: "Renamed", expectedRevision: null, allowedSubsidiaryIds: scopeB }, AUDIT).then(
        () => { throw new Error("expected the scope refusal"); },
        (error) => deniedMessage(error),
      ),
      "not found",
    );
    const renamed = await updateRule(
      ruleId,
      { orgId: scratch.orgId, name: "Renamed", expectedRevision: null, allowedSubsidiaryIds: new Set([scratch.subsidiaryId]) },
      AUDIT,
    );
    assert.equal(renamed.rule.name, "Renamed");
    await retireVersion(versionId, { orgId: scratch.orgId, ...AUDIT, allowedSubsidiaryIds: new Set([scratch.subsidiaryId]) });
  } finally {
    await dropScratchOrg(scratch.orgId);
  }
});

test("widening sources or retargeting past the caller's scope refuses", { skip: !DB }, async () => {
  const scratch = await createScratchOrg();
  try {
    const other = await subB(scratch.orgId, scratch.subsidiaryId);
    const scopeA = new Set([scratch.subsidiaryId]);
    const { versionId } = await scopedDraft(scratch.orgId, scratch.subsidiaryId);
    // Widening the source filter to B is refused even though the current
    // definition is in scope.
    assert.equal(
      await updateDraftVersion(
        versionId,
        { orgId: scratch.orgId, dimensionFilters: { subsidiaryIds: [scratch.subsidiaryId, other] }, expectedRevision: null, allowedSubsidiaryIds: scopeA },
        AUDIT,
      ).then(
        () => { throw new Error("expected the scope refusal"); },
        (error) => deniedMessage(error),
      ),
      "not found",
    );
    // Swapping the target to B is refused; re-saving the A target passes.
    assert.equal(
      await replaceTargets(
        versionId,
        { orgId: scratch.orgId, targets: [{ fixedPercent: "100", subsidiaryId: other }], expectedRevision: null, allowedSubsidiaryIds: scopeA },
        AUDIT,
      ).then(
        () => { throw new Error("expected the scope refusal"); },
        (error) => deniedMessage(error),
      ),
      "not found",
    );
    const kept = await replaceTargets(
      versionId,
      { orgId: scratch.orgId, targets: [{ fixedPercent: "100", subsidiaryId: scratch.subsidiaryId }], expectedRevision: null, allowedSubsidiaryIds: scopeA },
      AUDIT,
    );
    assert.equal(kept.targets.length, 1);
  } finally {
    await dropScratchOrg(scratch.orgId);
  }
});

test("org-wide rules need unrestricted scope", { skip: !DB }, async () => {
  const scratch = await createScratchOrg();
  try {
    const created = await createRule(
      { orgId: scratch.orgId, key: `orgwide-${Math.random().toString(36).slice(2, 8)}`, name: "Org wide", mode: "period" },
      AUDIT,
    );
    const draft = await createDraftVersion(
      created.rule.id,
      { orgId: scratch.orgId, effectiveFrom: "2026-01-01", targets: [{ fixedPercent: "100" }], allowedSubsidiaryIds: null },
      AUDIT,
    );
    assert.equal(
      await publishVersion(draft.version.id, { orgId: scratch.orgId, ...AUDIT, allowedSubsidiaryIds: new Set([scratch.subsidiaryId]) }).then(
        () => { throw new Error("expected the scope refusal"); },
        (error) => deniedMessage(error),
      ),
      "not found",
    );
    const published = await publishVersion(draft.version.id, { orgId: scratch.orgId, ...AUDIT, allowedSubsidiaryIds: null });
    assert.equal(published.version.status, "published");
  } finally {
    await dropScratchOrg(scratch.orgId);
  }
});
