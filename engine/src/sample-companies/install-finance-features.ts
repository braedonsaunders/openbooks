import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { activateSchedule, createManualSchedule } from "../amortization/schedules.ts";
import { validateTemplateWrite } from "../amortization/templates.ts";
import { createScriptJournal } from "../ledger/journal-writes.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { createBookCurrencyVersion } from "../multibook/settings.ts";
import { registerSetupRefusal } from "../pos/registers.ts";
import { validateRebateTerms, type RebateTerms } from "../revenue/rebate-math.ts";
import { sampleCompanyFeatures } from "./features.ts";
import { installCapTable } from "./install-cap-table.ts";
import { scenarioRecordId, type DemoContext } from "./scenarios.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";

const REASON = "Prepare synthetic industry demonstration for native financial review";

/** The annual premium the prepaid-insurance demonstration releases over twelve months. */
const ANNUAL_PREMIUM = "12000.00";

/**
 * Finance capabilities beyond the authored configuration: authored setup rows
 * pass the same validation their setup screens apply, and every recorded
 * structure, schedule and issuance goes through its domain command.
 */
export async function installFinanceFeatures(c: DemoContext): Promise<void> {
  const f = sampleCompanyFeatures(c.industryKey);
  const id = (table: string, key = "main") => scenarioRecordId(c, table, key);
  if (f.rebateManagement)
    await assertRebateAgreements(c, [
      id("rebate_agreements", "supplier-volume"),
      id("rebate_agreements", "customer-growth"),
    ]);
  if (f.posRegister) {
    const refusal = await registerSetupRefusal(db, c.orgId, {}, id("pos_registers"));
    if (refusal)
      throw new SampleCompanyError(`The demonstration register is not usable: ${refusal}`);
  }
  if (f.multiBookAccounting) await installTaxBook(c, id("accounting_books", "tax-book"));
  if (f.expenseAmortization) await installPrepaidInsurance(c);
  if (f.equity) await installCapTable(c);
}

async function assertRebateAgreements(c: DemoContext, ids: readonly string[]): Promise<void> {
  const agreements = await db.execute<{
    id: string;
    method: RebateTerms["method"];
    tier_basis: RebateTerms["tierBasis"];
    tiers: RebateTerms["tiers"];
    target_unit_cost: string | null;
    margin_percent: string | null;
  }>(
    sql`
    select id, method, tier_basis, tiers, target_unit_cost::text, margin_percent::text from rebate_agreements
     where org_id = ${c.orgId} and id in (${sql.join(
       ids.map((value) => sql`${value}::uuid`),
       sql`, `,
     )})`,
    "objects",
  );
  if (agreements.length !== ids.length)
    throw new SampleCompanyError("The demonstration rebate agreements could not be read back.");
  for (const agreement of agreements) {
    validateRebateTerms({
      method: agreement.method,
      tierBasis: agreement.tier_basis,
      tiers: agreement.tiers,
      targetUnitCost: agreement.target_unit_cost,
      marginPercent: agreement.margin_percent,
    });
  }
}

/** The tax book reports in the entity's functional currency from the start of the year. */
async function installTaxBook(c: DemoContext, bookId: string): Promise<void> {
  const existing = await db.execute(
    sql`select id from accounting_book_currencies where org_id = ${c.orgId} and book_id = ${bookId} and subsidiary_id = ${c.subsidiaryId}`,
    "objects",
  );
  if (existing.length) return;
  await createBookCurrencyVersion({
    orgId: c.orgId,
    actorId: c.actorId,
    allowedSubsidiaryIds: null,
    input: {
      bookId,
      subsidiaryId: c.subsidiaryId,
      currency: c.currency,
      rateType: "spot",
      effectiveFrom: `${c.year}-01-01`,
    },
    reason: "The income tax basis book reports in the entity's functional currency",
  });
}

/**
 * An annual liability policy paid in January, carried in with the months
 * already released, and amortized monthly from the current open period.
 */
async function installPrepaidInsurance(c: DemoContext): Promise<void> {
  const templateId = scenarioRecordId(c, "expense_amortization_templates", "annual-policy");
  const memo = "Annual general liability policy";
  // Member companies keep the schedules their source carried; a master gains a missing one.
  if (c.memberSample) return;
  if (
    (
      await db.execute(
        sql`select id from expense_amortization_schedules where org_id = ${c.orgId} and template_id = ${templateId} and memo = ${memo}`,
        "objects",
      )
    ).length
  )
    return;
  const template = (
    await db.execute<Record<string, unknown>>(
      sql`select * from expense_amortization_templates where org_id = ${c.orgId} and id = ${templateId}`,
      "objects",
    )
  )[0];
  if (!template)
    throw new SampleCompanyError("The demonstration amortization template could not be read back.");
  const refusal = await validateTemplateWrite(db, c.orgId, {}, template);
  if (refusal)
    throw new SampleCompanyError(
      `The demonstration amortization template is not usable: ${refusal}`,
    );
  const operationDate = c.operationDate ?? c.date;
  const policyYear = operationDate.slice(0, 4);
  const elapsedMonths = BigInt(Number(operationDate.slice(5, 7)) - 1);
  const released = fromUnits((toUnits(ANNUAL_PREMIUM) * elapsedMonths) / 12n);
  const unamortized = fromUnits(toUnits(ANNUAL_PREMIUM) - toUnits(released));
  const journal = await createScriptJournal(
    c.orgId,
    c.actorId,
    {
      documentDate: operationDate,
      subsidiaryId: c.subsidiaryId,
      memo: "Unamortized annual liability premium carried in from the prior ledger",
      lines: [
        { accountId: scenarioRecordId(c, "accounts", "prepaid-insurance"), amount: unamortized },
        {
          accountId: scenarioRecordId(c, "accounts", "capital"),
          amount: fromUnits(-toUnits(unamortized)),
        },
      ],
    },
    {
      post: true,
      idempotencyKey: `industry-demo:${c.orgId}:prepaid-insurance`,
      allowedSubsidiaryIds: null,
    },
  );
  if (!journal.entryId || journal.approvalPending)
    throw new SampleCompanyError(
      "Demo preparation cannot approve its own journals. Review the master’s journal approval routing in Flows before retrying preparation.",
    );
  const schedule = await createManualSchedule({
    orgId: c.orgId,
    actorId: c.actorId,
    templateId,
    subsidiaryId: c.subsidiaryId,
    totalAmount: ANNUAL_PREMIUM,
    openingAmortizedAmount: released,
    serviceStartOn: `${policyYear}-01-01`,
    amortizeFromPeriod: `${operationDate.slice(0, 7)}-01`,
    memo,
    reason: REASON,
  });
  await activateSchedule({
    orgId: c.orgId,
    actorId: c.actorId,
    scheduleId: schedule.scheduleId,
    reason: "Release the prepaid premium monthly from the current period",
  });
}
