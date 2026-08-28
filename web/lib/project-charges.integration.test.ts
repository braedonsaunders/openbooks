import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { env } from '@openbooks/engine/src/db.ts'

function runIntegrationSource(source: string): void {
  const result = spawnSync(
    process.execPath,
    [
      '--conditions=react-server',
      '--import',
      'tsx',
      '--import',
      './engine/src/test-database-bypass.ts',
      '--input-type=module',
      '-e',
      source,
    ],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

test(
  'a post-commit project-charge failure exposes its durable identity for repair',
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    const source = `
      import assert from 'node:assert/strict';
      import { randomUUID } from 'node:crypto';
      import { sql } from 'drizzle-orm';
      import { db } from './engine/src/db.ts';
      import { installTrustedTestDatabaseBypass } from './engine/src/test-database-bypass.ts';
      import { createScratchOrg, dropScratchOrg, seedFlowActors } from './engine/src/test-fixtures.ts';
      import { ChargeCommittedError, createProjectCharge } from './web/lib/project-charges.ts';

      installTrustedTestDatabaseBypass();
      const org = await createScratchOrg();
      try {
        const actorId = (await seedFlowActors(org.orgId)).adminId;
        const projectId = randomUUID();
        const itemId = randomUUID();
        await db.execute(sql\`
          insert into projects
            (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
          values
            (\${projectId}, \${org.orgId}, \${org.subsidiaryId}, 'CHARGE-FAILURE',
             'Charge failure job', \${org.customerId}, 'active', true, '{}'::jsonb)
        \`);
        await db.execute(sql\`
          insert into items
            (id, org_id, kind, code, name, default_cost, default_rate,
             expense_account_id, cost_recovery_account_id, income_account_id,
             is_active, custom)
          values
            (\${itemId}, \${org.orgId}, 'service', 'CHG-SVC', 'Charge service',
             '10.0000', '15.0000', \${org.accounts.cogs}, \${org.accounts.adjustment},
             \${org.accounts.revenue}, true, '{}'::jsonb)
        \`);

        // The charge writer has already committed by the time posting resolves
        // its accounting period. Removing the period forces that post-commit
        // failure while leaving the newly-created document durable.
        await db.execute(sql\`delete from accounting_periods where org_id = \${org.orgId}\`);

        let failure;
        await assert.rejects(
          createProjectCharge(org.orgId, actorId, {
            projectId,
            documentDate: org.date,
            lines: [{ itemId, quantity: '1', costRate: '10', billRate: '15' }],
          }),
          (error) => {
            failure = error;
            return error instanceof ChargeCommittedError
              && error.stage === 'posting'
              && error.chargeId.length > 0
              && error.documentNumber.startsWith('CHG-')
              && String(error.cause).includes('no accounting period covers');
          },
        );

        const persisted = (await db.execute(sql\`
          select id, document_number, status
            from documents
           where id = \${failure.chargeId} and org_id = \${org.orgId}
        \`)).rows[0];
        assert.deepEqual(persisted, {
          id: failure.chargeId,
          document_number: failure.documentNumber,
          status: 'approved',
        });

        const draft = await createProjectCharge(org.orgId, actorId, {
          projectId,
          documentDate: org.date,
          lines: [{ itemId, quantity: '1', costRate: '10', billRate: '15' }],
        }, { post: false });
        assert.ok(draft.id);
        assert.match(draft.documentNumber, /^CHG-/);
        assert.equal(draft.approvalPending, false);
      } finally {
        await dropScratchOrg(org.orgId);
      }
    `;
    runIntegrationSource(source);
  },
);
