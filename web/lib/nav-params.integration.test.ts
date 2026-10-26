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
Object.assign(globalThis, { __navParamsState: state, React });
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
            `export * from ${JSON.stringify(root + "web/lib/auth.ts")};export async function currentUser(){return globalThis.__navParamsState.user;}`,
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
  await import("@openbooks/engine/testing/fixtures");
// The loaders, not rendered trees: the toggle hrefs, the Back href and the
// drawer-opener href are loader-resolved strings, so the loader output is
// the thing under test (same rationale as banking-source-evidence-pages).
const { loadPartners } = await import(root + "web/app/(app)/reports/partners/view.ts");
const { loadStatement } = await import(root + "web/app/(app)/reports/statements/[partyId]/view.ts");
const { loadStatementPicker } = await import(root + "web/app/(app)/reports/statements/view.ts");
const { postDocument } =
  (await import("@openbooks/engine/documents")) as typeof import("@openbooks/engine/documents");
const { loadBankingAccount } = await import(root + "web/app/(app)/banking/[accountId]/view.ts");

function hrefParams(href: string): URLSearchParams {
  const query = href.slice(href.indexOf("?") + 1);
  assert.ok(href.includes("?"), `expected a query string in ${JSON.stringify(href)}`);
  return new URLSearchParams(query);
}

async function seedNavParamsOrg(): Promise<{
  org: ScratchOrg;
  actor: string;
  statementId: string;
}> {
  const org: ScratchOrg = await withBypassContext(() => createScratchOrg() as Promise<ScratchOrg>);
  const seeded = await withBypassContext(async () => {
    const actor = await createScratchUser(org.orgId, "Nav operator", "admin");
    await db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`,
    );
    await db.execute(
      sql`update accounts set currency_restriction='USD',reconcilable=true where org_id=${org.orgId} and id=${org.accounts.bank}`,
    );
    // One imported statement so the drawer-opener row exists. The source is
    // deliberately fictitious: the loader must treat it as opaque tenant
    // data, so the test proves the wiring without naming a real vendor.
    const statementId = randomUUID();
    await db.execute(sql`insert into bank_statements(id,org_id,account_id,source,statement_date,opening_balance,closing_balance,raw_file_ref,created_by)
      values(${statementId},${org.orgId},${org.accounts.bank},'test-source',${org.date},'0.0000','100.0000','test-seed',${actor})`);
    return { actor, statementId };
  });
  state.user = {
    id: seeded.actor,
    orgId: org.orgId,
    isSuperAdmin: false,
    name: "Nav operator",
    email: "nav@scratch.test",
    roles: [],
    envKind: "production",
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: seeded.actor,
  };
  return { org, ...seeded };
}

// F1T-5: the payables/receivables toggle rebuilt its href from kind+book
// only, so switching sides dropped the search term and reset the pager.
test(
  "partners kind toggle keeps the search term and page",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org } = await seedNavParamsOrg();
    try {
      const data = (await withOrgContext(org.orgId, () =>
        loadPartners({ kind: "payable", book: org.bookId, q: "acme", page: "3" }),
      )) as {
        payableHref: string;
        receivableHref: string;
      };
      assert.equal(data.payableHref.slice(0, data.payableHref.indexOf("?")), "/reports/partners");
      const toggled = hrefParams(data.receivableHref);
      assert.equal(toggled.get("kind"), "receivable");
      assert.equal(toggled.get("book"), org.bookId);
      assert.equal(toggled.get("q"), "acme");
      assert.equal(toggled.get("page"), "3");
      const stayed = hrefParams(data.payableHref);
      assert.equal(stayed.get("kind"), "payable");
      assert.equal(stayed.get("q"), "acme");
      assert.equal(stayed.get("page"), "3");
    } finally {
      state.user = null;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

// F1T-6: the party statement Back link pointed at bare /reports/registers,
// so returning from an A/P statement landed on the A/R register.
test("party statement Back carries its side", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedNavParamsOrg();
  try {
    const ap = (await withOrgContext(org.orgId, () =>
      loadStatement(org.customerId, { side: "ap", book: org.bookId }),
    )) as {
      backHref: string;
      backLabel: string;
    };
    assert.equal(ap.backHref, "/reports/registers?side=ap");
    assert.equal(ap.backLabel, "registers.apTitle");
    const ar = (await withOrgContext(org.orgId, () =>
      loadStatement(org.customerId, { book: org.bookId }),
    )) as {
      backHref: string;
      backLabel: string;
    };
    assert.equal(ar.backHref, "/reports/registers?side=ar");
    assert.equal(ar.backLabel, "registers.arTitle");
  } finally {
    state.user = null;
    await dropScratchOrgReporting(org.orgId);
  }
});

// F1T-12: the statement drawer OPENER rebuilt its href from the statement
// id only (closeHref keeps everything via mergeHref), so closing the drawer
// landed on an unfiltered page 1.
test(
  "statement drawer opener keeps list search, sort and page",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, statementId } = await seedNavParamsOrg();
    try {
      const data = (await withOrgContext(org.orgId, () =>
        loadBankingAccount(org.accounts.bank, {
          stmtQ: "test-source",
          stmtSort: "source",
          stmtDir: "asc",
          stmtPage: "1",
          reconPage: "2",
        }),
      )) as {
        statementRows: Array<{ id: string; dateHref: string }>;
      };
      const row = data.statementRows.find((r) => r.id === statementId);
      assert.ok(row, "seeded statement row is listed");
      const params = hrefParams(row.dateHref);
      assert.equal(
        row.dateHref.slice(0, row.dateHref.indexOf("?")),
        `/banking/${org.accounts.bank}`,
      );
      assert.equal(params.get("statement"), statementId);
      assert.equal(params.get("stmtQ"), "test-source");
      assert.equal(params.get("stmtSort"), "source");
      assert.equal(params.get("stmtPage"), "1");
      assert.equal(params.get("reconPage"), "2");
    } finally {
      state.user = null;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

// The hub's Customer statements entry opens a picker, not a statement: each
// row must open that customer's statement for the picker's period, so the
// loader carries the picker's From/To into every row href.
test(
  "statement picker rows open that customer statement for the period",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, actor } = await seedNavParamsOrg();
    try {
      const invoiceId = randomUUID();
      await withBypassContext(async () => {
        const calendarId = (
          await db.execute(
            sql`select id from fiscal_calendars where org_id = ${org.orgId} limit 1`,
            "objects",
          )
        )[0]!.id as string;
        await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${randomUUID()}, ${org.orgId}, 2026, 1, '2026-01', '2026-01-01', '2026-01-31', false, ${calendarId})`);
        await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${invoiceId}, ${org.subsidiaryId}, ${org.customerId}, '2026-01-10', '2026-01-20',
          'CAD', 1, '1240.0000', 0, '1240.0000', ${actor})`);
        await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, 1, '1240.0000', '1240.0000', 0, '1240.0000')`);
        await db.execute(
          sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${invoiceId}`,
        );
        await postDocument(invoiceId, {
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        });
      });
      const data = (await withOrgContext(org.orgId, () =>
        loadStatementPicker({ book: org.bookId, from: "2026-01-01", to: "2026-01-31" }),
      )) as {
        rows: Array<{ rowKey: string; href: string }>;
      };
      const row = data.rows.find((r) => r.rowKey === org.customerId);
      assert.ok(row, "the invoiced customer is listed in the picker");
      assert.equal(
        row.href.slice(0, row.href.indexOf("?")),
        `/reports/statements/${org.customerId}`,
      );
      const params = hrefParams(row.href);
      assert.equal(params.get("period"), "custom");
      assert.equal(params.get("from"), "2026-01-01");
      assert.equal(params.get("to"), "2026-01-31");
    } finally {
      state.user = null;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
