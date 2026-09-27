import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../../composition/install.ts";
import { createGrant, awardGrant, activateGrant, recordGrantDrawdown, satisfyGrantBarrier, recognizeGrantDrawdown, type GrantPostingAccounts } from "../../nonprofit/grants.ts";
import { provisionFundAccounting } from "../../nonprofit/provision.ts";
import { db, withOrgContext } from "../../platform/db.ts";
import { capture } from "../ledger-helpers.ts";
import type { CaseContext, ConformanceCase } from "../types.ts";

export const NONPROFIT_GRANT_CASES: readonly ConformanceCase[] = [
  {
    id: "np-grant-conditional",
    title: "A conditional grant advance remains a liability until its barrier is met",
    citations: [
      {
        standard: "ASC 958",
        reference: "958-605",
        kind: "requirement",
        requirement: "A contribution with a substantive barrier and a right of return or release remains conditional until the barrier is substantially met; amounts received before then are liabilities.",
      },
      {
        standard: "ASC 958",
        reference: "ASU 2018-08",
        kind: "requirement",
        requirement: "A conditional contribution is recognized as revenue when the substantive barrier is overcome.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion: "An advance under a conditional award is recorded as a refundable liability, and the same amount becomes grant revenue only after the documented barrier is met.",
    facts: [
      "A nonprofit organization receives a 100.00 conditional award with a substantive reporting barrier and a right of return.",
      "The organization receives a 100.00 advance before satisfying the barrier.",
      "The organization records evidence that the barrier was met and recognizes the advance.",
    ],
    expected: {
      entries: [
        {
          step: "advance receipt",
          lines: [
            { role: "bank", amount: "100.0000" },
            { role: "refundableAdvance", amount: "-100.0000" },
          ],
        },
        {
          step: "barrier satisfaction",
          lines: [
            { role: "refundableAdvance", amount: "100.0000" },
            { role: "grantRevenue", amount: "-100.0000" },
          ],
        },
      ],
    },
    run: async (ctx: CaseContext) => {
      const ledger = ctx.ledger!;
      installEngineSeams();
      const makeAccount = async (number: string, name: string, type: string): Promise<string> => {
        const id = randomUUID();
        await db.execute(sql`
          insert into accounts
            (id, org_id, number, name, type, is_summary, is_active, required_dimensions, custom)
          values (${id}, ${ledger.orgId}, ${number}, ${name}, ${type}, false, true, '[]'::jsonb, '{}'::jsonb)
        `);
        return id;
      };
      await withOrgContext(ledger.orgId, async () => {
        const changed = await db.execute<{ id: string }>(sql`
          update orgs set settings = jsonb_set(
            coalesce(settings, '{}'::jsonb), '{features}',
            coalesce(settings->'features', '{}'::jsonb) ||
              '{"nonprofit":true,"fundAccounting":true,"grantManagement":true}'::jsonb,
            true
          ) where id = ${ledger.orgId} returning id
        `);
        if (changed.rows.length !== 1) throw new Error("the grant conformance organization was not enabled");
        ctx.roles.grantReceivable = await makeAccount("NP-GR-1", "Grant Receivable", "asset_receivable");
        ctx.roles.refundableAdvance = await makeAccount("NP-RA-1", "Refundable Advance", "liability_current_other");
        ctx.roles.grantRevenue = await makeAccount("NP-GR-2", "Grant Revenue", "income");
      });
      const fund = await provisionFundAccounting({
        orgId: ledger.orgId,
        defaultFund: { code: "GRANT-OPS", name: "Grant Operating Fund" },
        classifications: { "GRANT-OPS": { kind: "restricted", restrictionClass: "with_donor_restrictions" } },
        actorId: ledger.actorId,
      });
      const groupId = await withOrgContext(ledger.orgId, async () => {
        const group = await db.execute<{ id: string }>(sql`
          insert into account_groups (org_id, dimension, key, name, match, is_catch_all, is_active)
          values (${ledger.orgId}, 'grant_allowable_costs', 'grant_costs', 'Grant Allowable Costs', '{}'::jsonb, false, true)
          returning id
        `);
        if (!group.rows[0]) throw new Error("the allowable-cost group was not created");
        return group.rows[0].id;
      });
      const accounts: GrantPostingAccounts = {
        bankAccountId: ctx.roles.bank,
        grantsReceivableAccountId: ctx.roles.grantReceivable,
        refundableAdvanceAccountId: ctx.roles.refundableAdvance,
        grantRevenueAccountId: ctx.roles.grantRevenue,
        exchangeReceivableAccountId: ctx.roles.ar,
        exchangeRevenueAccountId: ctx.roles.revenue,
      };
      const grant = await createGrant({
        orgId: ledger.orgId,
        code: "CONF-GRANT-1",
        name: "Community Program Award",
        sponsorPartyId: ledger.customerId,
        sponsorKind: "foundation",
        determination: "contribution_conditional",
        barrier: "Submit the annual program report",
        rightOfReturn: true,
        awardAmount: "100.00",
        periodFrom: "2026-01-01",
        periodTo: "2026-12-31",
        fundId: fund.defaultFundId,
        allowableAccountGroupId: groupId,
        actorId: ledger.actorId,
      });
      await awardGrant({ orgId: ledger.orgId, grantId: grant.id, accounts, postingDate: ledger.date, actorId: ledger.actorId });
      await activateGrant({ orgId: ledger.orgId, grantId: grant.id, actorId: ledger.actorId });
      let drawdownId = "";
      const advance = await capture(ctx, "advance receipt", async () => {
        const drawdown = await recordGrantDrawdown({
          orgId: ledger.orgId,
          grantId: grant.id,
          amount: "100.00",
          kind: "advance",
          accounts,
          postingDate: ledger.date,
          actorId: ledger.actorId,
        });
        drawdownId = drawdown.id;
      });
      await satisfyGrantBarrier({ orgId: ledger.orgId, grantId: grant.id, evidence: "Annual program report accepted by the sponsor.", actorId: ledger.actorId });
      const recognition = await capture(ctx, "barrier satisfaction", async () => {
        await recognizeGrantDrawdown({
          orgId: ledger.orgId,
          drawdownId,
          grantRevenueAccountId: accounts.grantRevenueAccountId,
          refundableAdvanceAccountId: accounts.refundableAdvanceAccountId,
          postingDate: ledger.date,
          actorId: ledger.actorId,
        });
      });
      return { entries: [advance, recognition] };
    },
  },
];
