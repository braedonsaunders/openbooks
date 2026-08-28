import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

function runIntegrationSource(source: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--import",
      "./engine/src/test-database-bypass.ts",
      "--input-type=module",
      "-e",
      source,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test(
  "concurrent bank-rule applications claim a statement line before creating a journal",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    runIntegrationSource(`
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { sql } from "drizzle-orm";
      import { db } from "./engine/src/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
      import {
        createScratchOrg,
        dropScratchOrg,
        seedFlowActors,
      } from "./engine/src/test-fixtures.ts";
      import {
        importStatement,
        startReconciliation,
      } from "./engine/src/banking.ts";
      import { applyRuleToLine } from "./web/lib/banking-rules.ts";

      installTrustedTestDatabaseBypass();
      const org = await createScratchOrg();
      try {
        const actorId = (await seedFlowActors(org.orgId)).adminId;
        await db.execute(sql\`
          update accounts
             set reconcilable = true, currency_restriction = 'CAD'
           where id = \${org.accounts.bank} and org_id = \${org.orgId}
        \`);

        const imported = await importStatement({
          accountId: org.accounts.bank,
          source: "manual",
          statementDate: org.date,
          openingBalance: "0",
          closingBalance: "125.2500",
          currency: "CAD",
          lines: [{
            postedOn: org.date,
            amount: "125.2500",
            description: "Concurrent bank-rule transaction",
            bankTransactionId: "bank-rule-concurrent-1",
          }],
        }, { orgId: org.orgId, userId: actorId });
        assert.equal(imported.imported, 1);
        const statementLineId = (await db.execute(sql\`
          select id
            from bank_statement_lines
           where org_id = \${org.orgId}
             and bank_transaction_id = 'bank-rule-concurrent-1'
        \`)).rows[0]?.id;
        assert.ok(statementLineId);

        const reconciliationId = (await startReconciliation({
          accountId: org.accounts.bank,
          throughDate: org.date,
          statementBalance: "125.2500",
        }, { orgId: org.orgId, userId: actorId })).id;

        const ruleId = randomUUID();
        await db.execute(sql\`
          insert into bank_match_rules
            (id, org_id, name, criteria, outcome, priority, is_active, created_by)
          values
            (\${ruleId}, \${org.orgId}, 'Concurrent revenue rule',
             \${JSON.stringify({
               version: 2,
               match: {
                 combinator: "and",
                 rules: [{ field: "description", op: "contains", value: "concurrent" }],
               },
               accountScope: [org.accounts.bank],
             })}::jsonb,
             \${JSON.stringify({
               action: "categorize",
               version: 2,
               mode: "auto",
               lines: [{ accountId: org.accounts.revenue, portion: { kind: "remainder" } }],
             })}::jsonb,
             1, true, \${actorId})
        \`);

        const attempts = await Promise.allSettled([
          applyRuleToLine(org.orgId, actorId, {
            statementLineId,
            ruleId,
            reconciliationId,
          }),
          applyRuleToLine(org.orgId, actorId, {
            statementLineId,
            ruleId,
            reconciliationId,
          }),
        ]);
        assert.equal(
          attempts.filter((result) => result.status === "fulfilled").length,
          1,
          "exactly one invocation owns the line",
        );
        const rejected = attempts.find((result) => result.status === "rejected");
        assert.ok(rejected && rejected.reason instanceof Error);
        assert.match(rejected.reason.message, /Statement line is unavailable/);

        const state = await db.execute(sql\`
          select
            (select count(*)::int
               from documents
              where org_id = \${org.orgId} and kind = 'journal') as journals,
            (select count(*)::int
               from journal_entries
              where org_id = \${org.orgId} and status = 'posted') as posted_entries,
            (select count(*)::int
               from reconciliation_matches
              where org_id = \${org.orgId}
                and reconciliation_id = \${reconciliationId}
                and statement_line_id = \${statementLineId}
                and matched_by = 'rule') as rule_matches,
            (select match_status
               from bank_statement_lines
              where org_id = \${org.orgId} and id = \${statementLineId}) as match_status
        \`);
        assert.deepEqual(state.rows[0], {
          journals: 1,
          posted_entries: 1,
          rule_matches: 1,
          match_status: "matched",
        });
      } finally {
        await dropScratchOrg(org.orgId);
      }
    `);
  },
);
