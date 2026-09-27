import { sql } from "drizzle-orm";
import { installEngineSeams } from "../../composition/install.ts";
import { bookPledge, createPledge, runPledgeDiscountAmortization } from "../../nonprofit/pledges.ts";
import { provisionFundAccounting } from "../../nonprofit/provision.ts";
import { db, withOrgContext } from "../../platform/db.ts";
import type { ActualEntry, ActualOutcome, CaseContext, ConformanceCase } from "../types.ts";

async function postPledgeCase(
  ctx: CaseContext,
  input: { totalAmount: string; discountRate: string; amortize: boolean },
): Promise<ActualOutcome> {
  const ledger = ctx.ledger;
  if (!ledger) throw new Error("A ledger context is required for nonprofit contribution cases.");

  installEngineSeams();
  await withOrgContext(ledger.orgId, async () => {
    const enabled = await db.execute<{ id: string }>(sql`
      update orgs set settings = jsonb_set(
        coalesce(settings, '{}'::jsonb), '{features}',
        coalesce(settings->'features', '{}'::jsonb) ||
          '{"nonprofit":true,"fundAccounting":true,"pledges":true}'::jsonb,
        true)
       where id = ${ledger.orgId}
      returning id`);
    if (enabled.rows.length !== 1) throw new Error("The nonprofit feature settings were not updated.");
  });

  const fund = await provisionFundAccounting({
    orgId: ledger.orgId,
    defaultFund: { code: "OPERATING", name: "Operating Fund" },
    classifications: {
      OPERATING: { kind: "operating", restrictionClass: "without_donor_restrictions" },
    },
    actorId: ledger.actorId,
  });
  const dueOn = "2026-08-15";
  const pledge = await createPledge({
    orgId: ledger.orgId,
    subsidiaryId: ledger.subsidiaryId,
    donorPartyId: ledger.customerId,
    fundId: fund.defaultFundId,
    totalAmount: input.totalAmount,
    discountRate: input.discountRate,
    installments: [{ dueOn, amount: input.totalAmount }],
    reason: "Record the unconditional contribution promise",
    actorId: ledger.actorId,
  });
  const booking = await bookPledge({
    orgId: ledger.orgId,
    pledgeId: pledge.id,
    postingDate: ledger.date,
    receivableAccountId: ctx.roles.pledgesReceivable!,
    discountAccountId: ctx.roles.discountOnPledges!,
    contributionsAccountId: ctx.roles.contributions!,
    reason: "Recognize the unconditional contribution promise",
    actorId: ledger.actorId,
  });

  if (input.amortize) {
    const amortization = await runPledgeDiscountAmortization({
      orgId: ledger.orgId,
      periodEnd: "2026-08-31",
      discountAccountId: ctx.roles.discountOnPledges!,
      contributionsAccountId: ctx.roles.contributions!,
      actorId: ledger.actorId,
    });
    if (amortization.posted !== 1) {
      throw new Error("The pledge discount amortization did not post exactly once.");
    }
  }

  return withOrgContext(ledger.orgId, async () => {
    const rows = await db.execute<{
      entryId: string; memo: string; accountId: string; amount: string;
    }>(sql`
      select je.id as "entryId", je.memo, jl.account_id as "accountId", jl.amount::text as amount
        from journal_entries je
        join journal_lines jl on jl.org_id = je.org_id and jl.entry_id = je.id
       where je.org_id = ${ledger.orgId}
         and (je.id = ${booking.entryId} or
              je.custom->'nonprofitPledge'->>'pledgeId' = ${pledge.id})
       order by je.posting_date, je.entry_number, jl.line_number`);
    const entries = new Map<string, ActualEntry>();
    for (const row of rows.rows) {
      let entry = entries.get(row.entryId);
      if (!entry) {
        entry = {
          step: row.entryId === booking.entryId ? "booking" : "discount amortization",
          lines: [],
        };
        entries.set(row.entryId, entry);
      }
      entry.lines.push({ accountId: row.accountId, amount: row.amount });
    }
    return { entries: [...entries.values()] };
  });
}

export const NONPROFIT_CONTRIBUTION_CASES: readonly ConformanceCase[] = [
  {
    id: "np-pledge-unconditional",
    title: "An unconditional contribution promise is recognised when made",
    citations: [{
      standard: "ASC 958",
      reference: "958-605-25",
      kind: "requirement",
      requirement: "An unconditional promise to give is recognised as contribution revenue and a receivable when the promise is made.",
    }],
    support: "supported",
    tier: "ledger",
    assertion: "A documented unconditional promise is recorded as a receivable and contribution revenue when booked.",
    facts: [
      "A donor makes an unconditional promise of 1,000.0000 on 2026-07-15.",
      "The full amount is due one month later and carries no discount rate.",
      "The promise is booked to pledges receivable and contributions.",
    ],
    expected: { entries: [{
      step: "booking",
      lines: [
        { role: "pledgesReceivable", amount: "1000.0000" },
        { role: "contributions", amount: "-1000.0000" },
      ],
    }] },
    run: (ctx) => postPledgeCase(ctx, { totalAmount: "1000.0000", discountRate: "0", amortize: false }),
  },
  {
    id: "np-pledge-discount",
    title: "Discount accretion is contribution revenue",
    citations: [{
      standard: "ASC 958",
      reference: "958-605-30/35",
      kind: "requirement",
      requirement: "A discounted promise is initially measured at present value, and subsequent accretion is reported as contribution revenue.",
    }],
    support: "supported",
    tier: "ledger",
    assertion: "A one-month discounted promise is booked at present value and its discount accretion is posted as contribution revenue.",
    facts: [
      "A donor promises 101.0000 due on 2026-08-15, one month after booking.",
      "The annual discount rate is 12 percent, or one percent per monthly period.",
      "The 100.0000 present value is booked first; 1.0000 accretion is recognised as contribution revenue at month end.",
    ],
    expected: { entries: [
      {
        step: "booking",
        lines: [
          { role: "pledgesReceivable", amount: "101.0000" },
          { role: "discountOnPledges", amount: "-1.0000" },
          { role: "contributions", amount: "-100.0000" },
        ],
      },
      {
        step: "discount amortization",
        lines: [
          { role: "discountOnPledges", amount: "1.0000" },
          { role: "contributions", amount: "-1.0000" },
        ],
      },
    ] },
    run: (ctx) => postPledgeCase(ctx, { totalAmount: "101.0000", discountRate: "12", amortize: true }),
  },
];
