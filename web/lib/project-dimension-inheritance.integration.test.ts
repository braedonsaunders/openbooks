import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

test(
  "project financials inherit header scope while preserving line overrides",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    const source = `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { sql } from "drizzle-orm";
      import { db, withOrg } from "./engine/src/db.ts";
      import {
        createScratchOrg,
        dropScratchOrg,
        seedFlowActors,
      } from "./engine/src/test-fixtures.ts";
      import { generateInvoiceFromBillingRequest } from "./web/lib/billing.ts";
      import { createBillingRequest } from "./web/lib/billing-requests.ts";
      import { resolveProjectFinancials } from "./web/lib/project-financials.ts";
      import { projectUnbilled } from "./web/lib/project-costing.ts";
      import { loadProjectType } from "./web/lib/project-type.ts";

      const org = await createScratchOrg();
      try {
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
            \${org.date}, \${org.date}, 'CAD', 1, 'approved',
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
        "--input-type=module",
        "-e",
        source,
      ],
      { cwd: process.cwd(), env: process.env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
);
