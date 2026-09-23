#!/usr/bin/env -S npx tsx
/**
 * Perf upgrade-rehearsal seeder (dataset class `perf-1m`).
 *
 * OWNERSHIP: candidate-owned (scripts/upgrade-rehearsal/seeders/) but RUNS
 * INSIDE THE SOURCE TREE at engine/src/upgrade-rehearsal-seed/perf-1m.ts via
 * the source release's runtime. Relative imports resolve from THERE; every
 * module imported must exist in BOTH v0.1.0-alpha.22 and v0.1.0-alpha.23.
 * A startup assertion fails closed if any bulk-path column ever drifts.
 *
 * What it builds, deterministically from `--seed`, in ONE sim-tagged USD org:
 *   - ~1,020,000 journal_lines over 36 months (2023-07..2026-06): ~3,000
 *     invoices and ~2,300 bills a month (4 and 3 lines), ~88% of customer
 *     and ~90% of vendor documents paid in full through applications,
 *     monthly payroll journals. All through the kernel-compliant bulk path
 *     (draft entries, lines, posted header-only documents, one flip to
 *     posted, applications last) inside one transaction per month with
 *     `set constraints all deferred`. NO raw ledger inserts outside that
 *     guarded shape, and no document_lines (header-only documents are
 *     skipped by the totals tieout by design).
 *   - payroll volume for migration 0296: 24 committed monthly runs x 40
 *     stubs x 6 lines with the commit-stamp shape (liability source
 *     'commit', expense source 'component'), component-level remittance
 *     parties on the withholding/FUTA components, and stub-line
 *     remittance deliberately NULL — 0296 adds that column at upgrade and
 *     backfills it from the component snapshot. Plus exact-total coverage
 *     bills carrying payrollRemittance markers (which 0296 repairs into
 *     coverage rows) and one wrong-total bill for its notice path.
 *   - inventory volume for 0293/0299: 2,000 items, 3 locations, 200 bins,
 *     600 counts x 500 unique-subject lines (300,000 stock_count_lines, all
 *     counted quantities non-negative).
 *   - realistic small volumes for every other pending migration that
 *     rewrites or validates a table (0251 payment_links, 0258
 *     subscriptions/recurring_schedules, 0265 tax_filings, 0294 dunning_log,
 *     0295 qbd_requests, 0298 item_rate_lines, 0301 item_price_schedules,
 *     0248/0250 pay components, recognition_rules). Tables deliberately left
 *     without volume are listed in UPGRADE-DONE with reasons.
 *
 * Prints `{"orgIds":[...]}` as its last JSON line.
 */
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, schema, withBypass } from "../platform/db.ts";
import { Rng } from "../sim/rng.ts";
import { getProfile } from "../sim/profiles/index.ts";
import { provisionOrg } from "../sim/world.ts";

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} is required (usage: perf-1m.ts --seed <seed>)`);
  }
  return value;
}

function opt(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
}

/** Exact 2dp decimal from integer cents (no float formatting anywhere). */
function cents(c: number): string {
  const sign = c < 0 ? "-" : "";
  const a = Math.abs(Math.round(c));
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const MAX_MONTHS = 36;
const FIRST_YEAR = 2023;
const FIRST_MONTH = 7; // July 2023 .. June 2026
const INVOICES_PER_MONTH = 3000;
const BILLS_PER_MONTH = 2300;
const CUSTOMER_PAY_PCT = 88;
const VENDOR_PAY_PCT = 90;

function monthOf(index: number): { year: number; month: number; prefix: string } {
  const total = FIRST_MONTH - 1 + index;
  const year = FIRST_YEAR + Math.floor(total / 12);
  const month = (total % 12) + 1;
  return { year, month, prefix: `${year}-${pad2(month)}` };
}

async function assertBulkColumns(): Promise<void> {
  // Every (table, column) the raw-SQL sections below write or read, so a
  // source release that predates a column fails closed here with the full
  // list instead of mid-seed with the first missing one. Deliberately
  // ABSENT: pay_stub_lines.remittance_party_id (born in pending migration
  // 0296 — no source has it; the seeder never writes it) and price_levels
  // (probed dynamically; the 0301 section skips when the table is absent).
  const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
    WITH want(table_name, column_name) AS (VALUES
      ('journal_entries','book_id'),('journal_entries','subsidiary_id'),
      ('journal_entries','entry_number'),('journal_entries','posting_date'),
      ('journal_entries','period_id'),('journal_entries','status'),
      ('journal_lines','posting_date'),('journal_lines','source_cleared_date'),
      ('journal_lines','contributor_kind'),
      ('documents','posted_entry_id'),('documents','posting_period_id'),
      ('documents','open_balance'),('documents','revision_seq'),
      ('documents','party_id'),('documents','subtotal'),('documents','tax_total'),
      ('documents','total'),('documents','custom'),
      ('applications','source_amount'),('applications','settlement_rate'),
      ('parties','kind'),('parties','display_name'),('parties','is_active'),('parties','custom'),
      ('customer_roles','party_id'),('vendor_roles','party_id'),
      ('pay_schedules','name'),('pay_schedules','frequency'),('pay_schedules','periods_per_year'),
      ('pay_schedules','anchor_period_end'),
      ('pay_components','code'),('pay_components','name'),('pay_components','kind'),
      ('pay_components','remittance_party_id'),('pay_components','liability_account_id'),
      ('pay_components','expense_account_id'),
      ('employee_pay_components','employee_party_id'),('employee_pay_components','component_id'),
      ('employee_pay_components','effective_from'),
      ('pay_runs','pay_schedule_id'),('pay_runs','period_start'),('pay_runs','period_end'),
      ('pay_runs','pay_date'),('pay_runs','tax_year'),('pay_runs','run_status'),
      ('pay_stubs','pay_run_document_id'),('pay_stubs','employee_party_id'),('pay_stubs','province'),
      ('pay_stubs','periods_per_year'),('pay_stubs','pay_date'),('pay_stubs','tax_year'),
      ('pay_stubs','currency_code'),
      ('pay_stub_lines','stub_id'),('pay_stub_lines','sequence'),('pay_stub_lines','kind'),
      ('pay_stub_lines','component_id'),('pay_stub_lines','description'),('pay_stub_lines','amount'),
      ('pay_stub_lines','liability_account_id'),('pay_stub_lines','liability_account_source'),
      ('pay_stub_lines','expense_account_id'),('pay_stub_lines','expense_account_source'),
      ('pay_stub_lines','expense_account_evidence'),
      ('document_lines','document_id'),('document_lines','line_number'),('document_lines','account_id'),
      ('document_lines','description'),('document_lines','quantity'),('document_lines','unit_price'),
      ('document_lines','amount'),('document_lines','tax_amount'),
      ('locations','name'),('stock_locations','location_id'),('stock_locations','code'),('stock_locations','kind'),
      ('stock_counts','location_id'),('stock_counts','subsidiary_id'),('stock_counts','counted_on'),
      ('stock_counts','status'),
      ('stock_count_lines','expected_quantity'),
      ('items','code'),
      ('payment_links','token'),('payment_links','document_id'),('payment_links','party_id'),
      ('payment_links','subsidiary_id'),('payment_links','provider'),('payment_links','bank_account_id'),
      ('payment_links','amount'),('payment_links','currency'),
      ('recognition_rules','code'),('recognition_rules','name'),('recognition_rules','method'),
      ('subscriptions','customer_id'),('subscriptions','plan_id'),('subscriptions','start_on'),
      ('subscriptions','next_bill_on'),
      ('recurring_schedules','template_document_id'),('recurring_schedules','cadence'),
      ('recurring_schedules','next_run_on'),
      ('tax_filings','form_code'),('tax_filings','form_name'),('tax_filings','period_from'),
      ('tax_filings','period_to'),('tax_filings','version'),('tax_filings','submission_channel'),
      ('tax_filings','boxes'),('tax_filings','snapshot_hash'),
      ('dunning_log','document_id'),('dunning_log','policy_id'),('dunning_log','stage_id'),
      ('dunning_log','amount_due'),
      ('connections','source'),('connections','display_name'),
      ('qbd_captures','connection_id'),('qbd_captures','captured_through'),('qbd_captures','expires_at'),
      ('qbd_captures','status'),
      ('qbd_requests','connection_id'),('qbd_requests','capture_id'),('qbd_requests','family'),
      ('qbd_requests','request_kind'),('qbd_requests','sequence'),('qbd_requests','request_xml'),
      ('qbd_requests','status'),
      ('item_rate_books','code'),('item_rate_books','name'),('item_rate_books','currency'),
      ('item_rate_versions','rate_book_id'),('item_rate_versions','status'),
      ('item_rate_versions','effective_from'),('item_rate_versions','effective_to'),
      ('item_rate_profiles','item_id'),('item_rate_profiles','base_unit'),
      ('item_rate_lines','version_id'),('item_rate_lines','item_id'),('item_rate_lines','unit_code'),
      ('item_rate_lines','unit_name'),('item_rate_lines','base_quantity'))
    SELECT w.table_name, w.column_name FROM want w
    LEFT JOIN information_schema.columns c
      ON c.table_schema='public' AND c.table_name=w.table_name AND c.column_name=w.column_name
    WHERE c.column_name IS NULL
    UNION ALL
    -- Version-dependent columns: required only when the table exists on the
    -- source. item_price_schedules is born in 0244 (both sources are older),
    -- so the 0301 section skips there by construction.
    SELECT o.table_name, o.column_name FROM (VALUES
      ('item_price_schedules','item_id'),('item_price_schedules','currency'),
      ('item_price_schedules','effective_from'),('item_price_schedules','price_level_id')
    ) AS o(table_name, column_name)
    JOIN information_schema.tables t
      ON t.table_schema='public' AND t.table_name=o.table_name
    LEFT JOIN information_schema.columns c
      ON c.table_schema='public' AND c.table_name=o.table_name AND c.column_name=o.column_name
    WHERE c.column_name IS NULL`);
  if (rows.rows.length > 0) {
    throw new Error(
      `perf-1m seeder: bulk-path columns missing (schema drift): ${JSON.stringify(rows.rows)}`);
  }
}

interface BulkLine {
  id: string;
  entryId: string;
  lineNumber: number;
  accountId: string;
  partyId: string | null;
  amount: string;
  openItem: boolean;
  memo: string;
}

async function main(): Promise<void> {
  const seed = arg("seed");
  const log = (message: string): void => {
    console.log(`[perf-1m] ${message}`);
  };
  const started = Date.now();

  const months = Math.min(MAX_MONTHS, Math.max(1, Number(opt("months", String(MAX_MONTHS)))));
  if (!Number.isInteger(months)) {
    throw new Error("--months must be an integer between 1 and 36 (default 36)");
  }
  const endYear = FIRST_YEAR + Math.floor((FIRST_MONTH - 1 + months - 1) / 12);
  const endMon = ((FIRST_MONTH - 1 + months - 1) % 12) + 1;
  const endDay = new Date(Date.UTC(endYear, endMon, 0)).getUTCDate();
  const endDate = `${endYear}-${String(endMon).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
  const world = await provisionOrg(getProfile("general-business"), {
    startDate: "2023-07-01",
    endDate,
  });
  const orgId = world.orgId;
  const admin = world.actors.admin;
  if (world.periods.length !== months) {
    throw new Error(`perf-1m seeder: expected ${months} periods, got ${world.periods.length}`);
  }
  log(`provisioned org ${orgId} (${((Date.now() - started) / 1000).toFixed(1)}s)`);

  await withBypass(assertBulkColumns);
  log("bulk-path columns asserted");

  // -- Extra master data ------------------------------------------------------
  const extra = await withBypass(async () => {
    const customerIds: string[] = world.customers.map((c) => c.id);
    const vendorIds: string[] = world.vendors.map((v) => v.id);
    for (let i = 0; i < 60; i++) {
      const id = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${id}, ${orgId}, 'customer', ${`Perf Customer ${i + 1}`}, true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into customer_roles (id, org_id, party_id) values (${randomUUID()}, ${orgId}, ${id})`);
      customerIds.push(id);
    }
    for (let i = 0; i < 40; i++) {
      const id = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${id}, ${orgId}, 'vendor', ${`Perf Vendor ${i + 1}`}, true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into vendor_roles (id, org_id, party_id) values (${randomUUID()}, ${orgId}, ${id})`);
      vendorIds.push(id);
    }
    const employeeIds: string[] = [];
    for (let i = 0; i < 40; i++) {
      const id = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${id}, ${orgId}, 'employee', ${`Perf Employee ${i + 1}`}, true, '{}'::jsonb)`);
      employeeIds.push(id);
    }
    // Monthly pay schedule + remittance-capable components (for 0296).
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
      values (${scheduleId}, ${orgId}, 'Perf Monthly', 'monthly', 12, '2023-07-31')`);
    const remittanceVendors = [vendorIds[0]!, vendorIds[1]!];
    const componentIds: { id: string; name: string; remittance: boolean; vendor: string | null }[] = [];
    const defs: [string, string, string, boolean][] = [
      ["SALARY", "Base salary", "earning", false],
      ["BONUS", "Performance bonus", "earning", false],
      ["FEDTAX", "Federal withholding", "deduction", true],
      ["STATETAX", "State withholding", "deduction", true],
      ["BENEFIT", "Benefits contribution", "deduction", false],
      ["GARNISH", "Garnishment", "deduction", true],
      ["MATCH401K", "401k employer match", "employer_contribution", false],
      ["FUTA", "FUTA employer share", "employer_contribution", true],
    ];
    for (const [code, name, kind, remit] of defs) {
      const id = randomUUID();
      const vendor = remit ? remittanceVendors[componentIds.length % 2]! : null;
      await db.execute(sql`
        insert into pay_components (id, org_id, code, name, kind, remittance_party_id, liability_account_id,
                                    expense_account_id)
        values (${id}, ${orgId}, ${code}, ${name}, ${kind},
                ${vendor},
                ${remit ? world.accounts.laborClearing! : null},
                ${world.accounts.payroll!})`);
      componentIds.push({ id, name, remittance: remit, vendor });
    }
    for (const emp of employeeIds) {
      await db.execute(sql`
        insert into employee_pay_components (id, org_id, employee_party_id, component_id, effective_from)
        values (${randomUUID()}, ${orgId}, ${emp}, ${componentIds[0]!.id}, '2023-07-01')`);
    }
    const books = await db.execute<{ id: string }>(sql`
      select id from accounting_books where org_id = ${orgId} and is_active order by created_at limit 1`);
    const bookId = books.rows[0]?.id ?? world.bookId;
    return { customerIds, vendorIds, employeeIds, scheduleId, componentIds, remittanceVendors, bookId };
  });
  log(`masters ready (${extra.customerIds.length} customers, ${extra.vendorIds.length} vendors, 40 employees)`);

  const rng = Rng.fromSeed(seed);
  let totalLines = 0;

  // -- Monthly bulk: the kernel-compliant fast path --------------------------------
  for (let m = 0; m < months; m++) {
    const monthStarted = Date.now();
    const { prefix } = monthOf(m);
    const periodId = world.periods[m]!.id;
    const monthRng = rng.stream(`m-${prefix}`);
    const pickCustomer = (i: number): string => extra.customerIds[(i * 7 + m * 13) % extra.customerIds.length]!;
    const pickVendor = (i: number): string => extra.vendorIds[(i * 11 + m * 5) % extra.vendorIds.length]!;

    interface Doc {
      id: string;
      kind: string;
      number: string;
      partyId: string;
      date: string;
      total: string;
      entryId: string;
      arLineId: string;
    }
    const entries: { id: string; number: string; date: string; origin: "document" | "manual" }[] = [];
    const lines: BulkLine[] = [];
    const docs: Doc[] = [];
    const apps: {
      id: string; from: string; to: string; amount: string; date: string;
    }[] = [];

    const addEntry = (tag: string, seq: number, date: string, origin: "document" | "manual"): string => {
      const id = randomUUID();
      entries.push({ id, number: `P1M-E-${prefix}-${tag}-${String(seq).padStart(5, "0")}`, date, origin });
      return id;
    };
    const addLine = (
      entryId: string, lineNumber: number, accountId: string, partyId: string | null,
      amount: string, openItem: boolean, memo: string,
    ): string => {
      const id = randomUUID();
      lines.push({ id, entryId, lineNumber, accountId, partyId, amount, openItem, memo });
      return id;
    };
    // Split total cents into three non-negative parts that sum exactly.
    const split3 = (totalCents: number, p1: number, p2: number): [string, string, string] => {
      const a = Math.round(totalCents * p1);
      const b = Math.round(totalCents * p2);
      return [cents(a), cents(b), cents(totalCents - a - b)];
    };

    // Invoices: AR + three revenue splits (all-or-nothing paid at 88%).
    for (let i = 0; i < INVOICES_PER_MONTH; i++) {
      const day = 1 + Math.floor(monthRng.next() * 28);
      const date = `${prefix}-${pad2(day)}`;
      const totalCents = 20000 + Math.floor(Math.pow(monthRng.next(), 2) * 2980000);
      const [r1, r2, r3] = split3(totalCents, 0.5, 0.3);
      const total = cents(totalCents);
      const partyId = pickCustomer(i);
      const entryId = addEntry("I", i, date, "document");
      const arLineId = addLine(entryId, 1, world.accounts.ar!, partyId, total, true, "receivable");
      addLine(entryId, 2, world.accounts.revenueProduct!, null, `-${r1}`, false, "product");
      addLine(entryId, 3, world.accounts.revenueService!, null, `-${r2}`, false, "service");
      addLine(entryId, 4, world.accounts.revenueConsulting!, null, `-${r3}`, false, "consulting");
      const docId = randomUUID();
      docs.push({
        id: docId, kind: "customer_invoice", number: `P1M-I-${prefix}-${String(i).padStart(5, "0")}`,
        partyId, date, total, entryId, arLineId,
      });
      if (i % 100 < CUSTOMER_PAY_PCT) {
        const payDay = Math.min(28, day + 3 + Math.floor(monthRng.next() * 12));
        const payDate = `${prefix}-${pad2(payDay)}`;
        const payEntryId = addEntry("R", i, payDate, "document");
        const payLineId = addLine(payEntryId, 1, world.accounts.ar!, partyId, `-${total}`, true, "receipt");
        addLine(payEntryId, 2, world.accounts.bank!, null, total, false, "bank");
        const payDocId = randomUUID();
        docs.push({
          id: payDocId, kind: "customer_payment", number: `P1M-R-${prefix}-${String(i).padStart(5, "0")}`,
          partyId, date: payDate, total, entryId: payEntryId, arLineId: payLineId,
        });
        apps.push({ id: randomUUID(), from: payLineId, to: arLineId, amount: total, date: payDate });
      }
    }
    // Bills: AP + two expense splits (90% paid).
    for (let i = 0; i < BILLS_PER_MONTH; i++) {
      const day = 1 + Math.floor(monthRng.next() * 28);
      const date = `${prefix}-${pad2(day)}`;
      const totalCents = 10000 + Math.floor(Math.pow(monthRng.next(), 2) * 1990000);
      const [e1, e2] = [cents(Math.round(totalCents * 0.6)), cents(totalCents - Math.round(totalCents * 0.6))];
      const total = cents(totalCents);
      const partyId = pickVendor(i);
      const entryId = addEntry("B", i, date, "document");
      const apLineId = addLine(entryId, 1, world.accounts.ap!, partyId, `-${total}`, true, "payable");
      addLine(entryId, 2, world.accounts.materials!, null, e1, false, "materials");
      addLine(entryId, 3, i % 2 === 0 ? world.accounts.office! : world.accounts.professionalFees!, null, e2, false, "expense");
      const docId = randomUUID();
      docs.push({
        id: docId, kind: "vendor_bill", number: `P1M-B-${prefix}-${String(i).padStart(5, "0")}`,
        partyId, date, total, entryId, arLineId: apLineId,
      });
      if (i % 100 < VENDOR_PAY_PCT) {
        const payDay = Math.min(28, day + 3 + Math.floor(monthRng.next() * 12));
        const payDate = `${prefix}-${pad2(payDay)}`;
        const payEntryId = addEntry("P", i, payDate, "document");
        const payLineId = addLine(payEntryId, 1, world.accounts.ap!, partyId, total, true, "payment");
        addLine(payEntryId, 2, world.accounts.bank!, null, `-${total}`, false, "bank");
        const payDocId = randomUUID();
        docs.push({
          id: payDocId, kind: "vendor_payment", number: `P1M-P-${prefix}-${String(i).padStart(5, "0")}`,
          partyId, date: payDate, total, entryId: payEntryId, arLineId: payLineId,
        });
        apps.push({ id: randomUUID(), from: payLineId, to: apLineId, amount: total, date: payDate });
      }
    }
    // Monthly payroll journal (plain entry, no document): 6 lines.
    {
      const drift = 0.95 + monthRng.next() * 0.1;
      const wages = Math.round(180000 * drift);
      const benefits = Math.round(36000 * drift);
      const tax = Math.round(16500 * drift);
      const bank = Math.round(170000 * drift);
      const entryId = addEntry("W", 0, `${prefix}-28`, "manual");
      addLine(entryId, 1, world.accounts.payroll!, null, cents(wages), false, "wages");
      addLine(entryId, 2, world.accounts.benefits!, null, cents(benefits), false, "benefits");
      addLine(entryId, 3, world.accounts.payrollTaxExpense!, null, cents(tax), false, "payroll tax");
      addLine(entryId, 4, world.accounts.bank!, null, cents(-bank), false, "net pay");
      addLine(entryId, 5, world.accounts.laborClearing!, null, cents(-(wages + benefits + tax - bank)), false, "accrual");
    }

    // One transaction per month on a single pooled client (drizzle pins the
    // client for the whole callback; raw begin/commit would scatter across
    // the pool). Deferred constraints let entries, lines, documents, the
    // posted flip, and applications commit in kernel order.
    const phase = (label: string, from: number) => {
      process.stderr.write(`[perf-1m] month ${prefix} ${label}: ${((Date.now() - from) / 1000).toFixed(1)}s\n`);
    };
    let mark = Date.now();
    // withBypass (the timeout-free maintenance transaction) rather than
    // withBypassContext + request-pool db.transaction: one month fires ~85k
    // deferred per-row kernel checks at commit, far past the request pool's
    // 120s query_timeout. Same bypass semantics and the same runtime login;
    // db.transaction participates in the pinned maintenance unit.
    await withBypass(async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`set constraints all deferred`);
        for (let s = 0; s < entries.length; s += 1500) {
          await tx.insert(schema.journalEntries).values(
            entries.slice(s, s + 1500).map((e) => ({
              id: e.id,
              orgId,
              bookId: world.bookId,
              subsidiaryId: world.subsidiaryId,
              entryNumber: e.number,
              postingDate: e.date,
              periodId,
              status: "draft" as const,
              origin: e.origin,
              custom: {},
            })),
          );
        }
        for (let s = 0; s < lines.length; s += 2500) {
          await tx.insert(schema.journalLines).values(
            lines.slice(s, s + 2500).map((l) => ({
              id: l.id,
              orgId,
              entryId: l.entryId,
              lineNumber: l.lineNumber,
              accountId: l.accountId,
              subsidiaryId: world.subsidiaryId,
              partyId: l.partyId,
              amount: l.amount,
              currency: "USD",
              txnAmount: l.amount,
              fxRate: "1",
              isOpenItem: l.openItem,
              memo: l.memo,
              extraDims: {},
              custom: {},
            })),
          );
        }
        phase("entries+lines", mark); mark = Date.now();
        for (let s = 0; s < docs.length; s += 1500) {
          await tx.insert(schema.documents).values(
            docs.slice(s, s + 1500).map((d) => ({
              id: d.id,
              orgId,
              kind: d.kind,
              documentNumber: d.number,
              partyId: d.partyId,
              documentDate: d.date,
              currency: "USD",
              fxRate: "1",
              subsidiaryId: world.subsidiaryId,
              subtotal: d.total,
              taxTotal: "0",
              total: d.total,
              status: "posted" as const,
              postedEntryId: d.entryId,
              postingPeriodId: periodId,
              openBalance: d.total,
              createdBy: admin,
              custom: {},
              extraDims: {},
            })),
          );
        }
        phase("docs", mark); mark = Date.now();
        await tx.execute(sql`
          update journal_entries set status = 'posted'
           where org_id = ${orgId} and period_id = ${periodId} and status = 'draft'`);
        phase("post-flip", mark); mark = Date.now();
        for (let s = 0; s < apps.length; s += 2000) {
          await tx.insert(schema.applications).values(
            apps.slice(s, s + 2000).map((a) => ({
              id: a.id,
              orgId,
              fromLineId: a.from,
              toLineId: a.to,
              amount: a.amount,
              appliedOn: a.date,
              sourceAmount: a.amount,
              sourceTransactionAmount: a.amount,
              sourceTransactionCurrency: "USD",
              targetTransactionAmount: a.amount,
              targetTransactionCurrency: "USD",
              settlementRate: "1",
              settlementRateSource: "same_currency" as const,
              settlementRateReference: "P1M-BULK",
            })),
          );
        }
        phase("applications", mark);
      });
      phase("commit", mark);
    });
    totalLines += lines.length;
    if (m % 6 === 5 || m === months - 1) {
      log(`month ${prefix}: ${lines.length} lines (${((Date.now() - monthStarted) / 1000).toFixed(1)}s, total ${totalLines})`);
    }
  }
  log(`ledger bulk done: ${totalLines} journal_lines in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // -- Payroll runs/stubs/lines for 0296 (24 monthly runs x 40 employees) -----
  // withBypass for the same timeout reason as the month loop: ~6k stub lines
  // fire their deferred checks at this transaction's commit.
  await withBypass(async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set constraints all deferred`);
      const runRng = rng.stream("payruns");
      for (let r = 0; r < Math.min(24, months); r++) {
        const { prefix } = monthOf(r);
        const payDate = `${prefix}-28`;
        const docId = randomUUID();
        await tx.execute(sql`
          insert into documents (id, org_id, kind, document_number, document_date, currency, status)
          values (${docId}, ${orgId}, 'pay_run', ${`P1M-PR-${prefix}`}, ${payDate}, 'USD', 'draft')`);
        await tx.execute(sql`
          insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, run_status)
          values (${docId}, ${orgId}, ${extra.scheduleId}, ${`${prefix}-01`}, ${payDate}, ${payDate}, ${Number(prefix.slice(0, 4))}, 'committed')`);
        for (let e = 0; e < extra.employeeIds.length; e++) {
          const stubId = randomUUID();
          await tx.execute(sql`
            insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                                   periods_per_year, pay_date, tax_year, currency_code)
            values (${stubId}, ${orgId}, ${docId}, ${extra.employeeIds[e]!}, 'ON', 12, ${payDate},
                    ${Number(prefix.slice(0, 4))}, 'USD')`);
          const salaryCents = 550000 + e * 7500 + Math.floor(runRng.next() * 20000);
          const fedCents = Math.round(salaryCents * 0.18);
          const stateCents = Math.round(salaryCents * 0.05);
          const employerCents = Math.round(salaryCents * 0.08);
          const stubLines: [string, string, string, string][] = [
            ["earning", extra.componentIds[0]!.id, "Base salary", cents(salaryCents)],
            ["deduction", extra.componentIds[2]!.id, "Federal withholding", cents(-fedCents)],
            ["deduction", extra.componentIds[3]!.id, "State withholding", cents(-stateCents)],
            ["deduction", extra.componentIds[4]!.id, "Benefits contribution", cents(-Math.round(salaryCents * 0.04))],
            ["employer_contribution", extra.componentIds[6]!.id, "401k match", cents(employerCents)],
            ["employer_contribution", extra.componentIds[7]!.id, "FUTA share", cents(Math.round(salaryCents * 0.02))],
          ];
          let seq = 0;
          for (const [kind, compId, desc, amount] of stubLines) {
            seq += 100;
            const comp = extra.componentIds.find((c) => c.id === compId)!;
            // Kernel-shaped stamps: liability source 'commit' with the
            // clearing account and no evidence (the commit-stamp shape), and
            // expense source 'component' with the kernel's evidence wording
            // pointing at the component that names the expense account.
            // remittance_party_id is DELIBERATELY unset: the column is born
            // in pending migration 0296, so no source release has it. The
            // remittance snapshot lives on the COMPONENT (set at master
            // build); 0296 backfills exactly the deduction/contribution
            // lines of remittance-carrying components at upgrade, and lines
            // of components without remittance stay NULL through it.
            const evidence = JSON.stringify({
              reason: `no item on this line; component "${comp.name}" expense account answers`,
              reference: `pay_components:${comp.id}`,
            });
            await tx.execute(sql`
              insert into pay_stub_lines (id, org_id, stub_id, sequence, kind, component_id, description, amount,
                                          liability_account_id, liability_account_source,
                                          expense_account_id, expense_account_source, expense_account_evidence)
              values (${randomUUID()}, ${orgId}, ${stubId}, ${seq}, ${kind}, ${compId}, ${desc}, ${amount},
                      ${world.accounts.laborClearing!}, 'commit',
                      ${world.accounts.payroll!}, 'component', ${evidence}::jsonb)`);
          }
        }
      }
      // Coverage bills for 0296. The covered bill reconciles exactly: its one
      // document line (the liability account, the signed group sum) equals
      // the committed FUTA accrual group, the party equals the snapshot
      // party, and the window/subsidiary/filing all match — so 0296 writes
      // coverage rows for it. FUTA is an employer_contribution with positive
      // amounts, so the signed group sum matches a sane positive bill line.
      // The second bill carries a wrong total and exercises the named notice
      // path (no rows, fail-closed window overlap).
      const coverSpecs: { month: number; compIdx: number; exact: boolean }[] = [
        { month: 6, compIdx: 7, exact: true },
        { month: 18, compIdx: 2, exact: false },
      ];
      for (const spec of coverSpecs) {
        const { prefix } = monthOf(spec.month);
        const comp = extra.componentIds[spec.compIdx]!;
        const vendor = comp.vendor ?? extra.remittanceVendors[0]!;
        const sum = await tx.execute<{ total: string }>(sql`
          select coalesce(sum(l.amount), 0)::text as total
            from pay_stub_lines l join pay_stubs s on s.id = l.stub_id
           where l.org_id = ${orgId} and l.component_id = ${comp.id}
             and s.pay_date >= ${`${prefix}-01`} and s.pay_date < ${`${prefix}-01`}::date + interval '1 month'`);
        const signedTotal = sum.rows[0]!.total;
        const billTotal = spec.exact ? signedTotal : cents(Math.round(Number(signedTotal) * 100) + 10000);
        const billId = randomUUID();
        await tx.execute(sql`
          insert into documents (id, org_id, kind, document_number, document_date, currency,
                                 party_id, subtotal, tax_total, total, status, custom)
          values (${billId}, ${orgId}, 'vendor_bill', ${`P1M-COV-${prefix}`}, ${`${prefix}-28`}, 'USD',
                  ${vendor}, ${billTotal}, '0', ${billTotal}, 'draft',
                  ${JSON.stringify({ payrollRemittance: { from: `${prefix}-01`, to: `${prefix}-28`, partyId: vendor } })})`);
        if (spec.exact) {
          await tx.execute(sql`
            insert into document_lines (id, org_id, document_id, line_number, account_id,
                                        description, quantity, unit_price, amount, tax_amount)
            values (${randomUUID()}, ${orgId}, ${billId}, 1, ${world.accounts.laborClearing!},
                    'FUTA remittance', '1', ${signedTotal}, ${signedTotal}, '0')`);
        }
      }
    });
  });
  log("payroll volume done");

  // -- Inventory volume for 0293/0299 ------------------------------------------
  await withBypass(async () => {
    const invRng = rng.stream("inventory");
    const itemIds: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const id = randomUUID();
      itemIds.push(id);
    }
    for (let s = 0; s < itemIds.length; s += 500) {
      await db.insert(schema.items).values(
        itemIds.slice(s, s + 500).map((id, k) => ({
          id,
          orgId,
          kind: "inventory" as const,
          name: `Perf Item ${s + k + 1}`,
          code: `P1M-${String(s + k + 1).padStart(5, "0")}`,
          isActive: true,
          custom: {},
        })),
      );
    }
    const locationIds: string[] = [];
    for (const name of ["HQ Warehouse", "East Depot", "West Depot"]) {
      const id = randomUUID();
      locationIds.push(id);
      await db.execute(sql`
        insert into locations (id, org_id, name) values (${id}, ${orgId}, ${name})`);
    }
    const binIds: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = randomUUID();
      binIds.push(id);
      await db.execute(sql`
        insert into stock_locations (id, org_id, location_id, code, kind)
        values (${id}, ${orgId}, ${locationIds[i % 3]!}, ${`BIN-${String(i + 1).padStart(3, "0")}`}, 'bin')`);
    }
    // 600 counts x 500 unique-subject lines. Subjects are unique per count
    // by construction: a shuffled stride over (item, bin) space.
    const COUNTS = 600;
    const LINES_PER_COUNT = 500;
    for (let c = 0; c < COUNTS; c++) {
      const countId = randomUUID();
      const countedOn = monthOf(c % months).prefix;
      const status = c < 500 ? "posted" : c < 560 ? "review" : "counting";
      await db.execute(sql`
        insert into stock_counts (id, org_id, location_id, subsidiary_id, counted_on, status)
        values (${countId}, ${orgId}, ${locationIds[c % 3]!}, ${world.subsidiaryId},
                ${`${countedOn}-15`}, ${status})`);
      const stride = 37 + (c % 5);
      for (let s = 0; s < LINES_PER_COUNT; s += 500) {
        const batch: { item: string; bin: string; expected: string; counted: string | null }[] = [];
        for (let k = s; k < Math.min(s + 500, LINES_PER_COUNT); k++) {
          const pair = (c * 7919 + k * stride) % (itemIds.length * binIds.length);
          const item = itemIds[Math.floor(pair / binIds.length)]!;
          const bin = binIds[pair % binIds.length]!;
          const expected = Math.floor(invRng.next() * 500);
          const counted = invRng.next() < 0.1 ? null : String(Math.max(0, expected + Math.floor(invRng.next() * 11) - 5));
          batch.push({ item, bin, expected: String(expected), counted });
        }
        for (let b = 0; b < batch.length; b += 250) {
          await db.insert(schema.stockCountLines).values(
            batch.slice(b, b + 250).map((l) => ({
              id: randomUUID(),
              orgId,
              stockCountId: countId,
              itemId: l.item,
              stockLocationId: l.bin,
              expectedQuantity: l.expected,
              countedQuantity: l.counted,
            })),
          );
        }
      }
      if (c % 100 === 99) log(`counts: ${c + 1}/${COUNTS}`);
    }
  });
  log("inventory volume done");

  // -- Small realistic volumes for the remaining rewrite/validate tables ------
  await withBypass(async () => {
    // 0251 payment_links (token globally unique; bank must be asset_bank).
    const invDocs = await db.execute<{ id: string; party_id: string; total: string }>(sql`
      select id, party_id, total from documents
       where org_id = ${orgId} and kind = 'customer_invoice' order by document_number limit 200`);
    for (const [i, row] of invDocs.rows.entries()) {
      await db.execute(sql`
        insert into payment_links (id, org_id, token, document_id, party_id, subsidiary_id,
                                   provider, bank_account_id, amount, currency)
        values (${randomUUID()}, ${orgId}, ${`p1m-pl-${seed}-${i}`}, ${row.id}, ${row.party_id},
                ${world.subsidiaryId}, ${i % 2 === 0 ? "stripe" : "adyen"},
                ${world.accounts.bank!}, ${row.total}, 'USD')`);
    }
    // 0256-adjacent recognition_rules (methods across the enum).
    const methods = ["point_in_time", "straight_line_even", "straight_line_daily", "percent_complete", "milestone"];
    for (let i = 0; i < 20; i++) {
      await db.execute(sql`
        insert into recognition_rules (id, org_id, code, name, method)
        values (${randomUUID()}, ${orgId}, ${`P1M-RR-${i + 1}`}, ${`Perf rule ${i + 1}`}, ${methods[i % methods.length]!})`);
    }
    // 0258 subscriptions + recurring_schedules (template = real docs).
    for (let i = 0; i < 100; i++) {
      await db.execute(sql`
        insert into subscriptions (id, org_id, customer_id, plan_id, start_on, next_bill_on)
        values (${randomUUID()}, ${orgId}, ${extra.customerIds[i % extra.customerIds.length]!},
                ${randomUUID()}, '2024-01-01', '2026-07-01')`);
    }
    for (let i = 0; i < 50; i++) {
      await db.execute(sql`
        insert into recurring_schedules (id, org_id, template_document_id, cadence, next_run_on)
        values (${randomUUID()}, ${orgId}, ${invDocs.rows[i % invDocs.rows.length]!.id}, 'monthly', '2026-07-01')`);
    }
    // 0265 tax_filings (monthly 941s for 2024-2025). The snapshot hash must
    // be 64 lowercase hex (tax_filings_snapshot_hash_check); derive it
    // deterministically from the seed so reruns are identical.
    for (let m = 0; m < 24; m++) {
      const { prefix } = monthOf(m + 6);
      const snapshotHash = createHash("sha256").update(`p1m-${seed}-tax-${m}`).digest("hex");
      await db.execute(sql`
        insert into tax_filings (id, org_id, form_code, form_name, period_from, period_to, version,
                                 submission_channel, boxes, snapshot_hash)
        values (${randomUUID()}, ${orgId}, '941', 'Employer Quarterly Federal Tax Return',
                ${`${prefix}-01`}, ${`${prefix}-28`}, 1, 'irs_mef', '[]'::jsonb, ${snapshotHash})`);
    }
    // 0294 dunning_log (one row per invoice-stage; pairs unique).
    const stages = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < 500; i++) {
      // Stage advances every 200 rows, so (document, stage) pairs stay unique.
      const stage = stages[Math.floor(i / 200) % stages.length]!;
      await db.execute(sql`
        insert into dunning_log (id, org_id, document_id, policy_id, stage_id, amount_due)
        values (${randomUUID()}, ${orgId}, ${invDocs.rows[i % invDocs.rows.length]!.id},
                ${stages[0]!}, ${stage}, ${invDocs.rows[i % invDocs.rows.length]!.total})`);
    }
    // 0295 qbd_requests (queued/complete only: the partial unique forbids two sent).
    for (let c = 0; c < 5; c++) {
      const connId = randomUUID();
      await db.execute(sql`
        insert into connections (id, org_id, source, display_name)
        values (${connId}, ${orgId}, 'qbd', ${`Perf connector ${c + 1}`})`);
      for (let q = 0; q < 4; q++) {
        const capId = randomUUID();
        await db.execute(sql`
          insert into qbd_captures (id, org_id, connection_id, captured_through, expires_at, status)
          values (${capId}, ${orgId}, ${connId}, '2026-06-30T00:00:00Z', '2026-12-31T00:00:00Z', 'complete')`);
        for (let r = 0; r < 10; r++) {
          await db.execute(sql`
            insert into qbd_requests (id, org_id, connection_id, capture_id, family, request_kind,
                                      sequence, request_xml, status)
            values (${randomUUID()}, ${orgId}, ${connId}, ${capId}, 'customer', 'query',
                    ${q * 10 + r}, '<xml/>', ${r % 2 === 0 ? "complete" : "queued"})`);
        }
      }
    }
    // 0298 item_rate_lines (against a draft version) + profiles.
    const bookId = randomUUID();
    await db.execute(sql`
      insert into item_rate_books (id, org_id, code, name, currency) values (${bookId}, ${orgId}, 'P1M', 'Perf rates', 'USD')`);
    const versionId = randomUUID();
    await db.execute(sql`
      insert into item_rate_versions (id, org_id, rate_book_id, status, effective_from, effective_to)
      values (${versionId}, ${orgId}, ${bookId}, 'draft', '2024-01-01', '2026-12-31')`);
    const rateItems = await db.execute<{ id: string }>(sql`
      select id from items where org_id = ${orgId} order by code limit 200`);
    for (const [i, row] of rateItems.rows.entries()) {
      await db.execute(sql`
        insert into item_rate_profiles (id, org_id, item_id, base_unit)
        values (${randomUUID()}, ${orgId}, ${row.id}, 'each')`);
      await db.execute(sql`
        insert into item_rate_lines (id, org_id, version_id, item_id, unit_code, unit_name, base_quantity)
        values (${randomUUID()}, ${orgId}, ${versionId}, ${row.id}, 'EA', 'Each', ${String(1 + (i % 10))})`);
    }
    // 0301 item_price_schedules on the auto-created BASE level. The table is
    // born in 0244, so sources older than that have no legacy rows by
    // construction — skip when the table does not exist yet.
    const levels = await db.execute<{ id: string }>(sql`
      select l.id from price_levels l
       where l.org_id = ${orgId} and l.code = 'BASE'
         and exists (select 1 from information_schema.tables
                      where table_schema = 'public' and table_name = 'price_levels')
       limit 1`);
    const baseLevelId = levels.rows[0]?.id ?? null;
    if (baseLevelId) {
      for (const [, row] of rateItems.rows.entries()) {
        await db.execute(sql`
          insert into item_price_schedules (id, org_id, item_id, currency, effective_from, price_level_id)
          values (${randomUUID()}, ${orgId}, ${row.id}, 'USD', '2024-01-01', ${baseLevelId})`);
      }
    }
    log(`extras done${baseLevelId ? "" : " (price_levels absent on this source; price schedules skipped)"}`);
  });

  log(`seed complete: ${totalLines} journal_lines in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify({ orgIds: [orgId] }));
}

function causeChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && parts.length < 5) {
    parts.push(`${current.name}: ${current.message}`);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join("\ncaused by ");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`[perf-1m] refused: ${causeChain(error)}`);
    process.exit(1);
  },
);
