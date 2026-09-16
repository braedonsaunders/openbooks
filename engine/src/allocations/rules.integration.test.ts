import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, dropScratchOrg } from "../test-fixtures.ts";
import { definitionHash } from "./validate.ts";
import {
  AllocationRuleError,
  createDraftVersion,
  createRule,
  getRuleDetail,
  getRuleVersion,
  listRuleHeads,
  listRulesInEffect,
  loadRuleInEffectByKey,
  publishVersion,
  replaceTargets,
  retireVersion,
  updateDraftVersion,
  updateRule,
} from "./rules.ts";

const AUDIT = { actorId: null, reason: "fleet test" };
const REVISION_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

async function org(): Promise<{ orgId: string; bookId: string }> {
  const scratch = await createScratchOrg();
  return { orgId: scratch.orgId, bookId: scratch.bookId };
}

async function publishedRule(
  orgId: string,
  over: { key?: string; sortOrder?: number; effectiveFrom?: string; effectiveTo?: string | null } = {},
): Promise<{ ruleId: string; versionId: string }> {
  const created = await createRule(
    { orgId, key: over.key ?? `sweep-${Math.random().toString(36).slice(2, 8)}`, name: "Sweep", mode: "period", sortOrder: over.sortOrder ?? 100 },
    AUDIT,
  );
  const draft = await createDraftVersion(
    created.rule.id,
    {
      orgId,
      effectiveFrom: over.effectiveFrom ?? "2026-01-01",
      effectiveTo: over.effectiveTo ?? null,
      targets: [{ fixedPercent: "60" }, { fixedPercent: "40" }],
    },
    AUDIT,
  );
  const published = await publishVersion(draft.version.id, { orgId, ...AUDIT });
  return { ruleId: created.rule.id, versionId: published.version.id };
}

test("publish freezes the definition and stamps a recomputable hash", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await org();
  try {
    const { versionId } = await publishedRule(orgId, { key: "freeze-sweep" });
    const rows = await db.execute<{
      status: string;
      definition_hash: string;
      effective_from: unknown;
      basis_kind: string;
    }>(sql`select status, definition_hash, effective_from, basis_kind
              from allocation_rule_versions where org_id = ${orgId} and id = ${versionId}`);
    const row = rows.rows[0];
    assert.ok(row);
    assert.equal(row.status, "published");
    assert.match(row.definition_hash ?? "", /^[0-9a-f]{64}$/);

    // The stamped hash recomputes from the frozen row.
    const inEffect = await loadRuleInEffectByKey(orgId, "freeze-sweep", "2026-07-15");
    assert.ok(inEffect);
    assert.equal(definitionHash(inEffect.version, inEffect.targets), row.definition_hash);

    // The DB trigger refuses definition edits behind the service's back.
    await assert.rejects(
      db.execute(sql`update allocation_rule_versions set basis_kind = 'driver' where org_id = ${orgId} and id = ${versionId}`),
      (error: unknown) => {
        let current: unknown = error;
        while (current !== null && typeof current === "object") {
          const message = (current as { message?: unknown }).message;
          if (typeof message === "string" && /immutable/.test(message)) return true;
          current = (current as { cause?: unknown }).cause;
        }
        return false;
      },
    );
    // The service refuses them too.
    await assert.rejects(updateDraftVersion(versionId, { orgId, basisKind: "driver" }, AUDIT), AllocationRuleError);
    await assert.rejects(
      replaceTargets(versionId, { orgId, targets: [{ fixedPercent: "100" }] }, AUDIT),
      AllocationRuleError,
    );
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("publish refuses overlapping windows and advances the current pointer", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await org();
  try {
    const created = await createRule({ orgId, key: "overlap-sweep", name: "Sweep", mode: "period" }, AUDIT);
    const rule = created.rule;
    const v1 = await createDraftVersion(
      rule.id,
      { orgId, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", targets: [{ fixedPercent: "100" }] },
      AUDIT,
    );
    await publishVersion(v1.version.id, { orgId, ...AUDIT });
    const overlapping = await createDraftVersion(
      rule.id,
      { orgId, effectiveFrom: "2026-06-30", targets: [{ fixedPercent: "100" }] },
      AUDIT,
    );
    await assert.rejects(publishVersion(overlapping.version.id, { orgId, ...AUDIT }), (error: unknown) => {
      assert.ok(error instanceof AllocationRuleError);
      assert.ok(error.problems?.some((p) => p.code === "effective_overlap"));
      return true;
    });
    const successor = await createDraftVersion(
      rule.id,
      { orgId, effectiveFrom: "2026-07-01", targets: [{ fixedPercent: "100" }] },
      AUDIT,
    );
    const published = await publishVersion(successor.version.id, { orgId, ...AUDIT });
    assert.equal(published.version.versionNo, 3);
    const head = await db.execute<{ current_version_id: string }>(
      sql`select current_version_id from allocation_rules where org_id = ${orgId} and id = ${rule.id}`,
    );
    assert.equal(head.rows[0]?.current_version_id, published.version.id);
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("listRulesInEffect honours window, status and activity in one ordered query", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await org();
  try {
    await publishedRule(orgId, { key: "b-rule", sortOrder: 20 });
    await publishedRule(orgId, { key: "a-rule", sortOrder: 10 });
    // Draft-only rule stays invisible.
    await createRule({ orgId, key: "draft-rule", name: "Draft", mode: "period", sortOrder: 1 }, AUDIT);
    // Inactive rule stays invisible.
    const quiet = await createRule({ orgId, key: "quiet-rule", name: "Quiet", mode: "period", sortOrder: 2 }, AUDIT);
    const quietDraft = await createDraftVersion(quiet.rule.id, { orgId, effectiveFrom: "2026-01-01", targets: [{ fixedPercent: "100" }] }, AUDIT);
    await publishVersion(quietDraft.version.id, { orgId, ...AUDIT });
    await updateRule(quiet.rule.id, { orgId, isActive: false }, AUDIT);
    // Expired window stays invisible on later dates.
    await publishedRule(orgId, { key: "old-rule", sortOrder: 5, effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31" });

    const live = await listRulesInEffect({ orgId, mode: "period", onDate: "2026-07-15" });
    assert.deepEqual(live.map((r) => r.rule.key), ["a-rule", "b-rule"]);
    assert.equal(live[0]?.targets.length, 2);
    const past = await listRulesInEffect({ orgId, mode: "period", onDate: "2025-06-01" });
    assert.deepEqual(past.map((r) => r.rule.key), ["old-rule"]);
    assert.equal(await loadRuleInEffectByKey(orgId, "draft-rule", "2026-07-15"), null);
    assert.equal(await loadRuleInEffectByKey(orgId, "no-such-rule", "2026-07-15"), null);
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("book_scope books is refused for unknown books and honoured by the listing", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId, bookId } = await org();
  try {
    const created = await createRule({ orgId, key: "book-sweep", name: "Sweep", mode: "period" }, AUDIT);
    const rule = created.rule;
    const ghost = await createDraftVersion(
      rule.id,
      { orgId, effectiveFrom: "2026-01-01", bookScope: "books", bookIds: ["00000000-0000-0000-0000-000000000000"], targets: [{ fixedPercent: "100" }] },
      AUDIT,
    );
    await assert.rejects(publishVersion(ghost.version.id, { orgId, ...AUDIT }), (error: unknown) => {
      assert.ok(error instanceof AllocationRuleError);
      assert.ok(error.problems?.some((p) => p.code === "book_scope"));
      return true;
    });
    const live = await createDraftVersion(
      rule.id,
      { orgId, effectiveFrom: "2026-01-01", bookScope: "books", bookIds: [bookId], targets: [{ fixedPercent: "100" }] },
      AUDIT,
    );
    await publishVersion(live.version.id, { orgId, ...AUDIT });
    const forBook = await listRulesInEffect({ orgId, mode: "period", onDate: "2026-07-15", bookId });
    assert.deepEqual(forBook.map((r) => r.rule.key), ["book-sweep"]);
    const elsewhere = await listRulesInEffect({
      orgId,
      mode: "period",
      onDate: "2026-07-15",
      bookId: "00000000-0000-0000-0000-000000000001",
    });
    assert.deepEqual(elsewhere, []);
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("new version from current copies the definition for editing", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await org();
  try {
    const created = await createRule({ orgId, key: "copy-sweep", name: "Sweep", mode: "period" }, AUDIT);
    const rule = created.rule;
    const first = await createDraftVersion(
      rule.id,
      { orgId, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", targets: [{ fixedPercent: "60" }, { fixedPercent: "40" }] },
      AUDIT,
    );
    await publishVersion(first.version.id, { orgId, ...AUDIT });
    const next = await createDraftVersion(rule.id, { orgId, fromVersionId: first.version.id }, AUDIT);
    assert.equal(next.version.versionNo, 2);
    assert.equal(next.version.status, "draft");
    assert.deepEqual(
      next.targets.map((t) => t.fixedPercent),
      ["60.0000", "40.0000"],
    );
    // The copy inherits the old window, so it cannot publish until it moves.
    assert.equal(next.version.effectiveTo, "2026-06-30");
    await assert.rejects(publishVersion(next.version.id, { orgId, ...AUDIT }), AllocationRuleError);
    await updateDraftVersion(
      next.version.id,
      { orgId, effectiveFrom: "2026-07-01", effectiveTo: null, memoTemplate: "sweep {{period.name}}" },
      AUDIT,
    );
    const edited = await publishVersion(next.version.id, { orgId, ...AUDIT });
    assert.equal(edited.version.memoTemplate, "sweep {{period.name}}");
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("retire clears the current pointer and audit evidence records every transition", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await org();
  try {
    const created = await createRule({ orgId, key: "retire-sweep", name: "Sweep", mode: "period" }, AUDIT);
    const rule = created.rule;
    const draft = await createDraftVersion(rule.id, { orgId, effectiveFrom: "2026-01-01", targets: [{ fixedPercent: "100" }] }, AUDIT);
    const published = await publishVersion(draft.version.id, { orgId, ...AUDIT });
    await retireVersion(published.version.id, { orgId, actorId: null, reason: "superseded" });
    const live = await listRulesInEffect({ orgId, mode: "period", onDate: "2026-07-15" });
    assert.deepEqual(live, []);
    const head = await db.execute<{ current_version_id: string | null }>(
      sql`select current_version_id from allocation_rules where org_id = ${orgId} and id = ${rule.id}`,
    );
    assert.equal(head.rows[0]?.current_version_id, null);
    const audit = await db.execute<{ table_name: string; action: string; changes: unknown }>(
      sql`select table_name, action, changes from audit_log where org_id = ${orgId} order by at asc`,
    );
    const tables = audit.rows.map((r) => `${r.table_name}:${r.action}`);
    assert.ok(tables.includes("allocation_rules:insert"), `expected rule insert evidence, got ${tables.join(",")}`);
    assert.ok(tables.includes("allocation_rule_versions:update"), `expected version evidence, got ${tables.join(",")}`);
    for (const row of audit.rows) {
      const changes = row.changes as { reason?: unknown; before?: unknown; after?: unknown };
      assert.ok(typeof changes.reason === "string", "every audit write carries a reason");
      assert.ok("before" in changes && "after" in changes, "every audit write carries before/after");
    }
    // Retired versions are frozen too.
    await assert.rejects(updateDraftVersion(published.version.id, { orgId, memoTemplate: "x" }, AUDIT), AllocationRuleError);
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("rules are invisible across organizations", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const first = await org();
  const second = await org();
  try {
    await publishedRule(first.orgId, { key: "private-sweep" });
    assert.equal(await loadRuleInEffectByKey(second.orgId, "private-sweep", "2026-07-15"), null);
    assert.deepEqual(await listRulesInEffect({ orgId: second.orgId, mode: "period", onDate: "2026-07-15" }), []);
  } finally {
    await dropScratchOrg(first.orgId);
    await dropScratchOrg(second.orgId);
  }
});

test("mutations return revision tokens that guard stale writes", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await org();
  try {
    const created = await createRule({ orgId, key: "rev-rule", name: "Rev", mode: "period" }, AUDIT);
    assert.match(created.revision, REVISION_PATTERN);
    const updated = await updateRule(created.rule.id, { orgId, name: "Rev 2", expectedRevision: created.revision }, AUDIT);
    assert.match(updated.revision, REVISION_PATTERN);
    assert.notEqual(updated.revision, created.revision);
    // Replaying the old token is a stale write.
    await assert.rejects(
      updateRule(created.rule.id, { orgId, name: "Stale", expectedRevision: created.revision }, AUDIT),
      (error: unknown) => error instanceof AllocationRuleError && error.code === "STALE",
    );
    // The drawer flow works the same on versions and targets.
    const draft = await createDraftVersion(
      created.rule.id,
      { orgId, effectiveFrom: "2026-01-01", targets: [{ fixedPercent: "100" }] },
      AUDIT,
    );
    assert.match(draft.revision, REVISION_PATTERN);
    const edited = await updateDraftVersion(
      draft.version.id,
      { orgId, memoTemplate: "hi", expectedRevision: draft.revision },
      AUDIT,
    );
    assert.match(edited.revision, REVISION_PATTERN);
    await assert.rejects(
      replaceTargets(draft.version.id, { orgId, targets: [{ fixedPercent: "100" }], expectedRevision: draft.revision }, AUDIT),
      (error: unknown) => error instanceof AllocationRuleError && error.code === "STALE",
    );
    const published = await publishVersion(draft.version.id, { orgId, ...AUDIT });
    assert.match(published.revision, REVISION_PATTERN);
    const retired = await retireVersion(published.version.id, { orgId, ...AUDIT });
    assert.match(retired.revision, REVISION_PATTERN);
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("listRuleHeads filters and summarizes current versions", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await org();
  try {
    await publishedRule(orgId, { key: "heads-b", sortOrder: 20 });
    await createRule({ orgId, key: "heads-a", name: "Entry", mode: "entry", sortOrder: 5 }, AUDIT);
    const quiet = await createRule({ orgId, key: "heads-quiet", name: "Quiet", mode: "period", sortOrder: 1 }, AUDIT);
    const quietDraft = await createDraftVersion(
      quiet.rule.id,
      { orgId, effectiveFrom: "2026-01-01", targets: [{ fixedPercent: "100" }] },
      AUDIT,
    );
    await publishVersion(quietDraft.version.id, { orgId, ...AUDIT });
    await updateRule(quiet.rule.id, { orgId, isActive: false }, AUDIT);

    const all = await listRuleHeads(orgId);
    assert.deepEqual(all.map((h) => h.rule.key), ["heads-quiet", "heads-a", "heads-b"]);
    for (const head of all) assert.match(head.revision, REVISION_PATTERN);
    const active = await listRuleHeads(orgId, { activeOnly: true });
    assert.deepEqual(active.map((h) => h.rule.key), ["heads-a", "heads-b"]);
    const period = await listRuleHeads(orgId, { mode: "period" });
    assert.deepEqual(period.map((h) => h.rule.key), ["heads-quiet", "heads-b"]);

    const published = all.find((h) => h.rule.key === "heads-b")?.currentVersion;
    assert.ok(published);
    assert.equal(published.versionNo, 1);
    assert.equal(published.status, "published");
    assert.equal(published.effectiveFrom, "2026-01-01");
    assert.equal(published.effectiveTo, null);
    assert.match(published.definitionHash ?? "", /^[0-9a-f]{64}$/);
    // Draft-only rules have no current version.
    assert.equal(all.find((h) => h.rule.key === "heads-a")?.currentVersion, null);
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("getRuleDetail returns the head with its version timeline", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await org();
  try {
    const created = await createRule({ orgId, key: "detail-rule", name: "Detail", mode: "period" }, AUDIT);
    const first = await createDraftVersion(
      created.rule.id,
      { orgId, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", targets: [{ fixedPercent: "100" }] },
      AUDIT,
    );
    await publishVersion(first.version.id, { orgId, ...AUDIT });
    await createDraftVersion(created.rule.id, { orgId, fromVersionId: first.version.id }, AUDIT);

    const detail = await getRuleDetail(orgId, created.rule.id);
    assert.equal(detail.rule.key, "detail-rule");
    assert.match(detail.revision, REVISION_PATTERN);
    assert.deepEqual(detail.versions.map((v) => v.version.versionNo), [1, 2]);
    assert.deepEqual(detail.versions.map((v) => v.version.status), ["published", "draft"]);
    assert.deepEqual(detail.versions.map((v) => v.targetCount), [1, 1]);
    for (const entry of detail.versions) assert.match(entry.revision, REVISION_PATTERN);

    await assert.rejects(getRuleDetail(orgId, randomUUID()), AllocationRuleError);
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("getRuleVersion returns the version with its targets and revision", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await org();
  try {
    const { versionId } = await publishedRule(orgId, { key: "version-rule" });
    const found = await getRuleVersion(orgId, versionId);
    assert.equal(found.version.id, versionId);
    assert.equal(found.version.status, "published");
    assert.deepEqual(found.targets.map((t) => t.fixedPercent), ["60.0000", "40.0000"]);
    assert.match(found.revision, REVISION_PATTERN);
    await assert.rejects(getRuleVersion(orgId, randomUUID()), AllocationRuleError);
  } finally {
    await dropScratchOrg(orgId);
  }
});
