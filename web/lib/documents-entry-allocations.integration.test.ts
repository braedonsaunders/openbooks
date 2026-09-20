import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// applyDocumentEdit is server-only code exercised through the same module
// hooks as the neighbouring documents suites.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { applyDocumentEdit } = await import("./documents.ts"), { DocumentEditError } = await import("../../engine/src/records/document-edit-policy.ts"), { loadDocument, loadDocumentEditCurrent } = await import("../../engine/src/ledger/document-service.ts");
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { submitAndReleaseIfUngated } = await import("@openbooks/engine/src/flows/submit.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

// The allocations/allocationsAtEntry switchboard keys are owned by the
// platform slice (A10) and registered in the feature registry; the fixture
// below only flips the org's own toggles on.
async function enableEntryAllocations(orgId: string): Promise<void> {
  await db.execute(sql`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"allocations":true,"allocationsAtEntry":true}'::jsonb)
    where id=${orgId}`);
}

interface Fixture {
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  actor: string;
  expenseAccount: string;
  deptSource: string;
  deptA: string;
  deptB: string;
  ruleId: string;
  versionId: string;
}

// Callers run fixture() under withBypassContext: importing ./documents.ts
// pulls in the web request-org resolver, which denies every unscoped query
// under pooled RLS (bare setup dies with 42501).
async function fixture(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Entry allocation keeper", "entry_alloc_keeper");
  await enableEntryAllocations(org.orgId);
  const expenseAccount = randomUUID();
  await db.execute(sql`insert into accounts
    (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, monetary,
     required_dimensions, custom, subsidiary_include_children)
    values (${expenseAccount}, ${org.orgId}, '6100', 'Entry allocation expense', 'expense',
      false, true, false, false, true, '[]'::jsonb, '{}'::jsonb, true)`);
  const deptSource = randomUUID();
  const deptA = randomUUID();
  const deptB = randomUUID();
  await db.execute(sql`insert into departments(id,org_id,name)
    values (${deptSource},${org.orgId},'Overhead pool'),
           (${deptA},${org.orgId},'Operations A'),
           (${deptB},${org.orgId},'Operations B')`);
  const ruleId = randomUUID();
  const versionId = randomUUID();
  // The head→version FK is deferrable but each statement commits on its own,
  // so the head goes in first with a null pointer and claims its version after.
  await db.execute(sql`insert into allocation_rules
    (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
    values (${ruleId}, ${org.orgId}, 'overhead-split', 'Overhead split', 'entry', 100, true, false, '{}'::jsonb)`);
  // Targets are immutable once published (target guard trigger), so the
  // version is seeded draft, loaded with targets, then published — the same
  // order the rule service uses.
  await db.execute(sql`insert into allocation_rule_versions
    (id, org_id, rule_id, version_no, status, effective_from, effective_to, book_scope, book_ids,
     document_kinds, account_scope, dimension_filters, apply_policy, source_measure, basis_kind,
     basis_config, target_kind, dynamic_target, impact, residual_policy, solve_method, run_policy,
     run_offset_days, custom)
    values (${versionId}, ${org.orgId}, ${ruleId}, 1, 'draft', '2026-01-01', null, 'primary', '[]'::jsonb,
     '["vendor_bill"]'::jsonb, '{"kind":"any"}'::jsonb,
     ${JSON.stringify({ departmentIds: [deptSource] })}::jsonb, 'automatic', 'period_activity', 'fixed_percent',
     '{}'::jsonb, 'explicit', '{}'::jsonb, 'reclass', 'largest_share', 'sequential', 'manual',
     0, '{}'::jsonb)`);
  await db.execute(sql`insert into allocation_rule_targets
    (id, org_id, version_id, sequence, department_id, fixed_percent, extra_dims, is_remainder, custom)
    values (${randomUUID()}, ${org.orgId}, ${versionId}, 0, ${deptA}, '50', '{}'::jsonb, false, '{}'::jsonb),
           (${randomUUID()}, ${org.orgId}, ${versionId}, 1, ${deptB}, '50', '{}'::jsonb, false, '{}'::jsonb)`);
  await db.execute(sql`update allocation_rule_versions set status = 'published', definition_hash = 'entry-test-hash'
    where id = ${versionId} and org_id = ${org.orgId}`);
  await db.execute(sql`update allocation_rules set current_version_id = ${versionId}
    where id = ${ruleId} and org_id = ${org.orgId}`);
  return { org, actor, expenseAccount, deptSource, deptA, deptB, ruleId, versionId };
}

// These helpers run in the scratch org's scope: the edit service and its
// readers issue bare queries with explicit org predicates, which pooled RLS
// denies outside an explicit scope (reads see zero rows).
async function draftBill(f: Fixture, number: string): Promise<string> {
  return withOrgContext(f.org.orgId, async () => {
    const id = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
      values (${id},${f.org.orgId},'vendor_bill','draft',${number},${f.org.subsidiaryId},${f.org.vendorId},${f.org.date},'CAD','0','0','0',${f.actor})`);
    return id;
  });
}

async function edit(f: Fixture, id: string, patch: Parameters<typeof applyDocumentEdit>[2]): Promise<void> {
  await withOrgContext(f.org.orgId, async () => {
    const current = await loadDocumentEditCurrent(id, f.org.orgId);
    assert.ok(current);
    await applyDocumentEdit(
      id,
      current,
      { ...patch, expectedUpdatedAt: current.updatedAt },
      { orgId: f.org.orgId, userId: f.actor, source: "api" },
    );
  });
}

async function storedLines(f: Fixture, id: string) {
  return withOrgContext(f.org.orgId, async () => (
    await db.execute<{
      id: string;
      lineNumber: number;
      accountId: string;
      amount: string;
      departmentId: string | null;
      groupId: string | null;
      ruleId: string | null;
      versionId: string | null;
      locked: boolean;
    }>(sql`
      select id, line_number as "lineNumber", account_id as "accountId", amount::text as amount,
             department_id as "departmentId", distribution_group_id as "groupId",
             distribution_rule_id as "ruleId", distribution_version_id as "versionId",
             distribution_locked as "locked"
        from document_lines where document_id = ${id} and org_id = ${f.org.orgId}
       order by line_number
    `)
  ).rows);
}

function sumAmounts(amounts: string[]): bigint {
  let total = 0n;
  for (const amount of amounts) {
    const negative = amount.startsWith("-");
    const [whole = "0", frac = ""] = amount.replace("-", "").split(".");
    const units = BigInt(whole) * 10000n + BigInt((frac + "0000").slice(0, 4));
    total += negative ? -units : units;
  }
  return total;
}

test("a bill line coded to a matching department explodes on save with exact children", { skip: !DB }, async () => {
  const f = await withBypassContext(() => fixture());
  try {
    const id = await draftBill(f, "ENTRY-AUTO-1");
    await edit(f, id, {
      lines: [
        { accountId: f.expenseAccount, amount: "100.0000", description: "pool cost", departmentId: f.deptSource },
        { accountId: f.expenseAccount, amount: "25.0000", description: "direct cost" },
      ],
    });
    const lines = await storedLines(f, id);
    assert.equal(lines.length, 3);
    const children = lines.filter((l) => l.groupId !== null);
    assert.equal(children.length, 2);
    assert.equal(children[0]!.groupId, children[1]!.groupId);
    assert.deepEqual(
      children.map((l) => l.amount).sort(),
      ["50.0000", "50.0000"],
    );
    assert.equal(sumAmounts(children.map((l) => l.amount)), sumAmounts(["100.0000"]));
    assert.deepEqual(
      children.map((l) => l.departmentId).sort(),
      [f.deptA, f.deptB].sort(),
    );
    for (const child of children) {
      assert.equal(child.ruleId, f.ruleId);
      assert.equal(child.versionId, f.versionId);
      assert.equal(child.locked, false);
    }
    const plain = lines.find((l) => l.groupId === null)!;
    assert.equal(plain.amount, "25.0000");
    const { doc, lineage } = await withOrgContext(f.org.orgId, async () => {
      const doc = await db.execute<{ total: string }>(
        sql`select total::text as total from documents where id = ${id} and org_id = ${f.org.orgId}`,
      );
      const lineage = (
        await db.execute<{ ruleId: string; amount: string; targetId: string | null; sourceId: string | null }>(sql`
          select rule_id as "ruleId", amount::text as amount,
                 target_document_line_id as "targetId", source_document_line_id as "sourceId"
            from allocation_lineage where org_id = ${f.org.orgId} and document_id = ${id}
        `)
      ).rows;
      return { doc, lineage };
    });
    assert.equal(doc.rows[0]?.total, "125.0000");
    assert.equal(lineage.length, 2);
    for (const row of lineage) {
      assert.equal(row.ruleId, f.ruleId);
      assert.ok(children.some((l) => l.id === row.targetId));
      assert.equal(row.sourceId, null);
    }
    // The drawer payload round-trips the stamps plus the rule name.
    const loaded = await withOrgContext(f.org.orgId, () => loadDocument(id, f.org.orgId));
    const childRows = (loaded?.lines as Record<string, unknown>[]).filter((l) => l.distribution_group_id !== null);
    assert.equal(childRows.length, 2);
    for (const row of childRows) {
      assert.equal(row.distribution_rule_name, "Overhead split");
      assert.equal(row.distribution_locked, false);
    }
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

test("header-default dims drive the automatic match when the line leaves them blank", { skip: !DB }, async () => {
  const f = await withBypassContext(() => fixture());
  try {
    const id = await draftBill(f, "ENTRY-HEADER-1");
    await edit(f, id, {
      departmentId: f.deptSource,
      lines: [{ accountId: f.expenseAccount, amount: "80.0000", description: "blank line" }],
    });
    const lines = await storedLines(f, id);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.groupId !== null));
    assert.equal(sumAmounts(lines.map((l) => l.amount)), sumAmounts(["80.0000"]));
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

test("re-save regenerates an unlocked group on sum change but keeps a locked one", { skip: !DB }, async () => {
  const f = await withBypassContext(() => fixture());
  try {
    const id = await draftBill(f, "ENTRY-REGEN-1");
    await edit(f, id, {
      lines: [{ accountId: f.expenseAccount, amount: "100.0000", departmentId: f.deptSource }],
    });
    const first = await storedLines(f, id);
    const groupId = first[0]!.groupId;
    assert.ok(groupId);

    // Changed sum, unlocked: regenerate from the group total, same group id.
    await edit(f, id, {
      lines: first.map((l, i) => ({
        accountId: l.accountId,
        amount: i === 0 ? "70.0000" : l.amount,
        departmentId: l.departmentId,
        distributionGroupId: l.groupId,
      })),
    });
    const regen = await storedLines(f, id);
    assert.equal(regen.length, 2);
    assert.ok(regen.every((l) => l.groupId === groupId));
    assert.equal(sumAmounts(regen.map((l) => l.amount)), sumAmounts(["120.0000"]));

    // Lock, then change again: the submitted children stay exactly as sent.
    await edit(f, id, {
      lines: regen.map((l) => ({
        accountId: l.accountId,
        amount: "10.0000",
        departmentId: l.departmentId,
        distributionGroupId: l.groupId,
        distributionLocked: true,
      })),
    });
    const locked = await storedLines(f, id);
    assert.deepEqual(locked.map((l) => l.amount), ["10.0000", "10.0000"]);
    assert.ok(locked.every((l) => l.locked));
    assert.ok(locked.every((l) => l.groupId === groupId));
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

test("un-split collapses a group to one line at the first child's coordinates", { skip: !DB }, async () => {
  const f = await withBypassContext(() => fixture());
  try {
    const id = await draftBill(f, "ENTRY-UNSPLIT-1");
    await edit(f, id, {
      lines: [{ accountId: f.expenseAccount, amount: "100.0000", departmentId: f.deptSource }],
    });
    const first = await storedLines(f, id);
    const groupId = first[0]!.groupId;
    assert.ok(groupId);
    await edit(f, id, {
      unsplitDistributionGroups: [groupId!],
      lines: first.map((l) => ({
        accountId: l.accountId,
        amount: l.amount,
        departmentId: l.departmentId,
        distributionGroupId: l.groupId,
      })),
    });
    const collapsed = await storedLines(f, id);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0]!.amount, "100.0000");
    assert.equal(collapsed[0]!.departmentId, first[0]!.departmentId);
    assert.equal(collapsed[0]!.groupId, null);
    assert.equal(collapsed[0]!.ruleId, null);
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

test("an explicit distributionKey explodes a manual rule and bad keys fail closed", { skip: !DB }, async () => {
  const f = await withBypassContext(() => fixture());
  const manualRuleId = randomUUID();
  const manualVersionId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`insert into allocation_rules
      (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
      values (${manualRuleId}, ${f.org.orgId}, 'manual-pick', 'Manual pick', 'entry', 10, true, false, '{}'::jsonb)`);
    await db.execute(sql`insert into allocation_rule_versions
      (id, org_id, rule_id, version_no, status, effective_from, effective_to, book_scope, book_ids,
       document_kinds, account_scope, dimension_filters, apply_policy, source_measure, basis_kind,
       basis_config, target_kind, dynamic_target, impact, residual_policy, solve_method, run_policy,
       run_offset_days, custom)
      values (${manualVersionId}, ${f.org.orgId}, ${manualRuleId}, 1, 'draft', '2026-01-01', null, 'primary', '[]'::jsonb,
       null, '{"kind":"any"}'::jsonb, '{}'::jsonb, 'manual', 'period_activity', 'fixed_percent',
       '{}'::jsonb, 'explicit', '{}'::jsonb, 'reclass', 'largest_share', 'sequential', 'manual',
       0, '{}'::jsonb)`);
    await db.execute(sql`insert into allocation_rule_targets
      (id, org_id, version_id, sequence, department_id, fixed_percent, extra_dims, is_remainder, custom)
      values (${randomUUID()}, ${f.org.orgId}, ${manualVersionId}, 0, ${f.deptA}, '100', '{}'::jsonb, false, '{}'::jsonb)`);
    await db.execute(sql`update allocation_rule_versions set status = 'published', definition_hash = 'entry-test-hash-manual'
      where id = ${manualVersionId} and org_id = ${f.org.orgId}`);
    await db.execute(sql`update allocation_rules set current_version_id = ${manualVersionId}
      where id = ${manualRuleId} and org_id = ${f.org.orgId}`);
  });
  try {
    const id = await draftBill(f, "ENTRY-KEY-1");
    await edit(f, id, {
      lines: [{ accountId: f.expenseAccount, amount: "30.0000", distributionKey: "manual-pick" }],
    });
    const lines = await storedLines(f, id);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.departmentId, f.deptA);
    assert.equal(lines[0]!.ruleId, manualRuleId);

    const badId = await draftBill(f, "ENTRY-KEY-2");
    await assert.rejects(
      edit(f, badId, {
        lines: [{ accountId: f.expenseAccount, amount: "30.0000", distributionKey: "no-such-rule" }],
      }),
      (error: unknown) =>
        error instanceof DocumentEditError &&
        error.status === 422 &&
        /does not match an allocation rule/.test(error.message),
    );
    // Nothing partial persists when the key is rejected.
    assert.equal((await storedLines(f, badId)).length, 0);

    const inactiveRuleId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into allocation_rules
        (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
        values (${inactiveRuleId}, ${f.org.orgId}, 'retired-pick', 'Retired pick', 'entry', 10, false, false, '{}'::jsonb)`);
    });
    await assert.rejects(
      edit(f, badId, {
        lines: [{ accountId: f.expenseAccount, amount: "30.0000", distributionKey: "retired-pick" }],
      }),
      (error: unknown) =>
        error instanceof DocumentEditError &&
        error.status === 422 &&
        /not active with a published version/.test(error.message),
    );

    const postRuleId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into allocation_rules
        (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
        values (${postRuleId}, ${f.org.orgId}, 'post-pick', 'Post pick', 'post', 10, true, false, '{}'::jsonb)`);
    });
    await assert.rejects(
      edit(f, badId, {
        lines: [{ accountId: f.expenseAccount, amount: "30.0000", distributionKey: "post-pick" }],
      }),
      (error: unknown) =>
        error instanceof DocumentEditError &&
        error.status === 422 &&
        /only entry rules can split document lines/.test(error.message),
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

test("posting a bill with exploded children writes journal lines per child", { skip: !DB }, async () => {
  const f = await withBypassContext(() => fixture());
  try {
    const id = await draftBill(f, "ENTRY-POST-1");
    await edit(f, id, {
      lines: [{ accountId: f.expenseAccount, amount: "100.0000", departmentId: f.deptSource }],
    });
    // Submit, posting, and the journal read run in the scratch org's scope.
    const legs = await withOrgContext(f.org.orgId, async () => {
      assert.equal((await submitAndReleaseIfUngated("vendor_bill", id, f.actor)).autoApproved, true);
      await postDocument(
        id,
        { control: { ar: f.org.accounts.ar, ap: f.org.accounts.ap, bank: f.org.accounts.bank } },
        { audit: { actorId: f.actor, source: "test" } },
      );
      return (
        await db.execute<{ accountId: string; departmentId: string | null; amount: string }>(sql`
          select l.account_id as "accountId", l.department_id as "departmentId", l.amount::text as amount
            from journal_lines l
            join documents d on d.org_id = l.org_id and d.posted_entry_id = l.entry_id
           where d.org_id = ${f.org.orgId} and d.id = ${id}
        `)
      ).rows;
    });
    const children = legs.filter((l) => l.accountId === f.expenseAccount);
    assert.equal(children.length, 2);
    assert.deepEqual(
      children.map((l) => `${l.departmentId}:${l.amount}`).sort(),
      [`${f.deptA}:50.0000`, `${f.deptB}:50.0000`].sort(),
    );
    assert.equal(sumAmounts(children.map((l) => l.amount)), sumAmounts(["100.0000"]));
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

test("feature off leaves distribution lines untouched", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { actor, id } = await withBypassContext(async () => {
      const actor = await createScratchUser(org.orgId, "Entry allocation off keeper", "entry_alloc_off_keeper");
      // No feature flags: the registry defaults (off) govern.
      const id = randomUUID();
      await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
        values (${id},${org.orgId},'vendor_bill','draft','ENTRY-OFF-1',${org.subsidiaryId},${org.vendorId},${org.date},'CAD','0','0','0',${actor})`);
      return { actor, id };
    });
    // The edit and its verification reads run in the scratch org's scope.
    const lines = await withOrgContext(org.orgId, async () => {
      const current = await loadDocumentEditCurrent(id, org.orgId);
      assert.ok(current);
      await applyDocumentEdit(
        id,
        current,
        {
          expectedUpdatedAt: current.updatedAt,
          lines: [
            {
              accountId: org.accounts.cogs,
              amount: "100.0000",
              description: "untouched",
              distributionKey: "whatever",
            },
          ],
        },
        { orgId: org.orgId, userId: actor, source: "api" },
      );
      const lines = (
        await db.execute<{ groupId: string | null; amount: string }>(sql`
          select distribution_group_id as "groupId", amount::text as amount
            from document_lines where document_id = ${id} and org_id = ${org.orgId}
        `)
      ).rows;
      assert.equal(
        (await db.execute<{ n: number }>(sql`select count(*)::int as n from allocation_lineage where org_id = ${org.orgId}`))
          .rows[0]?.n,
        0,
      );
      return lines;
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.groupId, null);
    assert.equal(lines[0]!.amount, "100.0000");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
