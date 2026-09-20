import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The generic record writer funnels document writes through the same
// createDocumentDraft + applyDocumentEdit path the drawer uses (including
// the create-path totals preflight), so a distributionKey on an API line
// must explode exactly like an interactive save.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { API_RECORD_TYPES, toResolved } = await import("./registry-data.ts");
const { createRecord } = await import("./writers.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;
const bills = toResolved(API_RECORD_TYPES.find((t) => t.key === "bills")!);

interface Fixture {
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  user: {
    id: string;
    email: string;
    name: string;
    roles: { key: string; name: string }[];
    orgId: string;
    envKind: "production";
    productionOrgId: string;
    isSuperAdmin: boolean;
    homeUserId: string;
    homeOrgId: string;
  };
  expenseAccount: string;
  deptSource: string;
  deptA: string;
  deptB: string;
  deptC: string;
  taxCode: string;
}

async function fixture(): Promise<Fixture> {
  const seeded = await withBypassContext(async () => {
    const org = await createScratchOrg();
    const actor = await createScratchUser(org.orgId, "Writer distribution keeper", "writer_dist_keeper");
    await db.execute(sql`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"allocations":true,"allocationsAtEntry":true}'::jsonb)
      where id=${org.orgId}`);
    const expenseAccount = randomUUID();
    await db.execute(sql`insert into accounts
      (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, monetary,
       required_dimensions, custom, subsidiary_include_children)
      values (${expenseAccount}, ${org.orgId}, '6200', 'Writer distribution expense', 'expense',
        false, true, false, false, true, '[]'::jsonb, '{}'::jsonb, true)`);
    const deptSource = randomUUID();
    const deptA = randomUUID();
    const deptB = randomUUID();
    const deptC = randomUUID();
    await db.execute(sql`insert into departments(id,org_id,name)
      values (${deptSource},${org.orgId},'Writer pool'),
             (${deptA},${org.orgId},'Writer A'),
             (${deptB},${org.orgId},'Writer B'),
             (${deptC},${org.orgId},'Writer C')`);
    const taxCode = randomUUID();
    await db.execute(sql`insert into tax_codes(id,org_id,code,name,is_active,collected_account_id,paid_account_id)
      values(${taxCode},${org.orgId},'WRITER-10','Writer tax 10%',true,${org.accounts.taxOutput},${org.accounts.taxInput})`);
    await db.execute(sql`insert into tax_rates(org_id,tax_code_id,rate_percent,effective_from)
      values(${org.orgId},${taxCode},'10','2026-01-01')`);
    // Thirds: per-child tax rounds down while the parent would round up, so
    // the totals prove the create path recomputed after exploding instead of
    // reusing its preflight.
    const ruleId = randomUUID();
    const versionId = randomUUID();
    await db.execute(sql`insert into allocation_rules
      (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
      values (${ruleId}, ${org.orgId}, 'writer-thirds', 'Writer thirds', 'entry', 100, true, false, '{}'::jsonb)`);
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
      values (${randomUUID()}, ${org.orgId}, ${versionId}, 0, ${deptA}, '33.3333', '{}'::jsonb, false, '{}'::jsonb),
             (${randomUUID()}, ${org.orgId}, ${versionId}, 1, ${deptB}, '33.3333', '{}'::jsonb, false, '{}'::jsonb),
             (${randomUUID()}, ${org.orgId}, ${versionId}, 2, ${deptC}, '33.3334', '{}'::jsonb, false, '{}'::jsonb)`);
    await db.execute(sql`update allocation_rule_versions set status = 'published', definition_hash = 'writer-test-hash'
      where id = ${versionId} and org_id = ${org.orgId}`);
    await db.execute(sql`update allocation_rules set current_version_id = ${versionId}
      where id = ${ruleId} and org_id = ${org.orgId}`);
    return { org, actor, expenseAccount, deptSource, deptA, deptB, deptC, taxCode };
  });
  const { org, actor, expenseAccount, deptSource, deptA, deptB, deptC, taxCode } = seeded;
  const user = {
    id: actor,
    email: "writer-dist@scratch.test",
    name: "Writer Dist",
    roles: [{ key: "admin", name: "Admin" }],
    orgId: org.orgId,
    envKind: "production" as const,
    productionOrgId: org.orgId,
    isSuperAdmin: false,
    homeUserId: actor,
    homeOrgId: org.orgId,
  };
  return { org, user, expenseAccount, deptSource, deptA, deptB, deptC, taxCode };
}

test("API bill create explodes a matching line and retaxes the children", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const result = await withOrgContext(f.org.orgId, () => createRecord(
      f.user,
      bills,
      [],
      {
        partyId: f.org.vendorId,
        documentDate: f.org.date,
        lines: [
          {
            accountId: f.expenseAccount,
            amount: "10.0000",
            taxCodeId: f.taxCode,
            departmentId: f.deptSource,
          },
        ],
      },
      { source: "api", allowedSubsidiaryIds: null },
    ));
    assert.equal(result.status, 201);
    const docId = (
      loaded: unknown,
    ): string => (loaded as { doc: { id: string } }).doc.id;
    const id = docId(result.body);
    const lines = (
      await withOrgContext(f.org.orgId, () => db.execute<{ amount: string; taxAmount: string; departmentId: string | null; groupId: string | null }>(sql`
        select amount::text as amount, tax_amount::text as "taxAmount",
               department_id as "departmentId", distribution_group_id as "groupId"
          from document_lines where document_id = ${id} and org_id = ${f.org.orgId}
         order by line_number
      `))
    ).rows;
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((l) => l.amount).sort(), ["3.3333", "3.3333", "3.3334"]);
    assert.ok(lines.every((l) => l.groupId !== null));
    // Per-child tax in cents (0.33 x 3 = 0.99), not the parent's 1.00: the
    // create path recomputed after the explosion instead of reusing its
    // preflight. The engine rounds every line's tax to cents, so the
    // children are taxed exactly like hand-entered lines.
    assert.deepEqual(lines.map((l) => l.taxAmount).sort(), ["0.3300", "0.3300", "0.3300"]);
    const totals = (
      await withOrgContext(f.org.orgId, () => db.execute<{ subtotal: string; taxTotal: string; total: string }>(sql`
        select subtotal::text as subtotal, tax_total::text as "taxTotal", total::text as total
          from documents where id = ${id} and org_id = ${f.org.orgId}
      `))
    ).rows[0];
    assert.deepEqual(totals, { subtotal: "10.0000", taxTotal: "0.9900", total: "10.9900" });
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("API bill create rejects an unknown distributionKey with a clear error", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const result = await withOrgContext(f.org.orgId, () => createRecord(
      f.user,
      bills,
      [],
      {
        partyId: f.org.vendorId,
        documentDate: f.org.date,
        lines: [
          {
            accountId: f.expenseAccount,
            amount: "10.0000",
            departmentId: f.deptSource,
            distributionKey: "no-such-rule",
          },
        ],
      },
      { source: "api", allowedSubsidiaryIds: null },
    ));
    assert.equal(result.status, 422);
    assert.match((result.body as { error: string }).error, /does not match an allocation rule/);
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});
