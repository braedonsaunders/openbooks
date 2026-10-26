import { registerHooks } from "node:module";
import { resolveAppModule } from "./test-module-hooks";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import * as React from "react";
import { stubModules } from "../testing/stub-modules.ts";
const repo = process.cwd();
const root = pathToFileURL(repo + "/").href;
const state: { user: import("./auth").SessionUser | null } = { user: null };
Object.assign(globalThis, { __bankingPagesState: state, React });
stubModules({
  navigation: false,
  intl: 'export async function getTranslations(){const t=(s)=>s;t.has=()=>false;t.rich=(s)=>s;return t;};export async function getLocale(){return "en"}',
  authz: false,
  features: false,
});

registerHooks({
  resolve(s, c, next) {
    if (
      (s === "./auth" || s.endsWith("/lib/auth")) &&
      c.parentURL?.includes("/web/") &&
      !c.parentURL.includes("/web/lib/auth.ts")
    ) {
      // Session identity comes from the test principal; every other auth
      // export (cookie names, token helpers used by locale/report-pdf) is the
      // real module's.
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export * from ${JSON.stringify(root + "web/lib/auth.ts")};export async function currentUser(){return globalThis.__bankingPagesState.user;}`,
          ),
      };
    }
    const app = resolveAppModule(s, c, next, root);
    if (app) return app;
    return next(s, c);
  },
});

const { db, withBypassContext, withOrgContext } =
  (await import("@openbooks/engine/platform/db")) as typeof import("@openbooks/engine/platform/db");
const { sql } = (await import(
  root + "node_modules/drizzle-orm/index.js"
)) as typeof import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } =
  (await import("@openbooks/engine/testing/fixtures")) as typeof import("@openbooks/engine/testing/fixtures");
const { startReconciliation, importStatement, createMatch } =
  await import("@openbooks/engine/banking/banking");
// The page's LOADER, not its rendered tree.
//
// This test asserts which book and which currency the page's queries use, and
// that decision now lives entirely in the loader — the spec only names where
// the resolved rows are drawn. Walking the tree for a workspace component's
// props stopped working when `ModuleView` became the single render path (an
// async server component's children do not exist until it is rendered), and
// reaching for its props was always indirection: the loader's own output is
// the thing under test, and reading it directly is both stronger and stable
// against any later change to how the page is arranged.
const { loadMatch } = await import(root + "web/app/(app)/banking/match/view.ts");
const { loadReconciliation } = await import(
  root + "web/app/(app)/banking/[accountId]/reconcile/[reconciliationId]/view.ts"
);
const { loadBankingAccount } = await import(root + "web/app/(app)/banking/[accountId]/view.ts");
const { StatementDrawer } = await import(
  root + "web/app/(app)/banking/[accountId]/StatementDrawer.tsx"
);

for (const page of ["match", "reconcile"] as const) {
  test(
    `bank ${page} page uses primary book and bank-currency amounts`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      const org = await withBypassContext(() => createScratchOrg());
      try {
        const actor = await withBypassContext(() =>
          createScratchUser(org.orgId, "Bank operator", "admin"),
        );
        await withBypassContext(() =>
          db.execute(
            sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`,
          ),
        );
        state.user = {
          id: actor,
          orgId: org.orgId,
          isSuperAdmin: false,
          name: "Bank operator",
          email: "bank@scratch.test",
          roles: [],
          envKind: "production",
          productionOrgId: org.orgId,
          homeOrgId: org.orgId,
          homeUserId: actor,
        };
        const tax = randomUUID();
        let primaryLine = "";
        await withBypassContext(async () => {
          await db.execute(
            sql`insert into accounting_books(id,org_id,code,name,is_primary) values(${tax},${org.orgId},'TAX','Tax',false)`,
          );
          for (const variant of ["primary-usd", "tax-usd", "legacy-cad"]) {
            const entry = randomUUID(),
              line = randomUUID();
            const currency = variant === "legacy-cad" ? "CAD" : "USD";
            const amount = currency === "USD" ? "135" : "100";
            const fx = currency === "USD" ? "1.35" : "1";
            await db.transaction(async (tx) => {
              await tx.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
              values(${entry},${org.orgId},${variant === "tax-usd" ? tax : org.bookId},${org.subsidiaryId},${variant},${org.date},${org.periodId},'draft','manual')`);
              await tx.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
              values(${line},${org.orgId},${entry},1,${org.accounts.bank},${org.subsidiaryId},${amount},${currency},100,${fx}),
                (${randomUUID()},${org.orgId},${entry},2,${org.accounts.adjustment},${org.subsidiaryId},${"-" + amount},${currency},-100,${fx})`);
              await tx.execute(
                sql`update journal_entries set status='posted',posted_by=${actor} where org_id=${org.orgId} and id=${entry}`,
              );
            });
            if (variant === "primary-usd") primaryLine = line;
          }
          // Legacy differently-denominated rows must not be offered after a
          // reconcilable account's explicit statement currency is configured.
          await db.execute(
            sql`update accounts set currency_restriction='USD',reconcilable=true where org_id=${org.orgId} and id=${org.accounts.bank}`,
          );
        });
        // Statement import and reconciliation are the product paths: they take
        // an explicit org ctx and must work under enforcement.
        const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
        const { reconId } = await withOrgContext(org.orgId, async () => {
          await importStatement(
            {
              accountId: org.accounts.bank,
              source: "manual",
              currency: "USD",
              statementDate: org.date,
              lines: [
                {
                  postedOn: org.date,
                  amount: "100",
                  description: "Deposit",
                  bankTransactionId: "usd-deposit",
                },
              ],
            },
            ctx,
          );
          const recon = await startReconciliation(
            { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "100" },
            ctx,
          );
          return { reconId: recon.id };
        });
        const recon = { id: reconId };
        await withOrgContext(org.orgId, async () => {
          const loaded =
            page === "match"
              ? await loadMatch({ account: org.accounts.bank })
              : await loadReconciliation(org.accounts.bank, recon.id, {});
          assert.ok(loaded);
          const data = (page === "match" ? loaded.data : loaded) as {
            glRows: Array<{ id: string; amount: string }>;
            glTotal: number;
          };
          assert.equal(data.glTotal, 1);
          assert.deepEqual(
            data.glRows.map((row) => ({ id: row.id, amount: row.amount })),
            [{ id: primaryLine, amount: "100.0000" }],
          );
          assert.equal(
            ((page === "match" ? loaded.session : loaded.reconciliation) as { currency: string })
              .currency,
            "USD",
          );
          if (page === "reconcile") {
            const statement = (
              await db.execute<{ id: string }>(
                sql`select id from bank_statement_lines where org_id=${org.orgId}`,
                "objects",
              )
            )[0]!;
            await createMatch(
              {
                reconciliationId: recon.id,
                statementLineIds: [statement.id],
                journalLineIds: [primaryLine],
              },
              ctx,
            );
            const updated = await loadReconciliation(org.accounts.bank, recon.id, {});
            const matched = updated.matchedRows as Array<{
              gl_amount: string;
              stmt_amount: string;
            }>;
            assert.equal(matched[0]!.gl_amount, "100.0000");
            assert.equal(matched[0]!.stmt_amount, "100.0000");
          }
        });
      } finally {
        state.user = null;
        await dropScratchOrgReporting(org.orgId);
      }
    },
  );
}

test(
  "bank account detail and statement drawer preserve EUR amounts without secondary-book duplication",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actor = await withBypassContext(() =>
        createScratchUser(org.orgId, "EUR bank operator", "admin"),
      );
      await withBypassContext(() =>
        db.execute(
          sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`,
        ),
      );
      state.user = {
        id: actor,
        orgId: org.orgId,
        isSuperAdmin: false,
        name: "EUR bank operator",
        email: "eur-bank@scratch.test",
        roles: [],
        envKind: "production",
        productionOrgId: org.orgId,
        homeOrgId: org.orgId,
        homeUserId: actor,
      };
      const secondary = randomUUID();
      await withBypassContext(async () => {
        await db.execute(
          sql`insert into accounting_books(id,org_id,code,name,is_primary) values(${secondary},${org.orgId},'ALT','Alternate',false)`,
        );
        for (const [book, currency, amount, txnAmount, rate, name] of [
          [org.bookId, "EUR", "630", "525", "1.2", "EUR-PRIMARY"],
          [secondary, "EUR", "1260", "525", "2.4", "EUR-SECONDARY"],
          [org.bookId, "CAD", "100", "100", "1", "CAD-LEGACY"],
        ] as const) {
          const entry = randomUUID();
          await db.transaction(async (tx) => {
            await tx.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
            values(${entry},${org.orgId},${book},${org.subsidiaryId},${name},${org.date},${org.periodId},'draft','manual')`);
            await tx.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
            values(${randomUUID()},${org.orgId},${entry},1,${org.accounts.bank},${org.subsidiaryId},${amount},${currency},${txnAmount},${rate}),
                  (${randomUUID()},${org.orgId},${entry},2,${org.accounts.adjustment},${org.subsidiaryId},${"-" + amount},${currency},${"-" + txnAmount},${rate})`);
            await tx.execute(
              sql`update journal_entries set status='posted',posted_by=${actor} where org_id=${org.orgId} and id=${entry}`,
            );
          });
        }
        await db.execute(
          sql`update accounts set currency_restriction='EUR',reconcilable=true where org_id=${org.orgId} and id=${org.accounts.bank}`,
        );
      });
      const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
      const statement = await withOrgContext(org.orgId, () =>
        importStatement(
          {
            accountId: org.accounts.bank,
            source: "manual",
            currency: "EUR",
            statementDate: org.date,
            openingBalance: "0",
            closingBalance: "525",
            lines: [
              {
                postedOn: org.date,
                amount: "525",
                description: "Constructed EUR deposit",
                bankTransactionId: "eur-deposit",
              },
            ],
          },
          ctx,
        ),
      );
      const statementId = (
        await withBypassContext(() =>
          db.execute<{ id: string }>(
            sql`
      select id from bank_statements where org_id=${org.orgId} and account_id=${org.accounts.bank}
    `,
            "objects",
          ),
        )
      )[0]!.id;
      assert.equal(statement.imported, 1);
      await withOrgContext(org.orgId, async () => {
        await startReconciliation(
          { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "525" },
          ctx,
        );
        const data = await loadBankingAccount(org.accounts.bank, { statement: statementId });
        assert.equal(
          data.glBalance,
          "525.0000",
          "only primary EUR transaction amounts enter the balance",
        );
        assert.equal(data.accountCurrency, "EUR");
        assert.equal(data.glBalanceDisplay, "€525.00");
        assert.equal(data.statementRows[0]!.openingBalance, "€0.00");
        assert.equal(data.statementRows[0]!.closingBalance, "€525.00");
        assert.equal(data.reconRows[0]!.statementBalance, "€525.00");
        assert.equal(data.drawer!.statement.currency, "EUR");
        const drawer = await StatementDrawer(data.drawer!);
        const renderedText = (node: React.ReactNode): string => {
          if (typeof node === "string" || typeof node === "number") return String(node);
          if (Array.isArray(node)) return node.map(renderedText).join(" ");
          if (React.isValidElement<{ children?: React.ReactNode }>(node))
            return renderedText(node.props.children);
          return "";
        };
        assert.ok(
          renderedText(drawer).includes("€525.00"),
          "the real drawer formats retained EUR line amounts",
        );
      });
    } finally {
      state.user = null;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
