#!/usr/bin/env -S npx tsx
/**
 * Multi-entity upgrade-rehearsal seeder (dataset class `multi-entity`).
 *
 * OWNERSHIP: this file is candidate-owned (scripts/upgrade-rehearsal/seeders/)
 * but it RUNS INSIDE THE SOURCE TREE: rehearse.mjs copies it to
 * `engine/src/upgrade-rehearsal-seed/multi-entity.ts` and executes it there
 * with the source release's runtime. Relative imports below resolve from THAT
 * location, and every module imported must exist in BOTH v0.1.0-alpha.22 and
 * v0.1.0-alpha.23 (the schemas are identical; the engine surface used here is
 * unchanged between the tags).
 *
 * What it builds, deterministically from `--seed`:
 *   - a sim-tagged org (source sim/world.ts provisionOrg, general-business)
 *   - USD parent + EUR and CAD subsidiaries + a USD elimination subsidiary
 *   - FX rates, foreign-currency customers/vendors, foreign-currency
 *     invoices/bills/payments with realized FX (all through the posting
 *     kernel: postDocument / postPaymentWithApplications)
 *   - a month-end FX revaluation, an intercompany journal, a consolidation run
 *   - closed periods (Jan-Mar 2026)
 *
 * There are NO raw ledger inserts: journal_entries/journal_lines are written
 * only by the kernel. Master data (subsidiaries, rates, parties, pairs,
 * policies) goes through the same SQL shapes the source's own conformance
 * cases use. Prints `{"orgIds":[...]}` as its last JSON line.
 *
 * Usage (from the source checkout root):
 *   OPENBOOKS_SIM=1 npx tsx engine/src/upgrade-rehearsal-seed/multi-entity.ts --seed upgrade-multi-1
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, schema, withBypass, withOrgContext } from "../platform/db.ts";
import { withSimClock } from "../platform/clock.ts";
import { Rng } from "../sim/rng.ts";
import { getProfile } from "../sim/profiles/index.ts";
import { provisionOrg, type SimOrg } from "../sim/world.ts";
import { releaseDraftIfUngated } from "../sim/activities/documents.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { sum } from "../money/money.ts";
import {
  createPaymentDocument,
  updateDraftPayment,
} from "../payments/payment-documents.ts";
import { postPaymentWithApplications } from "../payments/payment-posting.ts";
import { sameCurrencyAllocation } from "../payments/settlement-policy.ts";
import { runRevaluation } from "../close/fx-revaluation.ts";
import { runCombinedConsolidation } from "../consolidation/consolidation.ts";
import { closeMonth } from "../sim/ops.ts";

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} is required (usage: multi-entity.ts --seed <seed>)`);
  }
  return value;
}

interface DraftLine {
  accountId: string;
  description: string;
  amount: string;
  subsidiaryId?: string;
}

/** Insert a draft header + lines (txn-currency amounts), mirroring sim createDraftDocument plus currency/fx/subsidiary. */
async function createDraft(
  world: SimOrg,
  opts: {
    kind: string;
    documentNumber: string;
    partyId: string | null;
    documentDate: string;
    currency: string;
    fxRate: string;
    subsidiaryId: string;
    memo: string;
    lines: DraftLine[];
  },
): Promise<string> {
  const total = sum(opts.lines.map((l) => l.amount));
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId: world.orgId,
      kind: opts.kind,
      documentNumber: opts.documentNumber,
      partyId: opts.partyId,
      documentDate: opts.documentDate,
      currency: opts.currency,
      fxRate: opts.fxRate,
      subsidiaryId: opts.subsidiaryId,
      subtotal: total,
      taxTotal: "0",
      total,
      memo: opts.memo,
      createdBy: world.actors.admin,
      custom: {},
    })
    .returning({ id: schema.documents.id });
  await db.insert(schema.documentLines).values(
    opts.lines.map((l, i) => ({
      orgId: world.orgId,
      documentId: doc!.id,
      lineNumber: i + 1,
      accountId: l.accountId,
      description: l.description,
      quantity: "1",
      unitPrice: l.amount,
      amount: l.amount,
      taxAmount: "0",
      subsidiaryId: l.subsidiaryId ?? null,
    })),
  );
  return doc!.id;
}

async function postDraft(world: SimOrg, documentId: string): Promise<string> {
  const actorId = await releaseDraftIfUngated(world, documentId);
  return postDocument(documentId, {
    control: {
      ar: world.accounts.ar!,
      ap: world.accounts.ap!,
      bank: world.accounts.bank!,
    },
  }, { audit: { actorId, source: "upgrade-rehearsal-seed" } });
}

async function approvePayment(paymentId: string, actorId: string, orgId: string): Promise<void> {
  await db.execute(sql`
    update documents
       set status = 'approved', submitted_by = ${actorId}, submitted_at = now()
     where id = ${paymentId} and org_id = ${orgId}`);
}

function decimal(rate: number, places: number): string {
  return rate.toFixed(places);
}

async function main(): Promise<void> {
  const seed = arg("seed");
  const rng = Rng.fromSeed(seed);
  const log = (message: string): void => {
    console.log(`[multi-entity] ${message}`);
  };

  // -- Provision the sim-tagged USD parent ---------------------------------
  const world = await provisionOrg(getProfile("general-business"), {
    startDate: "2026-01-01",
    endDate: "2026-06-30",
  });
  const orgId = world.orgId;
  const admin = world.actors.admin;
  log(`provisioned org ${orgId}`);
  const periodByName = new Map(world.periods.map((p) => [p.name, p.id]));
  const period = (name: string): string => {
    const id = periodByName.get(name);
    if (!id) throw new Error(`multi-entity seeder: no period ${name}`);
    return id;
  };

  // -- Subsidiaries, currencies, features -----------------------------------
  const subs = await withBypass(async () => {
    // currencies is a GLOBAL table: conflicts across reruns are expected and
    // benign (ISO rows are identical), so upsert without clobbering.
    for (const [code, name, minor] of [
      ["USD", "US Dollar", 2],
      ["EUR", "Euro", 2],
      ["CAD", "Canadian Dollar", 2],
    ] as const) {
      await db.execute(sql`
        insert into currencies (code, name, minor_units)
        values (${code}, ${name}, ${minor})
        on conflict (code) do nothing`);
    }
    const mk = async (name: string, currency: string, country: string, elim: boolean): Promise<string> => {
      const id = randomUUID();
      await db.execute(sql`
        insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${id}, ${orgId}, ${world.subsidiaryId}, ${name}, ${currency}, ${country},
                '{}'::jsonb, ${elim}, true, '{}'::jsonb)`);
      return id;
    };
    const eur = await mk("EU Sub Co", "EUR", "DE", false);
    const cad = await mk("CA Sub Co", "CAD", "CA", false);
    const elim = await mk("Eliminations", "USD", "US", true);
    // Belt-and-braces: the features are data-derived, but say so explicitly.
    await db.execute(sql`
      update orgs
         set settings = coalesce(settings, '{}'::jsonb)
           || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
              || '{"multiCurrency": true, "multiSubsidiary": true}'::jsonb,
              'controlAccounts', coalesce(settings->'controlAccounts', '{}'::jsonb)
              || jsonb_build_object('fxUnrealizedGainLoss', to_jsonb(${world.accounts.fxGainLoss}::text)))
       where id = ${orgId}`);
    return { eur, cad, elim };
  });
  log(`subsidiaries eur=${subs.eur} cad=${subs.cad} elim=${subs.elim}`);

  // -- FX rates: monthly spots for every directed pair the books need --------
  const pairs: [string, string, number][] = [
    ["EUR", "USD", 1.08],
    ["CAD", "USD", 0.74],
    ["EUR", "CAD", 1.4595],
  ];
  const monthEnds = ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"];
  const spotDates = ["2026-01-01", "2026-01-15", "2026-01-31", "2026-02-15", "2026-02-28",
    "2026-03-15", "2026-03-31", "2026-04-15", "2026-04-30", "2026-05-15", "2026-05-31",
    "2026-06-15", "2026-06-30"];
  const spotOf = new Map<string, string>();
  await withBypass(async () => {
    for (const [from, to, base] of pairs) {
      const drift = rng.stream(`fx-${from}-${to}`);
      for (const asOf of spotDates) {
        // March is flat: the intercompany journals post mid-March and the
        // consolidation translates balance-sheet legs at the March current
        // rate, so any drift between the two dates would leave a real
        // residual and abort elimination. Other months drift deterministically.
        const rate = asOf.startsWith("2026-03") ? base : base * (1 + (drift.next() - 0.5) * 0.016);
        const text = decimal(rate, 10);
        spotOf.set(`${from}-${to}@${asOf}`, text);
        await db.execute(sql`
          insert into fx_rates (id, org_id, from_currency, to_currency, as_of, rate_type, rate, source)
          values (${randomUUID()}, ${orgId}, ${from}, ${to}, ${asOf}, 'spot', ${text}, 'manual')
          on conflict (org_id, from_currency, to_currency, as_of, rate_type)
          do update set rate = excluded.rate`);
      }
    }
  });
  const spot = (from: string, to: string, asOf: string): string => {
    const rate = spotOf.get(`${from}-${to}@${asOf}`);
    if (!rate) throw new Error(`multi-entity seeder: no seeded spot ${from}->${to} @ ${asOf}`);
    return rate;
  };
  void monthEnds;
  log(`seeded ${spotOf.size} spot rates`);

  const scoped = <T>(fn: () => Promise<T>): Promise<T> =>
    withSimClock("2026-06-30", () => withOrgContext(orgId, fn));

  // -- Parties, IC plumbing, consolidation accounts --------------------------
  const parties = await scoped(async () => {
    const mk = async (kind: "customer" | "vendor", name: string, subsidiaryId: string): Promise<string> => {
      const id = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${id}, ${orgId}, ${kind}, ${name}, ${subsidiaryId}, true, '{}'::jsonb)`);
      if (kind === "customer") {
        await db.execute(sql`
          insert into customer_roles (id, org_id, party_id)
          values (${randomUUID()}, ${orgId}, ${id})`);
      } else {
        await db.execute(sql`
          insert into vendor_roles (id, org_id, party_id)
          values (${randomUUID()}, ${orgId}, ${id})`);
      }
      // Admit every foreign party to the parent as well: trade documents post
      // in the parent's subsidiary (so the golden harness can trace header
      // totals into functional legs), and the restriction validator admits a
      // party to its primary subsidiary or any party_subsidiaries row.
      await db.execute(sql`
        insert into party_subsidiaries (id, org_id, party_id, subsidiary_id)
        values (${randomUUID()}, ${orgId}, ${id}, ${world.subsidiaryId})`);
      return id;
    };
    return {
      eurCustomer: await mk("customer", "Europa Foods BV", subs.eur),
      eurVendor: await mk("vendor", "Berlin Supply GmbH", subs.eur),
      cadCustomer: await mk("customer", "Toronto Retail Ltd", subs.cad),
      cadVendor: await mk("vendor", "Ontario Parts Inc", subs.cad),
    };
  });

  const accts = await scoped(async () => {
    const mk = async (number: string, name: string, type: string, eliminate: boolean): Promise<string> => {
      const id = randomUUID();
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                              reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, ${eliminate},
                false, '[]'::jsonb, '{}'::jsonb, true)`);
      return id;
    };
    const out = {
      dueFrom: await mk("1160", "Due from Subsidiaries", "asset_current_other", true),
      dueTo: await mk("2160", "Due to Parent", "liability_current_other", true),
      investment: await mk("1540", "Investment in Subsidiaries", "asset_other", false),
      equityIncome: await mk("4920", "Equity in Subsidiary Earnings", "income_other", false),
      goodwill: await mk("1550", "Consolidation Goodwill", "asset_other", false),
      fva: await mk("1560", "Fair Value Adjustments", "asset_other", false),
      nciEquity: await mk("3400", "Non-Controlling Interest", "equity", false),
      nciIncome: await mk("4930", "NCI Share of Earnings", "income_other", false),
    };
    for (const [from, to] of [[world.subsidiaryId, subs.eur], [world.subsidiaryId, subs.cad]] as const) {
      await db.execute(sql`
        insert into intercompany_pairs
          (id, org_id, from_subsidiary_id, to_subsidiary_id, due_from_account_id, due_to_account_id, is_active)
        values (${randomUUID()}, ${orgId}, ${from}, ${to}, ${out.dueFrom}, ${out.dueTo}, true)`);
    }
    return out;
  });
  log("parties, IC pairs, and consolidation accounts ready");

  // -- Capitalize the subsidiaries + parent investments (kernel journals) -----
  await scoped(async () => {
    const capEur = await createDraft(world, {
      kind: "journal", documentNumber: "ME-CAP-EUR-01", partyId: null,
      documentDate: "2026-01-05", currency: "EUR", fxRate: "1",
      subsidiaryId: subs.eur, memo: "Capitalize EU Sub Co",
      lines: [
        { accountId: world.accounts.bank!, description: "Seed capital", amount: "200000" },
        { accountId: world.accounts.commonStock!, description: "Share capital", amount: "-200000" },
      ],
    });
    await postDraft(world, capEur);
    const capCad = await createDraft(world, {
      kind: "journal", documentNumber: "ME-CAP-CAD-01", partyId: null,
      documentDate: "2026-01-05", currency: "CAD", fxRate: "1",
      subsidiaryId: subs.cad, memo: "Capitalize CA Sub Co",
      lines: [
        { accountId: world.accounts.bank!, description: "Seed capital", amount: "150000" },
        { accountId: world.accounts.commonStock!, description: "Share capital", amount: "-150000" },
      ],
    });
    await postDraft(world, capCad);
    // Parent investments at the acquisition spots: cost == FVNA, so no goodwill.
    const eurCost = "216000";
    const cadCost = "111000";
    const invEur = await createDraft(world, {
      kind: "journal", documentNumber: "ME-INV-EUR-01", partyId: null,
      documentDate: "2026-01-15", currency: "USD", fxRate: "1",
      subsidiaryId: world.subsidiaryId, memo: "Acquire EU Sub Co (100%)",
      lines: [
        { accountId: accts.investment, description: "Investment in EU Sub Co", amount: eurCost },
        { accountId: world.accounts.bank!, description: "Acquisition cash", amount: `-${eurCost}` },
      ],
    });
    await postDraft(world, invEur);
    const invCad = await createDraft(world, {
      kind: "journal", documentNumber: "ME-INV-CAD-01", partyId: null,
      documentDate: "2026-01-15", currency: "USD", fxRate: "1",
      subsidiaryId: world.subsidiaryId, memo: "Acquire CA Sub Co (100%)",
      lines: [
        { accountId: accts.investment, description: "Investment in CA Sub Co", amount: cadCost },
        { accountId: world.accounts.bank!, description: "Acquisition cash", amount: `-${cadCost}` },
      ],
    });
    await postDraft(world, invCad);
    // Downstream USD funding: each foreign subsidiary holds a USD bank
    // balance (a monetary account in a foreign transaction currency), which
    // is exactly the exposure the month-end revaluation re-measures. Without
    // this the subsidiaries only hold same-currency capital plus translated
    // IC legs on non-monetary accounts, and revaluation skips them.
    const fundEur = await createDraft(world, {
      kind: "journal", documentNumber: "ME-FUND-EUR-01", partyId: null,
      documentDate: "2026-02-20", currency: "USD", fxRate: "1",
      subsidiaryId: subs.eur, memo: "Downstream USD funding to EU Sub Co",
      lines: [
        { accountId: world.accounts.bank!, description: "USD funds received", amount: "20000" },
        { accountId: world.accounts.commonStock!, description: "Additional paid-in capital", amount: "-20000" },
      ],
    });
    await postDraft(world, fundEur);
    const fundCad = await createDraft(world, {
      kind: "journal", documentNumber: "ME-FUND-CAD-01", partyId: null,
      documentDate: "2026-02-20", currency: "USD", fxRate: "1",
      subsidiaryId: subs.cad, memo: "Downstream USD funding to CA Sub Co",
      lines: [
        { accountId: world.accounts.bank!, description: "USD funds received", amount: "15000" },
        { accountId: world.accounts.commonStock!, description: "Additional paid-in capital", amount: "-15000" },
      ],
    });
    await postDraft(world, fundCad);
    for (const [subId, cost, acqRate] of [
      [subs.eur, eurCost, "1.08"],
      [subs.cad, cadCost, "0.74"],
    ] as const) {
      await db.execute(sql`
        insert into subsidiary_ownership_interests
          (id, org_id, parent_subsidiary_id, subsidiary_id, effective_from, ownership_percent, method,
           acquisition_date, acquisition_cost, fair_value_net_assets, acquisition_rate,
           nci_measurement, investment_account_id, equity_income_account_id,
           nci_equity_account_id, nci_income_account_id,
           goodwill_account_id, fair_value_adjustment_account_id, is_active)
        values (${randomUUID()}, ${orgId}, ${world.subsidiaryId}, ${subId}, '2026-01-15', '100', 'full',
                '2026-01-15', ${cost}, ${cost}, ${acqRate},
                'proportionate', ${accts.investment}, ${accts.equityIncome},
                ${accts.nciEquity}, ${accts.nciIncome},
                ${accts.goodwill}, ${accts.fva}, true)`);
    }
  });
  log("capitalization, investments, and ownership policies posted");

  // -- Foreign-currency trade documents. All post in the PARENT subsidiary ----
  // (USD functional) with explicit commercial header rates: the kernel
  // translates every leg to functional, so the golden harness can trace each
  // header total (total x fx_rate) into the posted legs. Documents posted in
  // a foreign subsidiary keep their legs in the foreign currency and fail the
  // harness document-journal-tieout by construction.
  //
  // Commercial rates for the two cross-paid invoices (1.08 and 0.74) differ
  // from the settlement rates, so both cross-currency partials post genuine
  // realized-FX plugs to separate entries (USD +25.00 on ME-INV-EUR-01,
  // USD +72.00 on ME-INV-CAD-01). This stays clean because migration 0100
  // denominates cached open balances in the DOCUMENT currency (txn amounts
  // minus source/target txn applied), not functional: the invoice keeps
  // total minus target-txn, the payment keeps source-txn minus source-txn.
  const eur1Rate = "1.08";
  const cad1Rate = "0.74";
  const eur2Rate = spot("EUR", "USD", "2026-02-15");
  const cadBillRate = spot("CAD", "USD", "2026-02-15");
  const invoices = await scoped(async () => {
    const mk = async (
      n: string, kind: string, partyId: string, date: string, currency: string,
      fxRate: string, revenueAccount: string, amounts: string[],
    ): Promise<{ documentId: string; entryId: string }> => {
      const documentId = await createDraft(world, {
        kind, documentNumber: n, partyId, documentDate: date,
        currency, fxRate, subsidiaryId: world.subsidiaryId, memo: `rehearsal ${n}`,
        lines: amounts.map((amount, i) => ({
          accountId: revenueAccount,
          description: `Line ${i + 1}`,
          amount,
        })),
      });
      const entryId = await postDraft(world, documentId);
      return { documentId, entryId };
    };
    const usd = world.customers[0]!;
    const usdVendor = world.vendors[0]!;
    return {
      usdInvoice: await mk("ME-INV-USD-01", "customer_invoice", usd.id, "2026-01-20", "USD", "1",
        world.accounts.revenueService!, ["15000", "10000"]),
      eurInvoice1: await mk("ME-INV-EUR-01", "customer_invoice", parties.eurCustomer, "2026-01-22",
        "EUR", eur1Rate, world.accounts.revenueProduct!, ["25000", "15000"]),
      eurInvoice2: await mk("ME-INV-EUR-02", "customer_invoice", parties.eurCustomer, "2026-02-10",
        "EUR", eur2Rate, world.accounts.revenueService!, ["18500"]),
      cadInvoice: await mk("ME-INV-CAD-01", "customer_invoice", parties.cadCustomer, "2026-02-12",
        "CAD", cad1Rate, world.accounts.revenueProduct!, ["30000"]),
      eurBill: await mk("ME-BILL-EUR-01", "vendor_bill", parties.eurVendor, "2026-01-28",
        "EUR", spot("EUR", "USD", "2026-01-15"), world.accounts.materials!, ["22000"]),
      cadBill: await mk("ME-BILL-CAD-01", "vendor_bill", parties.cadVendor, "2026-02-05",
        "CAD", cadBillRate, world.accounts.materials!, ["12000"]),
      usdBill: await mk("ME-BILL-USD-01", "vendor_bill", usdVendor.id, "2026-02-08",
        "USD", "1", world.accounts.office!, ["9500"]),
    };
  });
  log("trade documents posted");

  // -- Payments, all in the parent subsidiary (applications require the ------
  // same subsidiary on both endpoints). Same-currency payments reuse the
  // invoice header rate exactly, so functional legs match to the cent;
  // cross-currency partials settle at bank-advice rates that differ from the
  // invoice rates (USD 5,425 for EUR 5,000; USD 5,400 for CAD 7,200), posting
  // real realized-FX plugs. Open residuals (€35,000, C$22,800, €22,000,
  // $9,500) remain for the March revaluation.
  await scoped(async () => {
    const openLine = async (entryId: string, accountId: string): Promise<string> => {
      const rows = await db.execute<{ id: string }>(sql`
        select id from journal_lines
         where entry_id = ${entryId} and account_id = ${accountId} and org_id = ${orgId}
         order by line_number limit 1`);
      const id = rows.rows[0]?.id;
      if (!id) throw new Error("multi-entity seeder: open-item line not found");
      return id;
    };
    const pay = async (
      kind: "customer_payment" | "vendor_payment", partyId: string, date: string, currency: string,
      fxRate: string,
      allocations: Parameters<typeof updateDraftPayment>[1]["allocations"],
    ): Promise<void> => {
      const doc = await createPaymentDocument({
        orgId, kind,
        createdBy: admin, partyId, bankAccountId: world.accounts.bank!,
        documentDate: date, subsidiaryId: world.subsidiaryId, currency, fxRate,
      });
      await updateDraftPayment(doc.id, { allocations, bankAccountId: world.accounts.bank! }, admin, orgId);
      await approvePayment(doc.id, admin, orgId);
      await postPaymentWithApplications(doc.id, undefined, admin);
    };
    await pay("customer_payment", world.customers[0]!.id, "2026-02-20", "USD", "1",
      [sameCurrencyAllocation(
        await openLine(invoices.usdInvoice.entryId, world.accounts.ar!), "25000")]);
    await pay("customer_payment", parties.eurCustomer, "2026-03-05", "EUR", eur2Rate,
      [sameCurrencyAllocation(
        await openLine(invoices.eurInvoice2.entryId, world.accounts.ar!), "18500")]);
    await pay("customer_payment", parties.eurCustomer, "2026-03-10", "USD", "1",
      [{
        openLineId: await openLine(invoices.eurInvoice1.entryId, world.accounts.ar!),
        sourceTransactionAmount: "5425",
        targetTransactionAmount: "5000",
        settlementRate: "0.9216589862",
        settlementRateSource: "manual",
        settlementRateReference: "BANK-ADVICE-ME-01",
      }]);
    await pay("vendor_payment", parties.cadVendor, "2026-03-12", "CAD", cadBillRate,
      [sameCurrencyAllocation(
        await openLine(invoices.cadBill.entryId, world.accounts.ap!), "12000")]);
    await pay("customer_payment", parties.cadCustomer, "2026-03-14", "USD", "1",
      [{
        openLineId: await openLine(invoices.cadInvoice.entryId, world.accounts.ar!),
        sourceTransactionAmount: "5400",
        targetTransactionAmount: "7200",
        settlementRate: "1.3333333333",
        settlementRateSource: "manual",
        settlementRateReference: "BANK-ADVICE-ME-02",
      }]);
  });
  log("payments posted (same-currency in full, two cross-currency partials with realized FX)");

  // -- Month-end FX revaluation (March; reversal lands in April) ---------------
  const reval = await scoped(async () =>
    runRevaluation(orgId, period("2026-03"), admin));
  if (reval.problems.length > 0 || reval.posted.length < 2) {
    throw new Error(
      `multi-entity seeder: revaluation posted ${reval.posted.length} with ` +
      `${reval.problems.length} problem(s): ${JSON.stringify(reval.problems.slice(0, 3))} ` +
      `skipped=${JSON.stringify(reval.skipped)}`);
  }
  log(`revaluation posted ${reval.posted.length} entries (skipped ${reval.skipped.length})`);

  // -- Intercompany journals. Each doc balances in the transaction currency --
  // (the journal rule requires it); each subsidiary does NOT, so the kernel
  // injects the due-to/due-from legs from the configured pairs. -------------
  await scoped(async () => {
    const icEur = await createDraft(world, {
      kind: "journal", documentNumber: "ME-IC-EUR-01", partyId: null,
      documentDate: "2026-03-18", currency: "USD", fxRate: "1",
      subsidiaryId: world.subsidiaryId, memo: "Management fee to EU Sub Co",
      lines: [
        { accountId: world.accounts.revenueService!, description: "Management fee income", amount: "-8000" },
        { accountId: world.accounts.professionalFees!, description: "Management fee expense", amount: "8000", subsidiaryId: subs.eur },
      ],
    });
    await postDraft(world, icEur);
    const icCad = await createDraft(world, {
      kind: "journal", documentNumber: "ME-IC-CAD-01", partyId: null,
      documentDate: "2026-03-18", currency: "USD", fxRate: "1",
      subsidiaryId: world.subsidiaryId, memo: "Management fee to CA Sub Co",
      lines: [
        { accountId: world.accounts.revenueService!, description: "Management fee income", amount: "-4000" },
        { accountId: world.accounts.professionalFees!, description: "Management fee expense", amount: "4000", subsidiaryId: subs.cad },
      ],
    });
    await postDraft(world, icCad);
  });
  log("intercompany journals posted");

  // -- Consolidation run (rates + 100%-owned elimination) ----------------------
  const consol = await scoped(async () =>
    runCombinedConsolidation(orgId, period("2026-03"), admin));
  if (consol.ownership.entryIds.length === 0 || (consol.elimination.lineCount ?? 0) === 0) {
    throw new Error(
      `multi-entity seeder: consolidation came back empty: ${JSON.stringify(consol)}`);
  }
  log(`consolidation: rates=${consol.ratesWritten} ownershipEntries=${consol.ownership.entryIds.length} ` +
    `eliminationLines=${consol.elimination.lineCount}`);

  // -- Close Jan-Mar (harness cutoff becomes a stable, posted quarter-end) -----
  await scoped(async () => {
    await closeMonth(world, period("2026-01"), admin, "rehearsal month-end close");
    await closeMonth(world, period("2026-02"), admin, "rehearsal month-end close");
    await closeMonth(world, period("2026-03"), admin, "rehearsal month-end close");
  });
  log("periods 2026-01..2026-03 closed");

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
    console.error(`[multi-entity] refused: ${causeChain(error)}`);
    process.exit(1);
  },
);
