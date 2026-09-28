import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../../composition/install.ts";
import { postEntry } from "../../journal/post-entry.ts";
import { neg } from "../../money/money.ts";
import { createFund, setFundPair } from "../../nonprofit/funds.ts";
import { setFramework } from "../../nonprofit/frameworks.ts";
import { provisionFundAccounting } from "../../nonprofit/provision.ts";
import { createFundRelease, submitFundRelease } from "../../nonprofit/releases.ts";
import { db, withOrgContext, withOrgTransaction } from "../../platform/db.ts";
import { capture } from "../ledger-helpers.ts";
import type { CaseContext, ConformanceCase } from "../types.ts";

const RELEASE_AMOUNT = "125.0000";
const SUPPORT_AMOUNT = "250.0000";

interface ReleaseScenario {
  id: string;
  title: string;
  standard: "ASC 958" | "FRS 102";
  reference: string;
  requirement: string;
  assertion: string;
  framework: "us_asc958" | "ew_sorp_frs102";
  fromClass: string;
  toClass: string;
  fromCode: string;
  toCode: string;
}

async function runRelease(ctx: CaseContext, scenario: ReleaseScenario) {
  const ledger = ctx.ledger!;
  return withOrgContext(ledger.orgId, async () => {
    installEngineSeams();
    const enabled = await db.execute<{ id: string }>(sql`
      update orgs set settings = jsonb_set(
        coalesce(settings, '{}'::jsonb), '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"nonprofit":true,"fundAccounting":true}'::jsonb,
        true
      ) where id = ${ledger.orgId} returning id
    `);
    if (!enabled.rows[0]?.id) throw new Error("nonprofit features were not enabled in the conformance tenant");
    const setup = await provisionFundAccounting({
      orgId: ledger.orgId,
      defaultFund: { code: scenario.toCode, name: "Unrestricted Fund" },
      classifications: { [scenario.toCode]: { kind: "operating", restrictionClass: scenario.toClass } },
      actorId: ledger.actorId,
    });
    const source = await createFund({
      orgId: ledger.orgId,
      code: scenario.fromCode,
      name: "Restricted Fund",
      kind: "restricted",
      restrictionClass: scenario.fromClass,
      actorId: ledger.actorId,
    });
    await setFramework({
      orgId: ledger.orgId, framework: scenario.framework, actorId: ledger.actorId,
      reason: "Conformance fixture framework selection",
    });
    await setFundPair({
      orgId: ledger.orgId, fromFundId: setup.defaultFundId, toFundId: source.id,
      dueFromAccountId: ctx.roles.ar, dueToAccountId: ctx.roles.ap, actorId: ledger.actorId,
      reason: "Settle opening-balance postings between the operating and source funds",
    });
    const opening = await withOrgTransaction(ledger.orgId, () => postEntry(db, {
      orgId: ledger.orgId, bookId: ledger.bookId, subsidiaryId: ledger.subsidiaryId,
      entryNumber: `FUND-OPEN-${randomUUID()}`, postingDate: ledger.date, periodId: ledger.periodId,
      currency: "CAD", actorId: ledger.actorId, origin: "journal", memo: "Restricted fund support",
      lines: [
        { accountId: ctx.roles.bank, amount: SUPPORT_AMOUNT, extraDims: { fund: source.id } },
        { accountId: ctx.roles.revenue, amount: neg(SUPPORT_AMOUNT), extraDims: { fund: source.id } },
      ],
    }));
    if (!opening.entryId) throw new Error("opening support was not posted");
    let entryId = "";
    const movement = await capture(ctx, "fund release", async () => {
      const draft = await createFundRelease({
        orgId: ledger.orgId, fromFundId: source.id, toFundId: setup.defaultFundId,
        releaseAccountId: ctx.roles.revenue, releaseDate: ledger.date, amount: RELEASE_AMOUNT,
        purpose: "Restriction satisfied", satisfactionRef: "Award obligations fulfilled",
        actorId: ledger.actorId,
      });
      const posted = await submitFundRelease({ orgId: ledger.orgId, releaseId: draft.id, actorId: ledger.actorId });
      if (!posted.postedEntryId) throw new Error("the release did not identify its posted journal entry");
      entryId = posted.postedEntryId;
    });
    const amounts = (await db.execute<{ fund: string; amount: string }>(sql`
      select extra_dims->>'fund' as fund, sum(amount)::text as amount
        from journal_lines
       where org_id = ${ledger.orgId} and entry_id = ${entryId} and account_id = ${ctx.roles.revenue}
       group by extra_dims->>'fund'
    `)).rows;
    return {
      entries: [movement],
      values: {
        fromFundMovement: amounts.find((row) => row.fund === source.id)?.amount ?? "0",
        toFundMovement: amounts.find((row) => row.fund === setup.defaultFundId)?.amount ?? "0",
      },
    };
  });
}

const releaseScenarios: readonly ReleaseScenario[] = [
  {
    id: "np-release",
    title: "A satisfied donor restriction moves the recorded amount between net asset classes",
    standard: "ASC 958",
    reference: "958-205/225",
    requirement: "A satisfied donor restriction is reclassified between net asset classes, with the release presented gross in the statement of activities.",
    assertion: "A release posts once, and the ledger shows the full amount leaving the restricted fund and entering the unrestricted fund.",
    framework: "us_asc958",
    fromClass: "with_donor_restrictions",
    toClass: "without_donor_restrictions",
    fromCode: "RESTRICTED",
    toCode: "UNRESTRICTED",
  },
  {
    id: "np-sorp-fund-classes",
    title: "A restricted fund release reconciles between Charities SORP classes",
    standard: "FRS 102",
    reference: "Charities SORP: statement of financial activities",
    requirement: "Movements between restricted and unrestricted funds are reported and reconcile to the fund balances.",
    assertion: "The release reduces restricted fund resources and increases unrestricted resources by the same exact amount.",
    framework: "ew_sorp_frs102",
    fromClass: "restricted",
    toClass: "unrestricted",
    fromCode: "RESTRICTED",
    toCode: "UNRESTRICTED",
  },
];

const INTERFUND_MOVEMENT = {
  entries: [{ step: "fund release", lines: [
    { role: "ar" as const, amount: RELEASE_AMOUNT },
    { role: "ap" as const, amount: "-125.0000" },
  ] }],
  values: { fromFundMovement: RELEASE_AMOUNT, toFundMovement: "-125.0000" },
};

export const NONPROFIT_CASES: readonly ConformanceCase[] = releaseScenarios.map((scenario) => ({
  id: scenario.id,
  title: scenario.title,
  citations: [{
    standard: scenario.standard,
    reference: scenario.reference,
    kind: "requirement",
    requirement: scenario.requirement,
  }],
  support: "supported",
  tier: "ledger",
  assertion: scenario.assertion,
  facts: [
    `The organization uses ${scenario.framework}.`,
    "The restricted fund has 250.0000 of posted net assets and the restriction is satisfied.",
    "The release is 125.0000 and its signed class movements reconcile exactly.",
  ],
  expected: INTERFUND_MOVEMENT,
  run: (ctx) => runRelease(ctx, scenario),
}));
