import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
const { sql } = await import('drizzle-orm')
const { withBypassContext, db, env } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { importStatement, startReconciliation } = await import('@openbooks/engine/src/banking/banking.ts')
const { ScopeNotFoundError } = await import('@openbooks/engine/src/organization/subsidiary-scope.ts')
const {
  addJournalMatchFromLine,
  applyRuleToLine,
  applyRulesToAccount,
  ensureOpenReconciliation,
  previewRules,
} = await import('./banking-rules.ts')

// Bank-rule services inherit the banking subsidiary boundary: every entry
// point that resolves an account or a statement line refuses an out-of-scope
// target with the uniform not-found before reading rules or touching the
// ledger.

interface Fixture {
  orgId: string
  actor: string
  date: string
  subA: string
  subB: string
  bankA: string
  bankB: string
  lineA: string
}

async function fixture(): Promise<Fixture> {
  const org = await withBypassContext(() => (createScratchOrg()))
  const actor = (await withBypassContext(() => (seedFlowActors(org.orgId)))).adminId
  const subB = randomUUID()
  await withBypassContext(() => (db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', 'CAD', 'CA')`)))
  const bankB = randomUUID()
  await withBypassContext(() => (db.execute(sql`insert into accounts
    (id, org_id, number, name, type, is_summary, is_active, eliminate,
     reconcilable, required_dimensions, custom, subsidiary_include_children,
     subsidiary_id, currency_restriction)
    values (${bankB}, ${org.orgId}, '1011', 'Second entity bank', 'asset_bank',
     false, true, false, true, '[]'::jsonb, '{}'::jsonb, true, ${subB}, 'CAD')`)))
  await withBypassContext(() => (db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD',
    subsidiary_id = ${org.subsidiaryId} where id = ${org.accounts.bank} and org_id = ${org.orgId}`)))
  const nonce = randomUUID().slice(0, 8)
  await importStatement(
    {
      accountId: org.accounts.bank,
      source: 'ofx',
      statementDate: org.date,
      openingBalance: '0',
      closingBalance: '33',
      currency: 'CAD',
      lines: [{
        postedOn: org.date,
        amount: '33',
        description: 'Scope probe deposit',
        bankTransactionId: `scope-lib-${nonce}`,
      }],
    },
    { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null },
  )
  const lineA = (await db.execute<{ id: string }>(sql`
    select id from bank_statement_lines where org_id = ${org.orgId} and account_id = ${org.accounts.bank}
  `)).rows[0]!.id
  return { orgId: org.orgId, actor, date: org.date, subA: org.subsidiaryId, subB, bankA: org.accounts.bank, bankB, lineA }
}

async function seedExcludeRule(orgId: string, actor: string): Promise<string> {
  const ruleId = randomUUID()
  await withBypassContext(() => (db.execute(sql`
    insert into bank_match_rules (id, org_id, name, criteria, outcome, priority, is_active, created_by)
    values (${ruleId}, ${orgId}, 'Scope probe excluder',
      '{"version":2,"match":{"combinator":"and","rules":[{"field":"description","op":"contains","value":"Scope probe"}]}}'::jsonb,
      '{"action":"exclude"}'::jsonb, 100, true, ${actor})`)))
  return ruleId
}

async function assertUniformNotFound(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    if (!(error instanceof ScopeNotFoundError)) return false
    return error.status === 404 && error.message === 'not found'
  })
}

test('ensureOpenReconciliation refuses an out-of-scope account before creating', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await fixture()
  try {
    await assertUniformNotFound(ensureOpenReconciliation(fx.orgId, fx.actor, fx.bankA, new Set([fx.subB])))
    const sessions = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from reconciliations where org_id = ${fx.orgId}`)).rows[0]!.n
    assert.equal(sessions, 0)
    const id = await ensureOpenReconciliation(fx.orgId, fx.actor, fx.bankA, new Set([fx.subA]))
    assert.ok(id)
  } finally { await dropScratchOrg(fx.orgId) }
})

test('applyRulesToAccount refuses an out-of-scope account without touching lines', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await fixture()
  try {
    await seedExcludeRule(fx.orgId, fx.actor)
    await assertUniformNotFound(applyRulesToAccount(fx.orgId, fx.actor, fx.bankA, new Set([fx.subB])))
    const status = (await db.execute<{ s: string }>(sql`
      select match_status as s from bank_statement_lines where id = ${fx.lineA}`)).rows[0]!.s
    assert.equal(status, 'unmatched')
    const applied = await applyRulesToAccount(fx.orgId, fx.actor, fx.bankA, new Set([fx.subA]))
    assert.equal(applied.excluded, 1)
  } finally { await dropScratchOrg(fx.orgId) }
})

test('applyRuleToLine refuses an out-of-scope statement line', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await fixture()
  try {
    const ruleId = await seedExcludeRule(fx.orgId, fx.actor)
    await assertUniformNotFound(
      applyRuleToLine(fx.orgId, fx.actor, { statementLineId: fx.lineA, ruleId }, new Set([fx.subB])),
    )
    await applyRuleToLine(fx.orgId, fx.actor, { statementLineId: fx.lineA, ruleId }, new Set([fx.subA]))
    const status = (await db.execute<{ s: string }>(sql`
      select match_status as s from bank_statement_lines where id = ${fx.lineA}`)).rows[0]!.s
    assert.equal(status, 'excluded')
  } finally { await dropScratchOrg(fx.orgId) }
})

test('addJournalMatchFromLine refuses out-of-scope line and offset accounts', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await fixture()
  try {
    const session = await startReconciliation(
      { accountId: fx.bankA, throughDate: fx.date, statementBalance: '33' },
      { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: null },
    )
    // Out-of-scope line: the session never matters.
    await assertUniformNotFound(
      addJournalMatchFromLine(
        fx.orgId, fx.actor,
        { statementLineId: fx.lineA, offsetAccountId: fx.bankA, reconciliationId: session.id },
        new Set([fx.subB]),
      ),
    )
    // In-scope line but another entity's offset account.
    await assertUniformNotFound(
      addJournalMatchFromLine(
        fx.orgId, fx.actor,
        { statementLineId: fx.lineA, offsetAccountId: fx.bankB, reconciliationId: session.id },
        new Set([fx.subA]),
      ),
    )
    const status = (await db.execute<{ s: string }>(sql`
      select match_status as s from bank_statement_lines where id = ${fx.lineA}`)).rows[0]!.s
    assert.equal(status, 'unmatched')
  } finally { await dropScratchOrg(fx.orgId) }
})

test('previewRules refuses an out-of-scope account without reading lines', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fx = await fixture()
  try {
    await assertUniformNotFound(
      previewRules(fx.orgId, fx.bankA, { onlyUnmatched: true, allowedSubsidiaryIds: new Set([fx.subB]) }),
    )
    const preview = await previewRules(fx.orgId, fx.bankA, { onlyUnmatched: true, allowedSubsidiaryIds: new Set([fx.subA]) })
    assert.equal(preview.scanned, 1)
  } finally { await dropScratchOrg(fx.orgId) }
})


const consolidatedRows = [
  { label: "banking list filter scope", register: async () => {
        const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { entityListSource } = await import('./list/entity-sources.ts')
        
        test('banking account filter options honor the caller subsidiary scope', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            const hiddenSubsidiary = randomUUID()
            const visibleAccount = randomUUID()
            const hiddenAccount = randomUUID()
            await withBypass(async () => {
              await db.execute(sql`
                insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
                values (${hiddenSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Hidden banking entity', 'CAD', 'CA')
              `)
              await db.execute(sql`
                insert into accounts
                  (id, org_id, number, name, type, reconcilable, currency_restriction, subsidiary_id)
                values
                  (${visibleAccount}, ${scratch.orgId}, '1097', 'Visible bank', 'asset_bank', true, 'CAD', ${scratch.subsidiaryId}),
                  (${hiddenAccount}, ${scratch.orgId}, '1096', 'Hidden bank', 'asset_bank', true, 'CAD', ${hiddenSubsidiary})
              `)
              await db.execute(sql`
                insert into reconciliations (id, org_id, account_id, through_date, currency, statement_balance)
                values
                  (${randomUUID()}, ${scratch.orgId}, ${visibleAccount}, ${scratch.date}, 'CAD', '0'),
                  (${randomUUID()}, ${scratch.orgId}, ${hiddenAccount}, ${scratch.date}, 'CAD', '0')
              `)
              await db.execute(sql`
                insert into bank_statements (id, org_id, account_id, source, statement_date, raw_file_ref)
                values
                  (${randomUUID()}, ${scratch.orgId}, ${visibleAccount}, 'manual', ${scratch.date}, 'audit-log:visible'),
                  (${randomUUID()}, ${scratch.orgId}, ${hiddenAccount}, 'manual', ${scratch.date}, 'audit-log:hidden')
              `)
            })
        
            for (const recordType of ['bank_reconciliation', 'bank_statement'] as const) {
              const source = entityListSource(recordType)
              assert.ok(source)
              const accountFilter = source.quickFilters?.find((filter) => filter.filterKey === 'account_id')
              assert.ok(accountFilter?.loadOptions)
              const loadOptions = accountFilter.loadOptions as (
                orgId: string,
                allowedSubsidiaryIds: ReadonlySet<string> | null,
              ) => Promise<{ value: string; label: string }[]>
              const options = await loadOptions(scratch.orgId, new Set([scratch.subsidiaryId]))
              assert.deepEqual(options.map((option) => option.value), [visibleAccount])
            }
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })
  } },
  { label: "banking rules", register: async () => {
        const { spawnSync }=await import("node:child_process");
        function runIntegrationSource(source: string): void {
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
        }
        
        test(
          "concurrent bank-rule applications claim a statement line before creating a journal",
          { skip: !env.OPENBOOKS_DB_URL },
          () => {
            runIntegrationSource(`
              import assert from "node:assert/strict";
              import { randomUUID } from "node:crypto";
              import { sql } from "drizzle-orm";
              import { db } from "./engine/src/platform/db.ts";
              import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
              import {
                createScratchOrg,
                dropScratchOrg,
                seedFlowActors,
              } from "./engine/src/testing/fixtures.ts";
              import {
                importStatement,
                startReconciliation,
              } from "./engine/src/banking/banking.ts";
              import { applyRuleToLine } from "./web/lib/banking-rules.ts";
        
              installTrustedTestDatabaseBypass();
              const org = await createScratchOrg();
              try {
                const actorId = (await seedFlowActors(org.orgId)).adminId;
                // Categorizing journals post to the ledger, so the applier holds gl.post
                // (76a56b8fef); scratch roles start with no permissions.
                await db.execute(sql\`update app_roles set permissions = '["gl.post"]'::jsonb
                  where org_id = \${org.orgId} and key = 'admin'\`);
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
                }, { orgId: org.orgId, userId: actorId, allowedSubsidiaryIds: null });
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
                }, { orgId: org.orgId, userId: actorId, allowedSubsidiaryIds: null })).id;
        
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
                  }, null),
                  applyRuleToLine(org.orgId, actorId, {
                    statementLineId,
                    ruleId,
                    reconciliationId,
                  }, null),
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
        
        test(
          "applyRuleToLine refuses an inactive rule without posting",
          { skip: !env.OPENBOOKS_DB_URL },
          () => {
            runIntegrationSource(`
              import assert from "node:assert/strict";
              import { randomUUID } from "node:crypto";
              import { sql } from "drizzle-orm";
              import { db } from "./engine/src/platform/db.ts";
              import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
              import {
                createScratchOrg,
                dropScratchOrg,
                seedFlowActors,
              } from "./engine/src/testing/fixtures.ts";
              import {
                importStatement,
                startReconciliation,
              } from "./engine/src/banking/banking.ts";
              import { applyRuleToLine } from "./web/lib/banking-rules.ts";
        
              installTrustedTestDatabaseBypass();
              const org = await createScratchOrg();
              try {
                const actorId = (await seedFlowActors(org.orgId)).adminId;
                // Categorizing journals post to the ledger, so the applier holds gl.post
                // (76a56b8fef); scratch roles start with no permissions.
                await db.execute(sql\`update app_roles set permissions = '["gl.post"]'::jsonb
                  where org_id = \${org.orgId} and key = 'admin'\`);
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
                  closingBalance: "75.0000",
                  currency: "CAD",
                  lines: [{
                    postedOn: org.date,
                    amount: "75.0000",
                    description: "Inactive rule transaction",
                    bankTransactionId: "bank-rule-inactive-1",
                  }],
                }, { orgId: org.orgId, userId: actorId, allowedSubsidiaryIds: null });
                assert.equal(imported.imported, 1);
                const statementLineId = (await db.execute(sql\`
                  select id
                    from bank_statement_lines
                   where org_id = \${org.orgId}
                     and bank_transaction_id = 'bank-rule-inactive-1'
                \`)).rows[0]?.id;
                assert.ok(statementLineId);
        
                const reconciliationId = (await startReconciliation({
                  accountId: org.accounts.bank,
                  throughDate: org.date,
                  statementBalance: "75.0000",
                }, { orgId: org.orgId, userId: actorId, allowedSubsidiaryIds: null })).id;
        
                const ruleId = randomUUID();
                await db.execute(sql\`
                  insert into bank_match_rules
                    (id, org_id, name, criteria, outcome, priority, is_active, created_by)
                  values
                    (\${ruleId}, \${org.orgId}, 'Disabled revenue rule',
                     \${JSON.stringify({
                       version: 2,
                       match: {
                         combinator: "and",
                         rules: [{ field: "description", op: "contains", value: "inactive" }],
                       },
                       accountScope: [org.accounts.bank],
                     })}::jsonb,
                     \${JSON.stringify({
                       action: "categorize",
                       version: 2,
                       mode: "auto",
                       lines: [{ accountId: org.accounts.revenue, portion: { kind: "remainder" } }],
                     })}::jsonb,
                     1, false, \${actorId})
                \`);
        
                await assert.rejects(
                  applyRuleToLine(org.orgId, actorId, {
                    statementLineId,
                    ruleId,
                    reconciliationId,
                  }, null),
                  /not active|disabled|inactive/,
                );
        
                const state = await db.execute(sql\`
                  select
                    (select count(*)::int
                       from documents
                      where org_id = \${org.orgId} and kind = 'journal') as journals,
                    (select count(*)::int
                       from reconciliation_matches
                      where org_id = \${org.orgId}
                        and statement_line_id = \${statementLineId}) as matches,
                    (select match_status
                       from bank_statement_lines
                      where org_id = \${org.orgId} and id = \${statementLineId}) as match_status
                \`);
                assert.deepEqual(state.rows[0], {
                  journals: 0,
                  matches: 0,
                  match_status: "unmatched",
                });
              } finally {
                await dropScratchOrg(org.orgId);
              }
            `);
          },
        );
        
        test(
          "bulk apply does not use a rule snapshot for lines after deactivation commits",
          { skip: !env.OPENBOOKS_DB_URL },
          () => {
            runIntegrationSource(`
              import assert from "node:assert/strict";
              import { randomUUID } from "node:crypto";
              import { sql } from "drizzle-orm";
              import { db, withOrgTransaction } from "./engine/src/platform/db.ts";
              import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
              import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./engine/src/testing/fixtures.ts";
              import { importStatement } from "./engine/src/banking/banking.ts";
              import { applyRulesToAccount } from "./web/lib/banking-rules.ts";
        
              installTrustedTestDatabaseBypass();
              const org = await createScratchOrg();
              let unlockLine;
              let lineLockPromise;
              try {
                const actorId = (await seedFlowActors(org.orgId)).adminId;
                await db.execute(sql\`update accounts set reconcilable = true, currency_restriction = 'CAD'
                  where id = \${org.accounts.bank} and org_id = \${org.orgId}\`);
                await importStatement({
                  accountId: org.accounts.bank,
                  source: "manual",
                  statementDate: org.date,
                  openingBalance: "0",
                  closingBalance: "30.0000",
                  currency: "CAD",
                  lines: [
                    { postedOn: org.date, amount: "10.0000", description: "Bulk disable race one", bankTransactionId: "bulk-disable-1" },
                    { postedOn: org.date, amount: "20.0000", description: "Bulk disable race two", bankTransactionId: "bulk-disable-2" },
                  ],
                }, { orgId: org.orgId, userId: actorId, allowedSubsidiaryIds: null });
                const lines = (await db.execute(sql\`
                  select id, match_status from bank_statement_lines
                   where org_id = \${org.orgId} and bank_transaction_id = any(ARRAY['bulk-disable-1','bulk-disable-2'])
                   order by line_number
                \`)).rows;
                assert.equal(lines.length, 2);
                const ruleId = randomUUID();
                await db.execute(sql\`
                  insert into bank_match_rules
                    (id, org_id, name, criteria, outcome, priority, is_active, created_by)
                  values (\${ruleId}, \${org.orgId}, 'Bulk disable rule',
                    \${JSON.stringify({
                      version: 2,
                      match: { combinator: "and", rules: [{ field: "description", op: "contains", value: "Bulk disable race" }] },
                      accountScope: [org.accounts.bank],
                    })}::jsonb,
                    '{"action":"exclude"}'::jsonb, 1, true, \${actorId})
                \`);
        
                let signalLineLocked;
                const lineLocked = new Promise((resolve) => { signalLineLocked = resolve; });
                const lineLockReleased = new Promise((resolve) => { unlockLine = resolve; });
                lineLockPromise = withOrgTransaction(org.orgId, async () => {
                  await db.execute(sql\`select id from bank_statement_lines where id = \${lines[0].id} for update\`);
                  signalLineLocked();
                  await lineLockReleased;
                });
                await lineLocked;
        
                const applying = applyRulesToAccount(org.orgId, actorId, org.accounts.bank, null);
                const waitForBlockedLine = async () => {
                  for (let attempt = 0; attempt < 200; attempt++) {
                    const blocked = await db.execute(sql\`
                      select 1 from pg_stat_activity
                       where datname = current_database() and pid <> pg_backend_pid()
                         and wait_event_type = 'Lock' and query ilike '%update bank_statement_lines%'
                    \`);
                    if (blocked.rows.length) return;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                  }
                  throw new Error("bulk apply never reached the locked first line");
                };
                await waitForBlockedLine();
        
                let deactivationFinished = false;
                const deactivation = withOrgTransaction(org.orgId, async () => {
                  await db.execute(sql\`update bank_match_rules set is_active = false where id = \${ruleId} and org_id = \${org.orgId}\`);
                  deactivationFinished = true;
                });
                // Let the UPDATE reach PostgreSQL before releasing the first line. In
                // the fixed path it waits on the active-rule lock; in the old path it
                // commits and exposes the stale-snapshot bug on the second line.
                for (let attempt = 0; attempt < 200 && !deactivationFinished; attempt++) {
                  await new Promise((resolve) => setTimeout(resolve, 10));
                }
                unlockLine();
                unlockLine = null;
                await Promise.all([applying, deactivation]);
        
                const statuses = (await db.execute(sql\`
                  select match_status from bank_statement_lines
                   where org_id = \${org.orgId} and bank_transaction_id = any(ARRAY['bulk-disable-1','bulk-disable-2'])
                   order by line_number
                \`)).rows.map((row) => row.match_status);
                assert.deepEqual(statuses, ["excluded", "unmatched"]);
              } finally {
                if (unlockLine) unlockLine();
                if (lineLockPromise) await lineLockPromise;
                await dropScratchOrg(org.orgId);
              }
            `);
          },
        );
        
        test(
          "rule preview flags an equal-priority saved rule as the winner",
          { skip: !env.OPENBOOKS_DB_URL },
          () => {
            runIntegrationSource(`
              import assert from "node:assert/strict";
              import { randomUUID } from "node:crypto";
              import { sql } from "drizzle-orm";
              import { db } from "./engine/src/platform/db.ts";
              import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
              import {
                createScratchOrg,
                dropScratchOrg,
                seedFlowActors,
              } from "./engine/src/testing/fixtures.ts";
              import { importStatement } from "./engine/src/banking/banking.ts";
              import { previewRules } from "./web/lib/banking-rules.ts";
        
              installTrustedTestDatabaseBypass();
              const org = await createScratchOrg();
              try {
                const actorId = (await seedFlowActors(org.orgId)).adminId;
                // Categorizing journals post to the ledger, so the applier holds gl.post
                // (76a56b8fef); scratch roles start with no permissions.
                await db.execute(sql\`update app_roles set permissions = '["gl.post"]'::jsonb
                  where org_id = \${org.orgId} and key = 'admin'\`);
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
                  closingBalance: "50.0000",
                  currency: "CAD",
                  lines: [{
                    postedOn: org.date,
                    amount: "50.0000",
                    description: "Equal priority tug of war",
                    bankTransactionId: "bank-rule-priority-1",
                  }],
                }, { orgId: org.orgId, userId: actorId, allowedSubsidiaryIds: null });
                assert.equal(imported.imported, 1);
        
                await db.execute(sql\`
                  insert into bank_match_rules
                    (id, org_id, name, criteria, outcome, priority, is_active, created_by)
                  values
                    (\${randomUUID()}, \${org.orgId}, 'Incumbent rule',
                     \${JSON.stringify({
                       version: 2,
                       match: {
                         combinator: "and",
                         rules: [{ field: "description", op: "contains", value: "tug of war" }],
                       },
                     })}::jsonb,
                     '{"action": "exclude"}'::jsonb,
                     100, true, \${actorId})
                \`);
        
                const preview = await previewRules(org.orgId, org.accounts.bank, {
                  draftRule: {
                    criteria: {
                      version: 2,
                      match: {
                        combinator: "and",
                        rules: [{ field: "description", op: "contains", value: "tug of war" }],
                      },
                    },
                    outcome: { action: "exclude" },
                    priority: 100,
                  },
                });
                assert.equal(preview.matched, 1);
                // A new draft sorts after every same-priority saved rule once saved,
                // so the incumbent wins the line on apply and the preview must say so.
                assert.equal(preview.conflicts, 1);
                assert.equal(preview.matches[0]?.stolenBy, "Incumbent rule");
              } finally {
                await dropScratchOrg(org.orgId);
              }
            `);
          },
        );
  } },
] as const;

for(const row of consolidatedRows) await row.register();
