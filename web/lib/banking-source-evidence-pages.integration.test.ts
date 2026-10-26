import { installEngineSeams } from "@openbooks/engine/composition/install";
installEngineSeams();
import { registerHooks } from "node:module";
import { resolveAppModule } from "./test-module-hooks";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import * as React from "react";
import { stubModules } from "../testing/stub-modules.ts";
import type { ScratchOrg } from "@openbooks/engine/testing/fixtures";
const repo = process.cwd();
const root = pathToFileURL(repo + "/").href;
const state: { user: import("./auth").SessionUser | null } = { user: null };
Object.assign(globalThis, { __bankingPagesState: state, React });
stubModules({
  navigation: false,
  intl: 'export async function getTranslations(){const t=(k,p)=>p===undefined?k:`${k} ${JSON.stringify(p)}`;t.has=()=>false;t.rich=(k)=>k;return t;};export async function getLocale(){return "en"}',
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

const { db, withBypassContext, withOrgContext, withOrgTransaction } =
  (await import("@openbooks/engine/platform/db")) as typeof import("@openbooks/engine/platform/db");
const { sql } = (await import(
  root + "node_modules/drizzle-orm/index.js"
)) as typeof import("drizzle-orm");
const {
  refreshSourceReconciliationState,
  signOffFromSourceEvidence,
  importStatement,
  startReconciliation,
  createMatch,
  markReconciled,
} = await import("@openbooks/engine/banking/banking");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } =
  await import("@openbooks/engine/testing/fixtures");
// The pages' LOADERS, not their rendered trees: the evidence badge and the
// workspace header are loader-resolved strings, so the loader output is the
// thing under test (same rationale as banking-book-pages).
const { loadBankingAccount } = await import(root + "web/app/(app)/banking/[accountId]/view.ts");
const { loadReconciliation } = await import(
  root + "web/app/(app)/banking/[accountId]/reconcile/[reconciliationId]/view.ts"
);

function splitKey(rendered: string): { key: string; params: Record<string, unknown> } {
  const at = rendered.indexOf(" ");
  assert.ok(at > 0, `expected a key+params rendering, got ${JSON.stringify(rendered)}`);
  return {
    key: rendered.slice(0, at),
    params: JSON.parse(rendered.slice(at + 1)) as Record<string, unknown>,
  };
}

// The connector code and display name are deliberately fictitious: the
// loaders must treat the evidence connector as opaque tenant data, so the
// test proves the wiring without naming any real vendor (the neutrality
// gate forbids vendor names outside connector scope).
const CONNECTOR_SOURCE = "test-source";
const CONNECTOR_NAME = "Test Source";

async function seedSourceEvidenceOrg() {
  const org: ScratchOrg = await withBypassContext(() => createScratchOrg() as Promise<ScratchOrg>);
  const seeded = await withBypassContext(async () => {
    const actor = await createScratchUser(org.orgId, "Bank operator", "admin");
    await db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`,
    );
    await db.execute(
      sql`update accounts set currency_restriction='USD',reconcilable=true where org_id=${org.orgId} and id=${org.accounts.bank}`,
    );
    await db.execute(sql`insert into connections(org_id,source,display_name,mirror_enabled)
      values(${org.orgId},${CONNECTOR_SOURCE},${CONNECTOR_NAME},true)`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"banking":true}'::jsonb) where id=${org.orgId}`);
    return { actor };
  });
  const ctx = { orgId: org.orgId, userId: seeded.actor, allowedSubsidiaryIds: null };
  const deposit = (amount: string, date: string, connector: string | null) =>
    withOrgTransaction(org.orgId, async () => {
      const entry = randomUUID(),
        bankLine = randomUUID();
      await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
      values(${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${entry},${date},${org.periodId},'draft','manual')`);
      await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,source_cleared_date,source_cleared_connector)
      values(${bankLine},${org.orgId},${entry},1,${org.accounts.bank},${org.subsidiaryId},${amount},'USD',${amount},1,${connector ? date : null},${connector}),
        (${randomUUID()},${org.orgId},${entry},2,${org.accounts.adjustment},${org.subsidiaryId},${"-" + amount},'USD',${"-" + amount},1,null,null)`);
      await db.execute(
        sql`update journal_entries set status='posted',posted_by=${seeded.actor} where org_id=${org.orgId} and id=${entry}`,
      );
      return bankLine;
    });
  const sourceSignOff = (connector: string) =>
    withOrgTransaction(org.orgId, async () => {
      await refreshSourceReconciliationState(org.orgId, connector);
      const signed = await signOffFromSourceEvidence({ accountId: org.accounts.bank }, ctx);
      assert.equal(signed.signed, true);
      if (!signed.signed) throw new Error("Source evidence must cover the complete cutoff.");
      return signed.reconciliationId;
    });
  await deposit("100", "2026-07-13", CONNECTOR_SOURCE);
  const sourceRecon = await sourceSignOff(CONNECTOR_SOURCE);
  const bankLine = await deposit("50", "2026-07-14", null);
  const statementRecon = await withOrgTransaction(org.orgId, async () => {
    await importStatement(
      {
        accountId: org.accounts.bank,
        source: "manual",
        currency: "USD",
        statementDate: "2026-07-14",
        openingBalance: "100",
        closingBalance: "150",
        lines: [
          {
            postedOn: "2026-07-14",
            amount: "50",
            description: "Bank deposit",
            bankTransactionId: "statement-deposit",
          },
        ],
      },
      ctx,
    );
    const statementLine = (
      await db.execute<{ id: string }>(
        sql`select id from bank_statement_lines
      where org_id=${org.orgId} and account_id=${org.accounts.bank} and bank_transaction_id='statement-deposit'`,
        "objects",
      )
    )[0]!;
    const reconciliation = await startReconciliation(
      { accountId: org.accounts.bank, throughDate: "2026-07-14", statementBalance: "150" },
      ctx,
    );
    await createMatch(
      {
        reconciliationId: reconciliation.id,
        statementLineIds: [statementLine.id],
        journalLineIds: [bankLine],
      },
      ctx,
    );
    assert.equal((await markReconciled(reconciliation.id, ctx)).status, "signed_off");
    return reconciliation.id;
  });
  await deposit("1", "2026-07-15", "lone-source");
  const orphanRecon = await sourceSignOff("lone-source");
  state.user = {
    id: seeded.actor,
    orgId: org.orgId,
    isSuperAdmin: false,
    name: "Bank operator",
    email: "bank@scratch.test",
    roles: [],
    envKind: "production",
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: seeded.actor,
  };
  return { org, ...seeded, sourceRecon, statementRecon, orphanRecon };
}

test(
  "source-evidenced sign-off renders reconciled-from-connector with counts",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, sourceRecon } = await seedSourceEvidenceOrg();
    try {
      const loaded = await withOrgContext(org.orgId, async () =>
        loadReconciliation(org.accounts.bank, sourceRecon, {}),
      );
      const { key, params } = splitKey(loaded.headerDescription);
      assert.equal(key, "reconcile.sourceSignedOffByDescription");
      assert.equal(params.connector, CONNECTOR_NAME);
      assert.equal(params.date, "2026-07-13");
      assert.equal(params.name, "Bank operator");
      assert.equal(params.cleared, 1);
      assert.equal(params.uncleared, 0);
    } finally {
      state.user = null;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "source evidence without a matching connection falls back to source system",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, orphanRecon } = await seedSourceEvidenceOrg();
    try {
      const loaded = await withOrgContext(org.orgId, async () =>
        loadReconciliation(org.accounts.bank, orphanRecon, {}),
      );
      const { key, params } = splitKey(loaded.headerDescription);
      assert.equal(key, "reconcile.sourceSignedOffByDescription");
      assert.equal(params.connector, "sourceSystem.other");
    } finally {
      state.user = null;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "statement sign-off keeps the statement header",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, statementRecon } = await seedSourceEvidenceOrg();
    try {
      const loaded = await withOrgContext(org.orgId, async () =>
        loadReconciliation(org.accounts.bank, statementRecon, {}),
      );
      const { key } = splitKey(loaded.headerDescription);
      assert.equal(key, "reconcile.signedOffByDescription");
    } finally {
      state.user = null;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "account reconciliation rows badge statement vs source evidence",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, sourceRecon, statementRecon, orphanRecon } = await seedSourceEvidenceOrg();
    try {
      const statementId = randomUUID();
      await withBypassContext(() =>
        db.execute(
          sql`insert into bank_statements(id,org_id,account_id,source,statement_date,raw_file_ref) values(${statementId},${org.orgId},${org.accounts.bank},'manual',${org.date},'test-fixture:source-not-retained')`,
        ),
      );
      const data: import("../app/(app)/banking/[accountId]/view.ts").BankingAccountData =
        await withOrgContext(org.orgId, async () =>
          loadBankingAccount(org.accounts.bank, { statement: statementId }),
        );
      assert.deepEqual(
        [
          data.columnEvidence,
          data.sourceOptions.find((option) => option.value === "manual")?.label,
          data.statementRows[0]?.sourceLabel,
          data.drawer?.statement.source,
        ],
        [
          "account.columns.evidence",
          "statementSources.manual",
          "statementSources.manual",
          "statementSources.manual",
        ],
      );
      const byId = new Map(data.reconRows.map((row) => [row.id, row]));
      const source = byId.get(sourceRecon);
      assert.ok(source, "source-evidenced reconciliation row is listed");
      const { key: sourceKey, params: sourceParams } = splitKey(source.evidenceLabel);
      assert.equal(sourceKey, "evidenceKind.sourceFrom");
      assert.equal(sourceParams.connector, CONNECTOR_NAME);
      assert.equal(source.evidenceVariant, "secondary");
      const statement = byId.get(statementRecon);
      assert.ok(statement, "statement reconciliation row is listed");
      assert.equal(statement.evidenceLabel, "evidenceKind.statement");
      assert.equal(statement.evidenceVariant, "outline");
      const orphan = byId.get(orphanRecon);
      assert.ok(orphan, "unmatched-connector reconciliation row is listed");
      const { key: orphanKey, params: orphanParams } = splitKey(orphan.evidenceLabel);
      assert.equal(orphanKey, "evidenceKind.sourceFrom");
      assert.equal(orphanParams.connector, "sourceSystem.other");
    } finally {
      state.user = null;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "account balance nets a reversed entry with its posted mirror",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, actor } = await seedSourceEvidenceOrg();
    try {
      await withBypassContext(async () => {
        const original = randomUUID();
        const mirror = randomUUID();
        for (const [id, number] of [
          [original, "reversal-original"],
          [mirror, "reversal-mirror"],
        ] as const) {
          await db.execute(sql`insert into journal_entries
          (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,created_by,updated_by)
          values(${id},${org.orgId},${org.bookId},${org.subsidiaryId},${number},${org.date},${org.periodId},'draft','manual',${actor},${actor})`);
        }
        await db.execute(sql`update journal_entries set reverses_entry_id=${original}
        where org_id=${org.orgId} and id=${mirror}`);
        await db.execute(sql`insert into journal_lines
        (id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
        values(${randomUUID()},${org.orgId},${original},1,${org.accounts.bank},${org.subsidiaryId},200,'USD',200,1),
          (${randomUUID()},${org.orgId},${original},2,${org.accounts.adjustment},${org.subsidiaryId},-200,'USD',-200,1),
          (${randomUUID()},${org.orgId},${mirror},1,${org.accounts.bank},${org.subsidiaryId},-200,'USD',-200,1),
          (${randomUUID()},${org.orgId},${mirror},2,${org.accounts.adjustment},${org.subsidiaryId},200,'USD',200,1)`);
        await db.execute(sql`update journal_entries set status='posted',posted_by=${actor}
        where org_id=${org.orgId} and id in (${original},${mirror})`);
        await db.execute(sql`update journal_entries set status='reversed'
        where org_id=${org.orgId} and id=${original}`);
      });

      const account = await withOrgContext(org.orgId, async () =>
        loadBankingAccount(org.accounts.bank, {}),
      );
      assert.equal(
        account.glBalance,
        "151.0000",
        "both the reversed original and its posted mirror net to zero",
      );
    } finally {
      state.user = null;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
