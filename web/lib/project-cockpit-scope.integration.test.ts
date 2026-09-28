import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadProject } = await import('../app/api/projects/_lib')

/**
 * The project loader behind the cockpit flyout applies the caller's subsidiary
 * scope itself, so a hidden project is a missing project for every caller —
 * the page never has to remember to check.
 */
test('loadProject hides projects outside the caller subsidiary scope', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const other = randomUUID(), project = randomUUID()
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
        values (${project},${org.orgId},${other},'HIDDEN','Hidden cockpit',${org.customerId},'active',true,'{}'::jsonb)`)
      assert.equal((await loadProject(project, org.orgId))?.project.id, project, 'unscoped callers still load the project')
      assert.equal((await loadProject(project, org.orgId, null))?.project.id, project)
      assert.equal((await loadProject(project, org.orgId, new Set([org.subsidiaryId, other])))?.project.id, project)
      assert.equal(await loadProject(project, org.orgId, new Set([org.subsidiaryId])), null, 'hidden ⇒ missing')
      assert.equal(await loadProject(project, org.orgId, new Set()), null, 'empty scope denies everything')
    } finally { await dropScratchOrg(org.orgId) }
  })
})

test('project charges are customizable transactions instead of a parallel tab', () => {
  const project = getRecordType('project'), charge = getRecordType('project_charge')
  assert.ok(project && charge)
  assert.equal(project.tabs?.some((tab) => tab.key === 'charges'), false)
  assert.equal(charge.category, 'transaction')
  assert.deepEqual(charge.lineFields.map((field) => field.key), ['item_id', 'description', 'quantity', 'unit', 'cost_rate', 'amount', 'bill_rate', 'bill_amount', 'is_billable', 'project_id'])
})


const projectFeatureCases = [
  { label: "project percent feature race", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        const pg = (await import("pg")).default;
        type Authz = import("./authz").Authz;
        const state: { gate: Authz | null } = { gate: null };
        (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.project-percent-feature-race")] = state;
        registerHooks({ resolve(specifier, context, next) {
          if (specifier === "../../../../../lib/authz" && decodeURIComponent(context.parentURL ?? "").endsWith("/api/projects/[id]/percent-complete/route.ts")) {
            return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
              "export async function guardPermission(){return globalThis[Symbol.for('openbooks.project-percent-feature-race')].gate}") };
          }
          return next(specifier, context);
        } });
        const { sql } = await import("drizzle-orm");
        const { db, env } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { waitForLockWaiter } = await import("@openbooks/engine/src/testing/lock-wait.ts");
        const { PUT } = await import("../app/api/projects/[id]/percent-complete/route");

        test("project percent-complete refuses a Projects disable committed while its write waits", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await createScratchOrg();
          const writer = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL ?? env.OPENBOOKS_DB_URL });
          let pending: Promise<Response> | undefined;
          try {
            const actorId = (await seedFlowActors(org.orgId)).adminId;
            const projectId = randomUUID();
            state.gate = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(["projects.manage"]), allowedSubsidiaryIds: null } as Authz;
            await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"revenueRecognition":true}'::jsonb) where id=${org.orgId}`);
            await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,status,is_active,custom)
              values(${projectId},${org.orgId},${org.subsidiaryId},'PERCENT-FENCE','Percentage fence','active',true,'{}'::jsonb)`);
            const snapshot = async () => (await db.execute(sql`select custom,updated_at,updated_by from projects where org_id=${org.orgId} and id=${projectId}`)).rows[0]!;
            const before = await snapshot();
            // The override starts unset, so the mandatory compare-and-swap evidence is null.
            const send = () => PUT(new Request("https://openbooks.test/api/projects/fixture/percent-complete", {
              method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ percentComplete: 75, expectedPercentComplete: null }),
            }), { params: Promise.resolve({ id: projectId }) });
            await writer.connect();
            await writer.query("begin");
            // 0399 gates the bypass GUC by session role, so the writer connects as the privileged test login above.
            await writer.query("update orgs set settings=jsonb_set(settings,'{features,projects}','false'::jsonb) where id=$1", [org.orgId]);
            pending = send();
            void pending.catch(() => {});
            await waitForLockWaiter(writer, { label: "the percent-complete PUT" });
            await writer.query("commit");
            const response = await pending;
            assert.equal(response.status, 404, JSON.stringify(await response.json()));
            assert.deepEqual(await snapshot(), before, "disabled feature must preserve the override and its audit columns");
            await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,projects}','true'::jsonb) where id=${org.orgId}`);
            assert.equal((await send()).status, 200);
            assert.equal(((await snapshot()).custom as { percentCompleteOverride: number }).percentCompleteOverride, 75);
          } finally {
            await writer.query("rollback").catch(() => {});
            await writer.end();
            await pending?.catch(() => {});
            state.gate = null;
            await dropScratchOrg(org.orgId);
          }
        });
  } },
  { label: "project work breakdown feature gate", register: async () => {
        const assert = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const test = (await import('node:test')).default;
        const { sql } = await import('drizzle-orm')
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { createWorkBreakdownTask } = await import('./project-work-breakdown')
        const { ProjectWorkBreakdownError } = await import('./project-work-breakdown-validation')

        test('WBS service refuses direct task creation when Projects is disabled', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
              const projectId = randomUUID()
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,projects}', 'false'::jsonb, true) where id = ${org.orgId}`)
              await db.execute(sql`
                insert into projects (id, org_id, subsidiary_id, name, code)
                values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'Disabled Projects job', ${projectId})
              `)

              await assert.rejects(
                createWorkBreakdownTask({
                  orgId: org.orgId,
                  projectId,
                  actorId: actor,
                  allowedSubsidiaryIds: null,
                  input: { code: null, name: 'Should not persist', status: 'open', estimatedHours: '1', estimatedCost: '10' },
                }),
                (error: unknown) => error instanceof ProjectWorkBreakdownError && error.status === 404 && /projects feature is disabled/i.test(error.message),
              )
              assert.equal(
                (await db.execute<{ n: number }>(sql`select count(*)::int as n from project_tasks where org_id=${org.orgId}`)).rows[0]!.n,
                0,
              )
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
] as const;

for (const row of projectFeatureCases) await row.register();


const projectSubcontractCases = [
  { label: "subcontracts gate", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        // Regression for B-PRJ-06: web/lib/subcontracts-gate.ts re-implemented the
        // feature registry's defaults and the projects-parent dependency as inline
        // SQL. A non-boolean stored value (features.subcontracts='yes' via import)
        // mis-resolved through the PG ::boolean cast ('yes' casts to TRUE, so the
        // feature read ON against its off default; other spellings threw 22P02 and
        // the guarded routes 500'd), while the canonical resolver (featureEnabled:
        // non-boolean falls back to default) reads the feature cleanly off. The gate
        // must call the canonical resolver: non-boolean values read as the canonical
        // result with no 500, and a disabled projects parent disables subcontracts.
        const { guardSubcontractsFeature } = (await import("./subcontracts-gate.ts")) as typeof import(
          "./subcontracts-gate.ts"
        );

        const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg } = await import(
          "@openbooks/engine/src/testing/fixtures.ts"
        );

        async function setFeatures(orgId: string, features: Record<string, unknown>): Promise<void> {
          await withBypassContext(() => db.execute(sql`
            update orgs set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('features', ${JSON.stringify(features)}::jsonb)
             where id = ${orgId}`));
        }

        async function guard(orgId: string): Promise<number | null> {
          const res = await withBypassContext(() => guardSubcontractsFeature(orgId));
          if (res === null) return null;
          return res.status;
        }

        test("subcontracts gate resolves through the canonical feature registry", async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            // As an import would store it: a JSON string, not a boolean. 'yes' casts
            // to TRUE in Postgres, so the old inline SQL read the feature ON against
            // its off default; the canonical default is off → guarded (404).
            await setFeatures(org.orgId, { subcontracts: "yes" });
            assert.equal(await guard(org.orgId), 404);

            // A spelling no ::boolean cast accepts must also guard, not 500.
            await setFeatures(org.orgId, { subcontracts: "maybe" });
            assert.equal(await guard(org.orgId), 404);

            // A disabled projects parent disables subcontracts even when stored on
            // (subcontracts declares requiresAll ['projects'] in the registry).
            await setFeatures(org.orgId, { projects: false, subcontracts: true });
            assert.equal(await guard(org.orgId), 404);

            // An explicitly enabled flag stays enabled under an enabled parent.
            await setFeatures(org.orgId, { projects: true, subcontracts: true });
            assert.equal(await guard(org.orgId), null);
          } finally {
            await dropScratchOrg(org.orgId);
          }
        });
  } },
] as const;

for (const row of projectSubcontractCases) await row.register();

const projectCostingCases = [{ label: "project-costing-book-scope", register: async () => {
const assert = (await import("node:assert/strict")).default;
const { randomUUID } = await import("node:crypto");
const test = (await import("node:test")).default;
const { sql } = await import('drizzle-orm')
const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { projectCostSummary } = await import('./project-costing.ts')

test('project cost actuals and account detail stay in the primary book', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const secondaryBook = randomUUID()
    const project = randomUUID()
    await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${secondaryBook}, ${org.orgId}, 'TAX', 'Tax', false, true, true)`)
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, contract_value)
      values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'BOOK-SCOPE', 'Book scope project', ${org.customerId}, 'active', true, '0')`)

    async function post(bookId: string, amount: string, tag: string) {
      const entry = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${entry}, ${org.orgId}, ${bookId}, ${org.subsidiaryId}, ${tag}, ${org.date}, ${org.periodId}, 'project cost', 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entry}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${project}, ${amount}, 'CAD', ${amount}, '1'),
               (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, null, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
    }

    await post(org.bookId, '100', 'PRIMARY-COST')
    await post(secondaryBook, '900', 'TAX-COST')

    const summary = await projectCostSummary(org.orgId, project)
    assert.equal(summary.actual.cost, '100.0000')
    assert.deepEqual(summary.costByAccount.map((row) => ({ accountId: row.accountId, amount: row.amount })), [
      { accountId: org.accounts.cogs, amount: '100.0000' },
    ])
  } finally { await dropScratchOrg(org.orgId) }
})

const consolidatedRows = [
  { label: "project costing unbilled precision", register: async () => {
        const { sql } = await import('drizzle-orm')
        const { db } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { projectUnbilled } = await import('./project-costing.ts')

        test('project unbilled labor rounds fractional rate products to ledger precision', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await createScratchOrg()
          try {
            const employee = randomUUID()
            const project = randomUUID()
            await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
              values (${employee}, ${org.orgId}, 'employee', 'Fractional-rate worker', ${org.subsidiaryId})`)
            await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active)
              values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'DECIMAL', 'Decimal project', ${org.customerId}, 'active', true)`)
            await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, project_id, is_billable,
              cost_rate, bill_rate, status, billing_status)
              values (${randomUUID()}, ${org.orgId}, ${employee}, ${org.date}, '1.2345', ${project}, true,
                '1.2345', '1.2345', 'approved', 'unbilled')`)

            const unbilled = await projectUnbilled(org.orgId, project)
            assert.equal(unbilled.revenue, '1.5240')
            assert.equal(unbilled.cost, '1.5240')
            assert.equal(unbilled.hours, 1.2345)
          } finally { await dropScratchOrg(org.orgId) }
        })
  } },
] as const;

for(const row of consolidatedRows) await row.register();
}}] as const; for (const row of projectCostingCases) await row.register();

const projectRankingCases = [{ label: "project-ranking-subsidiary-scope", register: async () => {
const assert = (await import("node:assert/strict")).default;
const { randomUUID } = await import("node:crypto");
const test = (await import("node:test")).default;
const { sql } = await import('drizzle-orm')
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { rankProjects } = await import('./project-ranking')
const { marginPercentText } = await import('./financial-decimal')

test('ranked margin rounds the half-up tie exactly (1.005% -> 1.01)', () => {
  assert.equal(marginPercentText('1.0050', '100.0000'), '1.01')
})

test('project ranking counts only purchase order commitments visible to the caller', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const hiddenSubsidiary = randomUUID()
      const project = randomUUID()
      await db.execute(sql`insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Restricted entity', 'CAD', 'CA')`)
      await db.execute(sql`insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status, is_active, contract_value)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'SCOPE-RANK', 'Scope ranking', ${org.customerId}, 'active', true, 0)`)

      async function purchaseOrder(subsidiaryId: string, amount: string) {
        const documentId = randomUUID()
        await db.execute(sql`insert into documents(id, org_id, kind, document_number, document_date, currency, status, party_id, subsidiary_id, subtotal, total)
          values (${documentId}, ${org.orgId}, 'purchase_order', ${documentId}, ${org.date}, 'CAD', 'draft', ${org.vendorId}, ${subsidiaryId}, ${amount}, ${amount})`)
        await db.execute(sql`insert into document_lines(org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, project_id, subsidiary_id)
          values (${org.orgId}, ${documentId}, 1, ${org.accounts.cogs}, 'Open project commitment', 1, ${amount}, ${amount}, ${project}, ${subsidiaryId})`)
        await db.execute(sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${documentId}`)
      }

      await purchaseOrder(org.subsidiaryId, '100')
      await purchaseOrder(hiddenSubsidiary, '900')

      const args = { limit: 10, withActivityOnly: false }
      const restricted = await rankProjects(org.orgId, args, new Set([org.subsidiaryId]))
      const unrestricted = await rankProjects(org.orgId, args, null)
      assert.equal(restricted.rows.find((row) => row.id === project)?.committedCost, '100.0000')
      assert.equal(unrestricted.rows.find((row) => row.id === project)?.committedCost, '1000.0000')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})

const consolidatedRows = [
  { label: "project dimension inheritance", register: async () => {
        const { spawnSync }=await import("node:child_process");
        const { env }=await import("@openbooks/engine/src/platform/db.ts");
        test(
          "project financials inherit header scope while preserving line overrides",
          { skip: !env.OPENBOOKS_DB_URL },
          () => {
            const source = `
              import assert from "node:assert/strict";
              import { randomUUID } from "node:crypto";
              import { sql } from "drizzle-orm";
              import { db, withOrg } from "./engine/src/platform/db.ts";
              import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
              import {
                createScratchOrg,
                dropScratchOrg,
                seedFlowActors,
              } from "./engine/src/testing/fixtures.ts";
              import { generateInvoiceFromBillingRequest } from "./web/lib/billing.ts";
              import { createBillingRequest } from "./web/lib/billing-requests.ts";
              import { resolveProjectFinancials } from "./web/lib/project-financials.ts";
              import { projectUnbilled } from "./web/lib/project-costing.ts";
              import { loadProjectType } from "./web/lib/project-type.ts";

              // Web modules install the normal request resolver during evaluation.
              // Re-establish the explicit test-only trusted boundary afterwards.
              installTrustedTestDatabaseBypass();
              const org = await createScratchOrg();
              try {
                await db.execute(sql\`update orgs set settings = jsonb_set(settings, '{controlAccounts,projectRevenue}', to_jsonb(\${org.accounts.revenue}::text), true) where id = \${org.orgId}\`);
                const projectA = randomUUID();
                const projectB = randomUUID();
                await db.execute(sql\`
                  insert into projects
                    (id, org_id, subsidiary_id, code, name, customer_id, status,
                     is_active, custom)
                  values
                    (\${projectA}, \${org.orgId}, \${org.subsidiaryId}, 'PROJECT-A',
                     'Inherited project', \${org.customerId}, 'active', true, '{}'::jsonb),
                    (\${projectB}, \${org.orgId}, \${org.subsidiaryId}, 'PROJECT-B',
                     'Line override project', \${org.customerId}, 'active', true, '{}'::jsonb)
                \`);

                const chargeId = randomUUID();
                const inheritedLineId = randomUUID();
                const overrideLineId = randomUUID();
                await db.execute(sql\`
                  insert into documents
                    (id, org_id, kind, document_number, party_id, subsidiary_id,
                     project_id, document_date, posting_date, currency, fx_rate,
                     status, subtotal, tax_total, total, is_final_invoice, custom,
                     extra_dims)
                  values (
                    \${chargeId}, \${org.orgId}, 'project_charge', 'CHARGE-MIXED',
                    \${org.customerId}, \${org.subsidiaryId}, \${projectA},
                    \${org.date}, \${org.date}, 'CAD', 1, 'draft',
                    '880', '0', '880', false, '{}'::jsonb, '{}'::jsonb
                  )
                \`);
                await db.execute(sql\`
                  insert into document_lines
                    (id, org_id, document_id, line_number, project_id, account_id,
                     description, quantity, unit_price, amount, cost_amount,
                     bill_amount, tax_amount, is_billable, quantity_fulfilled,
                     quantity_billed, custom, tax_overridden, extra_dims)
                  values
                    (\${inheritedLineId}, \${org.orgId}, \${chargeId}, 1, null,
                     \${org.accounts.cogs}, 'Inherited header project', '1', '80',
                     '80', '80', '100', '0', true, '0', '0', '{}'::jsonb, false,
                     '{}'::jsonb),
                    (\${overrideLineId}, \${org.orgId}, \${chargeId}, 2, \${projectB},
                     \${org.accounts.cogs}, 'Explicit line override', '1', '800',
                     '800', '800', '900', '0', true, '0', '0', '{}'::jsonb, false,
                     '{}'::jsonb)
                \`);
                await db.execute(sql\`
                  update documents
                     set status = 'approved'
                   where id = \${chargeId} and org_id = \${org.orgId}
                \`);

                await withOrg(org.orgId, async () => {
                  const typeA = await loadProjectType(org.orgId, projectA);
                  const typeB = await loadProjectType(org.orgId, projectB);
                  const financialA = await resolveProjectFinancials(
                    org.orgId,
                    projectA,
                    typeA.financialProfile,
                  );
                  const financialB = await resolveProjectFinancials(
                    org.orgId,
                    projectB,
                    typeB.financialProfile,
                  );
                  const unbilledA = await projectUnbilled(org.orgId, projectA);
                  const unbilledB = await projectUnbilled(org.orgId, projectB);

                  assert.equal(financialA.measures.billable_cost_value, "100.0000");
                  assert.equal(financialB.measures.billable_cost_value, "900.0000");
                  assert.equal(financialA.documents.length, 1);
                  assert.equal(financialA.documents[0].amount, "100.0000");
                  assert.equal(financialB.documents.length, 1);
                  assert.equal(financialB.documents[0].amount, "900.0000");
                  assert.deepEqual(
                    {
                      revenue: unbilledA.revenue,
                      cost: unbilledA.cost,
                      costLineCount: unbilledA.costLineCount,
                    },
                    { revenue: "100.0000", cost: "80.0000", costLineCount: 1 },
                  );
                  assert.deepEqual(
                    {
                      revenue: unbilledB.revenue,
                      cost: unbilledB.cost,
                      costLineCount: unbilledB.costLineCount,
                    },
                    { revenue: "900.0000", cost: "800.0000", costLineCount: 1 },
                  );

                  const actors = await seedFlowActors(org.orgId);
                  const request = await createBillingRequest(
                    org.orgId,
                    actors.adminId,
                    {
                      projectId: projectA,
                      basis: "date_range",
                      startDate: "2026-07-01",
                      cutoffDate: "2026-07-31",
                      backupRequired: false,
                    },
                  );
                  const invoice = await generateInvoiceFromBillingRequest(
                    org.orgId,
                    actors.adminId,
                    request.id,
                  );
                  const billed = await db.execute(sql\`
                    select d.subtotal::text,
                           count(il.id)::int as line_count,
                           coalesce(sum(il.amount), 0)::text as line_total,
                           inherited.billed_by_line_id as inherited_billed_by,
                           overridden.billed_by_line_id as override_billed_by
                      from documents d
                      join document_lines il on il.document_id = d.id
                      join document_lines inherited on inherited.id = \${inheritedLineId}
                      join document_lines overridden on overridden.id = \${overrideLineId}
                     where d.id = \${invoice.id}
                     group by d.id, inherited.billed_by_line_id,
                              overridden.billed_by_line_id
                  \`);
                  assert.equal(billed.rows[0].subtotal, "100.0000");
                  assert.equal(billed.rows[0].line_count, 1);
                  assert.equal(billed.rows[0].line_total, "100.0000");
                  assert.ok(billed.rows[0].inherited_billed_by);
                  assert.equal(billed.rows[0].override_billed_by, null);
                });
              } finally {
                await dropScratchOrg(org.orgId);
              }
            `;
            const result = spawnSync(
              process.execPath,
              [
                "--conditions=react-server",
                "--import",
                "tsx",
                "--import",
                "./engine/src/testing/database-bypass.ts",
                "--input-type=module",
                "-e",
                source,
              ],
              { cwd: process.cwd(), env: process.env, encoding: "utf8" },
            );
            assert.equal(result.status, 0, result.stderr || result.stdout);
          },
        );
  } },
] as const;

for(const row of consolidatedRows) await row.register();
}}] as const; for (const row of projectRankingCases) await row.register();

const projectScheduleCases = [{ label: "project-schedule-dependency-inputs", register: async () => {
const { createScheduleDependency, createScheduleTask, deleteScheduleBaseline, deleteScheduleDependency, ScheduleError } = await import('./project-schedule')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/** Invalid scheduling inputs fail as domain errors before PostgreSQL writes. */
test('schedule dependency and task-creation inputs fail closed', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"projectScheduling":true}'::jsonb) where id = ${org.orgId}`)
      const project = randomUUID()
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, name, code)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'Dependency inputs project', ${project})`)
      const taskA = await createScheduleTask(org.orgId, project, { name: 'Task A' }, actor, null)
      const taskB = await createScheduleTask(org.orgId, project, { name: 'Task B' }, actor, null)

      for (const [attempt, reason] of [
        [() => createScheduleDependency(org.orgId, project, { predecessorId: taskA, successorId: taskB, type: 'XX' }, actor, null), /dependency type/i],
        [() => createScheduleDependency(org.orgId, project, { predecessorId: taskA, successorId: taskB, lagDays: 1e30 }, actor, null), /lag/i],
        [() => createScheduleTask(org.orgId, project, { name: 'Bad order', order: 'oops' as unknown as number }, actor, null), /order/i],
      ] as const) {
        await assert.rejects(attempt(), (error: unknown) => error instanceof ScheduleError && reason.test(error.message))
      }
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from schedule_dependencies where org_id=${org.orgId}`)).rows[0]!.n, 0)

      // Legal values still persist.
      await createScheduleDependency(org.orgId, project, { predecessorId: taskA, successorId: taskB, type: 'SS', lagDays: -2 }, actor, null)
      await createScheduleTask(org.orgId, project, { name: 'Good order', order: 3 }, actor, null)
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from schedule_dependencies where org_id=${org.orgId}`)).rows[0]!.n, 1)

      const otherProject = randomUUID()
      const baseline = randomUUID()
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, name, code) values (${otherProject}, ${org.orgId}, ${org.subsidiaryId}, 'Other project', ${otherProject})`)
      await db.execute(sql`insert into schedule_baselines (id, org_id, project_id, name) values (${baseline}, ${org.orgId}, ${otherProject}, 'Other project baseline')`)
      await db.execute(sql`insert into schedule_baseline_tasks (org_id, baseline_id, task_id, task_name) values (${org.orgId}, ${baseline}, ${taskA}, 'Pinned snapshot')`)
      await assert.rejects(deleteScheduleBaseline(org.orgId, project, baseline, null),
        (error: unknown) => error instanceof ScheduleError && error.status === 404)
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from schedule_baseline_tasks where baseline_id=${baseline}`)).rows[0]!.n, 1)
      await assert.rejects(deleteScheduleDependency(org.orgId, project, randomUUID(), null),
        (error: unknown) => error instanceof ScheduleError && error.status === 404)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})


const consolidatedRows = [
  { label: "project schedule feature gate", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { createScheduleTask, ScheduleError } = await import('./project-schedule')

        test('project schedule service refuses direct task creation when scheduling is disabled', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
              const projectId = randomUUID()
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,projectScheduling}', 'false'::jsonb, true) where id = ${org.orgId}`)
              await db.execute(sql`
                insert into projects (id, org_id, subsidiary_id, name, code)
                values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'Schedule gate project', ${projectId})
              `)

              await assert.rejects(
                createScheduleTask(org.orgId, projectId, { name: 'Should not persist' }, actor, null),
                (error: unknown) => error instanceof ScheduleError && error.status === 404 && /project scheduling feature is disabled/i.test(error.message),
              )
              assert.equal(
                (await db.execute<{ n: number }>(sql`select count(*)::int as n from project_tasks where org_id=${org.orgId} and project_id=${projectId}`)).rows[0]!.n,
                0,
              )
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
  { label: "project schedule parent validation", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { updateScheduleTask, ScheduleError } = await import('./project-schedule')

        const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

        /**
         * The task outline is a project-bounded tree. A parent pin must name a task
         * in the SAME project, never the task itself, and never a descendant —
         * otherwise the outline silently corrupts (cross-project ghosts, self loops,
         * ancestor cycles) while the module promises project-bounded writes.
         */
        test('schedule parent pins stay inside the project tree', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
                coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"projectScheduling":true}'::jsonb) where id = ${org.orgId}`)
              const projectA = randomUUID(), projectB = randomUUID()
              for (const [id, code] of [[projectA, 'TREE-A'], [projectB, 'TREE-B']] as const) {
                await db.execute(sql`
                  insert into projects (id, org_id, subsidiary_id, name, code)
                  values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${code}, ${id})`)
              }
              const taskA = randomUUID(), taskB = randomUUID(), foreign = randomUUID()
              for (const [id, project, name] of [
                [taskA, projectA, 'Task A'],
                [taskB, projectA, 'Task B'],
                [foreign, projectB, 'Foreign task'],
              ] as const) {
                await db.execute(sql`
                  insert into project_tasks (id, org_id, project_id, name, schedule_order)
                  values (${id}, ${org.orgId}, ${project}, ${name}, 1)`)
              }
              const parentOf = async (id: string) =>
                (await db.execute<{ parent_id: string | null }>(sql`
                  select parent_id from project_tasks where id = ${id} and org_id = ${org.orgId}`)).rows[0]!.parent_id

              // A task cannot parent to itself.
              await assert.rejects(
                updateScheduleTask(org.orgId, projectA, taskA, { parentTaskId: taskA }, actor, null),
                (error: unknown) => error instanceof ScheduleError && /parent/i.test(error.message),
              )
              assert.equal(await parentOf(taskA), null)

              // A parent must live in the same project.
              await assert.rejects(
                updateScheduleTask(org.orgId, projectA, taskA, { parentTaskId: foreign }, actor, null),
                (error: unknown) => error instanceof ScheduleError && /parent/i.test(error.message),
              )
              assert.equal(await parentOf(taskA), null)

              // A same-project parent applies, but closing the loop back must fail.
              await updateScheduleTask(org.orgId, projectA, taskA, { parentTaskId: taskB }, actor, null)
              assert.equal(await parentOf(taskA), taskB)
              await assert.rejects(
                updateScheduleTask(org.orgId, projectA, taskB, { parentTaskId: taskA }, actor, null),
                (error: unknown) => error instanceof ScheduleError && /parent/i.test(error.message),
              )
              assert.equal(await parentOf(taskB), null)
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
  { label: "project schedule patch validation", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { updateScheduleTask, ScheduleError } = await import('./project-schedule')

        const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

        /**
         * Schedule patch values are interpolated into DATE and UUID columns. An
         * impossible calendar day or a malformed resource id must fail closed as a
         * domain error before any write — never escape as a PostgreSQL error (a 500).
         */
        test('schedule task patches refuse impossible dates and malformed resource ids', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
                coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"projectScheduling":true}'::jsonb) where id = ${org.orgId}`)
              const projectId = randomUUID(), taskId = randomUUID()
              await db.execute(sql`
                insert into projects (id, org_id, subsidiary_id, name, code)
                values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'Patch validation project', ${projectId})
              `)
              await db.execute(sql`
                insert into project_tasks (id, org_id, project_id, name, schedule_order)
                values (${taskId}, ${org.orgId}, ${projectId}, 'Patchable task', 1)
              `)

              await assert.rejects(
                updateScheduleTask(org.orgId, projectId, taskId, { startDate: '2026-02-30' }, actor, null),
                (error: unknown) => error instanceof ScheduleError && /valid date/.test(error.message),
              )
              await assert.rejects(
                updateScheduleTask(org.orgId, projectId, taskId, { resourceAssignments: [{ resourceId: 'not-a-uuid', units: 1 }] }, actor, null),
                (error: unknown) => error instanceof ScheduleError && /valid resource/.test(error.message),
              )
              const untouched = (await db.execute<{ start: string | null; n: number }>(sql`
                select schedule_start::text as start,
                       (select count(*)::int from schedule_task_assignments where org_id=${org.orgId} and task_id=${taskId}) as n
                  from project_tasks where id=${taskId} and org_id=${org.orgId}`)).rows[0]!
              assert.equal(untouched.start, null)
              assert.equal(untouched.n, 0)

              // Real values still apply.
              await updateScheduleTask(org.orgId, projectId, taskId, { startDate: '2026-02-27', endDate: '2026-02-28' }, actor, null)
              assert.equal((await db.execute<{ start: string }>(sql`
                select schedule_start::text as start from project_tasks where id=${taskId} and org_id=${org.orgId}`)).rows[0]!.start, '2026-02-27')
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
] as const;

for (const row of consolidatedRows) await row.register();
}}] as const; for (const row of projectScheduleCases) await row.register();

const taskRevisionCases = [{ label: "task-revision-integrity", register: async () => {
const assert = (await import("node:assert/strict")).default;
const test = (await import("node:test")).default;
const { registerHooks } = await import("node:module");
type SessionUser = import("./auth").SessionUser;
const { stubModules } = await import("../testing/stub-modules.ts");
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __emailRevisionSession: session });
stubModules({ intl: true, navigation: false, authz: false, features: false });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__emailRevisionSession.user}' };
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withOrg } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createWorkBreakdownTask, loadWorkBreakdownTasks, updateWorkBreakdownTask } = await import('./project-work-breakdown');
const { parseExpectedTaskVersion } = await import('./project-work-breakdown-validation');
const { randomUUID } = await import('node:crypto');
for (const operation of ['read', 'stale', 'repeat']) {
  test(`project task revision ${operation}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId,'Project administrator','reviewer');
      const projectId = randomUUID();
      await db.execute(sql`insert into projects (id,org_id,subsidiary_id,name,code) values (${projectId},${org.orgId},${org.subsidiaryId},'Revision project',${projectId})`);
      const input = {code:null,name:'First',status:'open' as const,estimatedHours:'10',estimatedCost:'100'};
      const args = {orgId:org.orgId,projectId,actorId:actor,allowedSubsidiaryIds:null,input};
      await withOrg(org.orgId,async()=>{
        const task = await createWorkBreakdownTask(args);
        if(operation!=='repeat') await db.execute(sql`update project_tasks set updated_at=date_trunc('second',now()+interval '1 day')+interval '123450 microseconds' where id=${task.id}`);
        const listed = (await loadWorkBreakdownTasks(org.orgId,projectId,null))[0]!;
        const version = parseExpectedTaskVersion(listed.updatedAt);
        if(operation==='read') {assert.match(version,/\.\d{6}Z$/);return;}
        if(operation==='stale') {
          await db.execute(sql`update project_tasks set name='Concurrent task',updated_at=updated_at+interval '1 microsecond' where id=${task.id}`);
          await assert.rejects(updateWorkBreakdownTask({...args,taskId:task.id,expectedUpdatedAt:version,input:{...input,name:'Stale task'}}),/changed after you opened/);
        } else {
          const saved = await updateWorkBreakdownTask({...args,taskId:task.id,expectedUpdatedAt:version,input:{...input,name:'Second'}});
          assert.notEqual(saved.updatedAt,version,'each committed task edit needs a new token');
          await assert.rejects(updateWorkBreakdownTask({...args,taskId:task.id,expectedUpdatedAt:version}),/changed after you opened/);
        }
      });
    } finally { await dropScratchOrg(org.orgId); }
  });
}
test('independent task editors do not upgrade their shared project locks', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org=await createScratchOrg();
  let go=()=>{};
  let edits:Promise<unknown>[]=[];
  try {
    const actor=await createScratchUser(org.orgId,'Project administrator','reviewer');
    const projectId=randomUUID();
    await db.execute(sql`insert into projects (id,org_id,subsidiary_id,name,code) values (${projectId},${org.orgId},${org.subsidiaryId},'Revision project',${projectId})`);
    const input={code:null,name:'First',status:'open' as const,estimatedHours:'10',estimatedCost:'100'};
    const args={orgId:org.orgId,projectId,actorId:actor,allowedSubsidiaryIds:null,input};
    const tasks=[await createWorkBreakdownTask(args),await createWorkBreakdownTask(args)];
    let ready=()=>{},n=0;
    const both=new Promise<void>(r=>{ready=r});
    const start=new Promise<void>(r=>{go=r});
    edits=tasks.map(task=>withOrg(org.orgId,async()=>{
      await db.execute(sql`select id from projects where id=${projectId} for share`);
      if(++n===2)ready();
      await start;
      return updateWorkBreakdownTask({...args,taskId:task.id,expectedUpdatedAt:task.updatedAt,input:{...input,name:'Independent edit'}});
    }));
    await Promise.race([both,Promise.all(edits)]);go();
    const outcomes=await Promise.allSettled(edits);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,2,JSON.stringify(outcomes));
  }finally{go();await Promise.allSettled(edits);await dropScratchOrg(org.orgId);}
});
}}] as const; for (const row of taskRevisionCases) await row.register();

const subcontractTransitionCases = [{ label: "subcontract transition validation", register: async () => {
  const stateKey = Symbol.for("openbooks.subcontract-transition-route-test");
  const state = { transitionCalls: 0 };
  (globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;
  const { registerHooks } = await import("node:module");
  const mockSources = new Map<string, string>([
    ["mock:authz", "export async function guardPermission(){return {user:{orgId:'org-1',id:'user-1'},permissions:new Set(['*']),allowedSubsidiaryIds:null}};export function guardSubsidiaryScope(){return null}"],
    ["mock:subsidiaries", "export function subsidiaryVisibleFilter(){return ''}"],
    ["mock:feature-gate", "export async function guardSubcontractsFeature(){return null}"],
    ["mock:features", "export async function isFeatureEnabled(){return true}"],
    ["mock:db", "export const db={async execute(){throw Error('database work should not run for invalid transitions')},async transaction(){throw Error('transaction work should not run for invalid transitions')}}"],
    ["mock:subcontracts", `const state=globalThis[Symbol.for('openbooks.subcontract-transition-route-test')];export {parseSubcontractTransitionAction,SubcontractConflictError,SubcontractError} from ${JSON.stringify(new URL('../../engine/src/projects/subcontracts.ts',import.meta.url).href)};export async function transitionSubcontract(){state.transitionCalls++};export function addSubcontractSovLine(){};export function approveSubcontract(){};export function approveSubcontractChangeOrder(){};export function approveVendorPayApplication(){};export function createSubcontract(){};export function createSubcontractChangeOrder(){};export function createSubcontractPaymentControl(){};export function createVendorPayApplication(){};export function generateVendorPayApplicationBill(){};export function releaseSubcontractPaymentControl(){};export function releaseVendorRetainage(){};export function removeSubcontractSovLine(){};export function submitSubcontract(){};export function submitVendorPayApplication(){};export function updateDraftSubcontract(){};export function updateVendorPayApplicationLines(){};export function voidSubcontractChangeOrder(){};export function voidVendorPayApplication(){}`],
  ]);
  const mockUrls = new Map<string, string>([
    ["../../../lib/authz", "mock:authz"], ["../../../lib/subcontracts-gate", "mock:feature-gate"], ["../../../lib/subsidiaries", "mock:subsidiaries"],
    ["../../../lib/features", "mock:features"], ["@openbooks/engine/src/platform/db.ts", "mock:db"], ["@openbooks/engine/src/projects/subcontracts.ts", "mock:subcontracts"],
  ]);
  const hooks = registerHooks({
    resolve(specifier, context, next) { const mock = mockUrls.get(specifier); return mock ? { url: mock, shortCircuit: true } : next(specifier, context) },
    load(url, context, next) { const source = mockSources.get(url); return source === undefined ? next(url, context) : { format: "module", source, shortCircuit: true } },
  });
  const { POST } = await import("../app/api/subcontracts/route.ts?subcontract-transition-contract");
  hooks.deregister();
  test("subcontract API refuses an invalid transition before the engine call", async () => {
    state.transitionCalls = 0;
    const response = await POST(new Request("http://openbooks.test/api/subcontracts", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "transitionSubcontract", id: "subcontract-1", transition: "approve" }) }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid subcontract transition action" });
    assert.equal(state.transitionCalls, 0, "invalid input must not reach the transition engine");
  });
}}] as const;
for (const row of subcontractTransitionCases) await row.register();
