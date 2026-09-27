import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "./auth";
import { stubModules } from '../testing/stub-modules.ts'

const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __accountInputSession: session });
stubModules({ intl: true, navigation: false, authz: false, features: false });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__accountInputSession.user}" };
    }
    return next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { listScopedAccountOptions } = await import('./scoped-options');
const { PATCH } = await import("../app/api/accounts/[id]/route");
const { POST } = await import("../app/api/accounts/route");

const invalidInputs: Array<[string, Record<string, unknown>]> = [
  ["numeric number", { number: 123 }],
  ["object name", { name: {} }],
  ["object description", { description: {} }],
  ["object parent", { parentId: {} }],
  ["object currency", { currencyRestriction: {} }],
  ["object subsidiary", { subsidiaryId: {} }],
  ["string summary", { isSummary: "true" }],
  ["string activation", { isActive: "false" }],
  ["string elimination", { eliminate: "true" }],
  ["numeric descendants", { subsidiaryIncludeChildren: 0 }],
  ["string reconciliation", { reconcilable: "true" }],
  ["string monetary", { monetary: "false" }],
  ["null activation", { isActive: null }],
  ["array custom", { custom: [] }],
];
for (const method of ["POST", "PATCH"] as const) {
  for (const [label, fields] of [...invalidInputs, ["valid edit", { name: "Reviewed account", description: "Reviewed", monetary: false }],
    ["explicit clear", { number: null, description: "", parentId: null, currencyRestriction: null, subsidiaryId: null, monetary: null }]] as Array<[string, Record<string, unknown>]>) {
    test(`account input integrity ${method}: ${label}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const actor = await createScratchUser(org.orgId, "Account controller", "reviewer");
        await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"multiCurrency":true,"multiSubsidiary":true}'::jsonb) where id=${org.orgId}`);
        session.user = { id: actor, orgId: org.orgId, name: "Account controller", email: "account@scratch.test", roles: [], isSuperAdmin: false,
          envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
        const id = randomUUID();
        if (method === "PATCH") {
          await db.execute(sql`insert into accounts(id,org_id,number,name,type,description,currency_restriction,subsidiary_id,monetary)
            values (${id},${org.orgId},'AUDIT-1','Original account','asset_other','Original description','CAD',${org.subsidiaryId},true)`);
        }
        const before = (await db.execute(sql`select * from accounts where id=${id}`)).rows[0];
        const body = method === "POST" ? { name: "New account", type: "asset_other", ...fields } : fields;
        const invoke = () => withOrgContext(org.orgId, () => {
          const request = new Request("http://audit.local/api/accounts/" + id, {
            method, headers: { "Idempotency-Key": id }, body: JSON.stringify(body),
          });
          return method === "POST" ? POST(request) : PATCH(request, { params: Promise.resolve({ id }) });
        });
        const response = await invoke();
        const accepted = label === "valid edit" || label === "explicit clear";
        const responseBody = await response.json();
        if (accepted) assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(responseBody));
        else assert.ok(response.status === 400 || response.status === 422, `expected validation refusal, got ${response.status}: ${JSON.stringify(responseBody)}`);
        const after = (await db.execute(sql`select * from accounts where id=${id}`)).rows[0];
        if (!accepted) assert.deepEqual(after, before, "malformed input cannot change account policy");
        else if (label === "valid edit") {
          assert.equal(after?.name, "Reviewed account");
          assert.equal(after?.monetary, false);
          if (method === "PATCH") assert.equal(after?.currency_restriction, "CAD");
        } else {
          for (const field of ["number", "description", "parent_id", "currency_restriction", "subsidiary_id", "monetary"]) assert.equal(after?.[field], null, field);
        }
        if (accepted && method === "POST") {
          assert.equal((await invoke()).status, 200, "exact create replay stays idempotent");
        }
        const audits = (await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log
          where org_id=${org.orgId} and table_name='accounts' and row_id=${id}`)).rows[0]!.n;
        assert.equal(audits, accepted ? 1 : 0);
      } finally {
        session.user = null;
        await dropScratchOrg(org.orgId);
      }
    });
  }
}


const accountListCases = [
  { label: "account list subsidiary", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const test = (await import('node:test')).default;
        const { sql } = await import('drizzle-orm');
        const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { accountBaseJoins } = await import('./customization/entity-list-query/accounts.ts')

        test('account list balances exclude journal lines outside the caller subsidiary scope', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            const hiddenSubsidiary = randomUUID()
            const accountId = randomUUID()
            const offsetAccountId = randomUUID()
            const visibleEntry = randomUUID()
            const hiddenEntry = randomUUID()
            await withBypass(async () => {
              await db.execute(sql`
                insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
                values (${hiddenSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Hidden list entity', 'CAD', 'CA')
              `)
              await db.execute(sql`
                insert into accounts (id, org_id, number, name, type, is_summary, is_active)
                values
                  (${accountId}, ${scratch.orgId}, '1098', 'Scoped list account', 'asset_bank', false, true),
                  (${offsetAccountId}, ${scratch.orgId}, '4098', 'Scoped list offset', 'income', false, true)
              `)
              for (const [entryId, number, subsidiaryId, amount, offset] of [
                [visibleEntry, 'ACCOUNT-LIST-VISIBLE', scratch.subsidiaryId, '100.0000', '-100.0000'],
                [hiddenEntry, 'ACCOUNT-LIST-HIDDEN', hiddenSubsidiary, '40.0000', '-40.0000'],
              ] as const) {
                await db.execute(sql`
                  insert into journal_entries
                    (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
                  values
                    (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${subsidiaryId}, ${number}, ${scratch.date},
                     ${scratch.periodId}, 'draft', 'manual')
                `)
                await db.execute(sql`
                  insert into journal_lines
                    (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
                  values
                    (${scratch.orgId}, ${entryId}, 1, ${accountId}, ${subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
                    (${scratch.orgId}, ${entryId}, 2, ${offsetAccountId}, ${subsidiaryId}, ${offset}, 'CAD', ${offset}, '1')
                `)
                await db.execute(sql`
                  update journal_entries set status = 'posted', posted_at = now()
                   where id = ${entryId} and org_id = ${scratch.orgId}
                `)
              }
            })

            const scopedJoin = (accountBaseJoins as unknown as (
              today: string,
              allowedSubsidiaryIds?: ReadonlySet<string> | null,
            ) => ReturnType<typeof accountBaseJoins>)(scratch.date, new Set([scratch.subsidiaryId]))
            const scoped = await withBypass(() => db.execute<{ balance: string }>(sql`
              select account_balance.amount::text as balance
                from accounts a
                ${scopedJoin}
               where a.org_id = ${scratch.orgId} and a.id = ${accountId}
            `))
            assert.equal(scoped.rows[0]?.balance, '100.0000')
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })

        test('an explicitly empty subsidiary scope reads no balance instead of widening to org scope', async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            const accountId = randomUUID()
            const offsetAccountId = randomUUID()
            const entryId = randomUUID()
            await withBypass(async () => {
              await db.execute(sql`
                insert into accounts (id, org_id, number, name, type, is_summary, is_active)
                values
                  (${accountId}, ${scratch.orgId}, '1099', 'Empty-scope account', 'asset_bank', false, true),
                  (${offsetAccountId}, ${scratch.orgId}, '4099', 'Empty-scope offset', 'income', false, true)
              `)
              await db.execute(sql`
                insert into journal_entries
                  (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
                values
                  (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'ACCOUNT-LIST-EMPTY-SCOPE',
                   ${scratch.date}, ${scratch.periodId}, 'draft', 'manual')
              `)
              await db.execute(sql`
                insert into journal_lines
                  (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
                values
                  (${scratch.orgId}, ${entryId}, 1, ${accountId}, ${scratch.subsidiaryId}, '100.0000', 'CAD', '100.0000', '1'),
                  (${scratch.orgId}, ${entryId}, 2, ${offsetAccountId}, ${scratch.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', '1')
              `)
              await db.execute(sql`
                update journal_entries set status = 'posted', posted_at = now()
                 where id = ${entryId} and org_id = ${scratch.orgId}
              `)
            })

            const joinFor = (scope?: ReadonlySet<string> | null) =>
              (accountBaseJoins as unknown as (
                today: string,
                allowedSubsidiaryIds?: ReadonlySet<string> | null,
              ) => ReturnType<typeof accountBaseJoins>)(scratch.date, scope)
            const balanceUnder = async (scope?: ReadonlySet<string> | null) =>
              (await withBypass(() => db.execute<{ balance: string | null }>(sql`
                select account_balance.amount::text as balance
                  from accounts a
                  ${joinFor(scope)}
                 where a.org_id = ${scratch.orgId} and a.id = ${accountId}
              `))).rows[0]?.balance ?? null

            assert.equal(await balanceUnder(new Set()), '0', 'present-but-empty scope denies every line')
            assert.equal(await balanceUnder(null), '100.0000', 'unrestricted scope still reads the posted line')
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })
  } },
  { label: "account option subsidiary scope", register: async () => {
        test('account option reader includes only accounts assigned to the caller subsidiaries', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const other = randomUUID(), visible = randomUUID(), hidden = randomUUID(), shared = randomUUID()
              await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
                values (${other},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`)
              await db.execute(sql`insert into accounts(id,org_id,number,name,type,subsidiary_id,is_active,is_summary)
                values (${visible},${org.orgId},'93001','Visible clearing','expense',${org.subsidiaryId},true,false),
                       (${hidden},${org.orgId},'93002','Hidden clearing','expense',${other},true,false),
                       (${shared},${org.orgId},'93003','Shared clearing','expense',null,true,false)`)
              const scoped = await listScopedAccountOptions(org.orgId, new Set([org.subsidiaryId]), { activeOnly: true, postingOnly: true })
              const all = await listScopedAccountOptions(org.orgId, null, { activeOnly: true, postingOnly: true })
              assert.ok(scoped.some(account => account.id === visible))
              assert.ok(!scoped.some(account => account.id === hidden))
              assert.ok(scoped.some(account => account.id === shared), 'null subsidiary is shared master data')
              assert.ok(all.some(account => account.id === hidden))
            } finally { await dropScratchOrg(org.orgId) }
          })
        })
  } },
] as const;

for (const row of accountListCases) await row.register();
