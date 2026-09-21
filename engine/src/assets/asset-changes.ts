import { assetGroupHistory } from "../organization/asset-group-history.ts";
import {
  measureGroupComponent,
  transferGroupComponent,
  type GroupComponentInput,
} from "./group-component.ts";
import { lockAssetTaxLifecycle } from "../organization/asset-tax-fence.ts";
import {
  type GroupAssetValuation,
  type GroupAssetCounterfactual,
} from "../money/asset-group-plan.ts";
import { type DatedDepreciation } from "../money/depreciation-plan.ts";
import { applyAssetReversal } from "./asset-change-reversals.ts";
import {
  intercompanyBalancingLegs,
  loadSubsidiaryContext,
} from "../organization/subsidiaries.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  db,
  withOrg,
  withTransactionSavepoint,
  type SqlExecutor,
} from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { assertFinancialChangeAccess } from "../organization/financial-change-access.ts";
import {
  assertFinancialChangeApproved,
  completeFinancialChange,
  existingFinancialChange,
  loadFinancialChange,
  proposeFinancialChange,
} from "../platform/financial-changes.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import {
  add,
  cmp,
  fromUnits,
  mulRatio,
  mulRate,
  neg,
  toUnits,
} from "../money/money.ts";
import { assetBasisDelta, measurePartialDisposal } from "./asset-basis.ts";
import {
  assertAssetPostingDate,
  assertLifecyclePostingPolicy,
  computeDisposal,
  lockAssetRow,
  netRemeasurementDelta,
  postAssetLifecycleEntry,
} from "./asset-lifecycle.ts";
import {
  assetDepreciationCalendar,
  buildScheduleWithRunner,
  reconcileAssetDepreciationStatusWithRunner,
  resolveAssetAccounts,
} from "./depreciation.ts";

export interface AssetChangeInput {
  operation: "partial_disposal" | "intercompany_transfer";
  effectiveOn: string;
  reason: string;
  idempotencyKey: string;
  assessment: string;
  /** The homogeneous fraction must be justified; separately identified parts
   * use exact book-specific cost/accumulated/residual measurements. */
  portion:
    | { percent: string }
    | {
        books: {
          bookId: string;
          cost: string;
          accumulated: string;
          salvage: string;
          remainingProductionUnits?: string;
          group?: GroupComponentInput;
        }[];
      };
  proceeds: string;
  proceedsAccountId: string;
  transfer?: {
    subsidiaryId: string;
    categoryId: string;
    assetNumber: string;
    name: string;
    buyerAmount: string;
    buyerSalvage: string;
    buyerProductionUnits?: string;
    lifeMonths: number;
    payableAccountId: string;
    eliminationSubsidiaryId: string;
    sellerToGroupRate: string;
    buyerToGroupRate: string;
    sellerToBuyerRate: string;
    ctaAccountId: string;
    groupAssetAccountId: string;
    groupAccumulatedAccountId: string;
    groupDepreciationAccountId: string;
    groupGainLossAccountId: string;
    taxRatePercent: string;
    deferredTaxAccountId: string;
    taxExpenseAccountId: string;
    exchangeRateEvidence: string;
    groupAssessment: string;
    groupPlans?: {
      bookId: string;
      lines: { date: string; amount: string }[];
    }[];
  };
}
type Asset = {
  id: string;
  asset_number: string;
  status: string;
  subsidiary_id: string;
  category_id: string;
  acquired_on: string;
  in_service_on: string;
  acquisition_cost: string;
  salvage_value: string;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  asset_account_id: string | null;
  accumulated_depreciation_account_id: string | null;
  depreciation_expense_account_id: string | null;
  updated_at: string;
};
type Category = {
  id: string;
  default_method: string;
  asset_account_id: string;
  accumulated_depreciation_account_id: string;
  depreciation_expense_account_id: string;
  gain_loss_account_id: string | null;
  is_active: boolean;
};
type Book = {
  id: string;
  name: string;
  posts_gl: boolean;
  is_active: boolean;
  is_primary: boolean;
};
function exact(value: string, label: string): string {
  const n = canonicalDecimal(value, 4);
  if (
    n === null ||
    n.replace(/^-/, "").split(".")[0]!.replace(/^0+/, "").length > 15 ||
    toUnits(n) < 0n
  )
    throw new Error(`${label} must be a non-negative exact ledger amount`);
  return fromUnits(toUnits(n));
}
function validate(input: AssetChangeInput) {
  if (!isIsoCalendarDate(input.effectiveOn))
    throw new Error("effective date must be a calendar date");
  if (input.assessment.trim().length < 8)
    throw new Error(
      "document the component identification and carrying-value assessment",
    );
  exact(input.proceeds, "proceeds");
  if (
    "books" in input.portion &&
    new Set(input.portion.books.map((b) => b.bookId)).size !==
      input.portion.books.length
  )
    throw new Error("supply one component measurement per accounting book");
  if (
    input.transfer?.groupPlans &&
    new Set(input.transfer.groupPlans.map((b) => b.bookId)).size !==
      input.transfer.groupPlans.length
  )
    throw new Error("supply one group depreciation plan per accounting book");
  if (input.operation === "intercompany_transfer") {
    const t = input.transfer;
    if (!t) throw new Error("record the receiving entity and asset terms");
    exact(t.buyerAmount, "buyer acquisition cost");
    exact(t.buyerSalvage, "buyer residual value");
    if (
      t.buyerProductionUnits !== undefined &&
      cmp(
        exact(t.buyerProductionUnits, "receiving production capacity"),
        "0",
      ) <= 0
    )
      throw new Error("receiving production capacity must be positive");
    for (const [label, value] of [
      ["seller-to-group rate", t.sellerToGroupRate],
      ["buyer-to-group rate", t.buyerToGroupRate],
      ["seller-to-buyer rate", t.sellerToBuyerRate],
    ])
      if (
        canonicalDecimal(value, 10) === null ||
        BigInt(value!.replace(".", "")) <= 0n
      )
        throw new Error(`${label} must be an exact positive exchange rate`);
    if (toUnits(exact(t.taxRatePercent, "deferred-tax rate")) > toUnits("100"))
      throw new Error("deferred-tax rate cannot exceed 100 percent");
    if (cmp(mulRate(input.proceeds, t.sellerToBuyerRate), t.buyerAmount) !== 0)
      throw new Error(
        "seller-to-buyer rate must exactly price the agreed buyer consideration",
      );
    if (
      cmp(t.buyerAmount, t.buyerSalvage) < 0 ||
      cmp(t.buyerAmount, "0") <= 0 ||
      cmp(input.proceeds, "0") <= 0
    )
      throw new Error(
        "an intercompany sale requires positive consideration and a residual value no greater than buyer cost",
      );
    if (
      !Number.isInteger(t.lifeMonths) ||
      t.lifeMonths < 1 ||
      t.lifeMonths > 1200
    )
      throw new Error(
        "receiving useful life must be between 1 and 1,200 months",
      );
    if (
      !t.assetNumber.trim() ||
      !t.name.trim() ||
      t.exchangeRateEvidence.trim().length < 8 ||
      t.groupAssessment.trim().length < 8
    )
      throw new Error(
        "record the receiving asset identity, exchange-rate evidence and group accounting assessment",
      );
  } else if (input.transfer)
    throw new Error("receiving terms belong to an intercompany transfer");
}
async function access(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  subsidiaryIds: string[],
  transfer: boolean,
) {
  await assertFinancialChangeAccess(tx, {
    orgId,
    actorId,
    subsidiaryIds,
    permission: "assets.manage",
    feature: "fixedAssets",
  });
  if (transfer)
    await assertFinancialChangeAccess(tx, {
      orgId,
      actorId,
      subsidiaryIds,
      permission: "assets.manage",
      feature: "multiSubsidiary",
    });
}
async function snapshot(
  tx: SqlExecutor,
  orgId: string,
  assetId: string,
  actorId: string,
  input: AssetChangeInput,
) {
  await lockAssetRow(tx, orgId, assetId);
  const asset = (
    await tx.execute<Asset>(
      sql`select *,acquired_on::text,in_service_on::text,updated_at::text from fixed_assets where org_id=${orgId} and id=${assetId}`,
    )
  ).rows[0]!;
  const entities = (
    await tx.execute<{
      id: string;
      base_currency: string;
      parent_id: string | null;
      is_active: boolean;
      is_elimination: boolean;
    }>(
      sql`select id,base_currency,parent_id,is_active,is_elimination from subsidiaries where org_id=${orgId} order by id for share`,
    )
  ).rows;
  const seller = entities.find((s) => s.id === asset.subsidiary_id),
    buyer = input.transfer
      ? entities.find((s) => s.id === input.transfer!.subsidiaryId)
      : undefined;
  if (
    !seller?.is_active ||
    seller.is_elimination ||
    !["in_service", "fully_depreciated"].includes(asset.status)
  )
    throw new Error(
      "the disposing asset must be in service in an active operating entity",
    );
  if (
    input.transfer &&
    (!buyer?.is_active || buyer.is_elimination || buyer.id === seller.id)
  )
    throw new Error("select another active operating entity as the buyer");
  const elimination = input.transfer
    ? entities.find((s) => s.id === input.transfer!.eliminationSubsidiaryId)
    : undefined;
  if (
    input.transfer &&
    (!elimination?.is_active || !elimination.is_elimination)
  )
    throw new Error("select the active group elimination entity");
  const groupScope = (
    await tx.execute<{ elimination_subsidiary_id: string }>(
      sql`select distinct elimination_subsidiary_id from asset_transfer_bases where org_id=${orgId} and receiving_asset_id=${assetId} and reversed_by_change_id is null order by elimination_subsidiary_id`,
    )
  ).rows.map((r) => r.elimination_subsidiary_id);
  const requiredSubsidiaryIds = [
    ...new Set([
      seller.id,
      ...groupScope,
      ...(buyer ? [buyer.id] : []),
      ...(elimination ? [elimination.id] : []),
    ]),
  ];
  await access(
    tx,
    orgId,
    actorId,
    requiredSubsidiaryIds,
    !!buyer || groupScope.length > 0,
  );
  const category = (
    await tx.execute<Category>(
      sql`select * from asset_categories where org_id=${orgId} and id=${asset.category_id}`,
    )
  ).rows[0]!;
  const accounts = resolveAssetAccounts(
    {
      assetAccountId: asset.asset_account_id,
      accumulatedDepreciationAccountId:
        asset.accumulated_depreciation_account_id,
      depreciationExpenseAccountId: asset.depreciation_expense_account_id,
    },
    {
      assetAccountId: category.asset_account_id,
      accumulatedDepreciationAccountId:
        category.accumulated_depreciation_account_id,
      depreciationExpenseAccountId: category.depreciation_expense_account_id,
    },
  );
  if (!category.gain_loss_account_id)
    throw new Error(
      "configure the asset category gain/loss account before proposing a disposal",
    );
  const books = (
    await tx.execute<Book>(
      sql`select id,name,posts_gl,is_active,is_primary from accounting_books where org_id=${orgId} and (is_active or exists(select 1 from depreciation_schedules s where s.org_id=${orgId} and s.book_id=accounting_books.id and s.asset_id=${assetId})) order by id for share`,
    )
  ).rows;
  if (
    books.filter((b) => b.is_primary && b.is_active && b.posts_gl).length !== 1
  )
    throw new Error("configure one active primary posting book");
  if (
    "books" in input.portion &&
    input.portion.books.some((p) => !books.some((b) => b.id === p.bookId))
  )
    throw new Error("component measurements name a book outside this asset");
  if (
    input.transfer?.groupPlans?.some(
      (p) => !books.some((b) => b.id === p.bookId),
    )
  )
    throw new Error("group depreciation plan names a book outside this asset");
  const schedules = (
    await tx.execute<{
      id: string;
      book_id: string;
      method: string;
      units_total: string | null;
    }>(
      sql`select id,book_id,method,units_total::text from depreciation_schedules where org_id=${orgId} and asset_id=${assetId} order by book_id for update`,
    )
  ).rows;
  const lines = (
    await tx.execute<{
      id: string;
      book_id: string;
      source: string;
      planned_amount: string;
      posted_amount: string | null;
      starts_on: string;
      ends_on: string;
      journal_entry_id: string | null;
    }>(
      sql`select l.id,s.book_id,l.source,l.planned_amount::text,l.posted_amount::text,p.starts_on::text,p.ends_on::text,l.journal_entry_id from depreciation_schedule_lines l join depreciation_schedules s on s.id=l.schedule_id and s.org_id=l.org_id join accounting_periods p on p.id=l.period_id and p.org_id=l.org_id where l.org_id=${orgId} and s.asset_id=${assetId} order by s.book_id,p.starts_on,l.sequence,l.id for update of l`,
    )
  ).rows;
  type AssetChangePreview = ReturnType<typeof measurePartialDisposal> & {
    bookId: string;
    calendarId: string;
    bookName: string;
    postsGl: boolean;
    stub: string;
    unitsBefore: string | null;
    unitsRemaining: string | null;
    depreciableBefore: string;
    groupPlan: { startsOn: string; date: string; amount: string }[];
    impairmentReleased: string;
    lines: ReturnType<typeof computeDisposal>["lines"];
  };
  const previews: AssetChangePreview[] = [];
  for (const book of books) {
    if (!book.is_active)
      throw new Error(
        `activate accounting book ${book.name} before changing the asset basis in every book`,
      );
    if (!schedules.some((s) => s.book_id === book.id))
      throw new Error(
        `build the asset depreciation schedule for ${book.name} before proposing this change`,
      );
    await assertAssetPostingDate(
      tx,
      orgId,
      assetId,
      book.id,
      input.effectiveOn,
    );
    const bookLines = lines.filter((l) => l.book_id === book.id);
    const calendarId = await assetDepreciationCalendar(
      tx,
      orgId,
      assetId,
      book.id,
    );
    const bookPeriods = (
      await tx.execute<{ starts_on: string; ends_on: string }>(
        sql`select starts_on::text,ends_on::text from accounting_periods where org_id=${orgId} and fiscal_calendar_id=${calendarId} and not is_adjustment and ends_on>=${input.effectiveOn} order by starts_on for share`,
      )
    ).rows;
    const overdue = bookLines.find(
      (l) => l.posted_amount === null && l.ends_on < input.effectiveOn,
    );
    if (overdue)
      throw new Error(
        `run depreciation for ${book.name} through ${overdue.ends_on} before proposing this change`,
      );
    const futurePosted = bookLines.find(
      (l) => l.posted_amount !== null && l.ends_on >= input.effectiveOn,
    );
    if (futurePosted)
      throw new Error(
        `depreciation in ${book.name} already includes service through ${futurePosted.ends_on}; use an effective date after that retained history`,
      );
    const futureInputs = bookLines.find(
      (l) => l.posted_amount === null && l.source !== "formula",
    );
    if (futureInputs)
      throw new Error(
        `post or replace the recorded ${futureInputs.source} depreciation input in ${book.name} before changing its basis`,
      );
    const values = (
      await tx.execute<{ cost: string; accumulated: string; salvage: string }>(
        sql`select cost::text,accumulated::text,salvage::text from asset_book_carrying_values where org_id=${orgId} and asset_id=${assetId} and book_id=${book.id}`,
      )
    ).rows[0]!;
    const basis = await assetBasisDelta(tx, orgId, assetId, book.id);
    const oldValuation = await netRemeasurementDelta(
      orgId,
      assetId,
      book.id,
      tx,
    );
    const netImpairment = add(neg(oldValuation), neg(basis.impairmentReleased));
    const current = bookLines.find(
      (l) =>
        l.posted_amount === null &&
        l.starts_on <= input.effectiveOn &&
        l.ends_on >= input.effectiveOn,
    );
    let stub = "0.0000";
    if (current) {
      const start = [
        current.starts_on,
        asset.in_service_on,
        basis.cutoff ?? current.starts_on,
      ]
        .sort()
        .at(-1)!;
      const end = Date.parse(current.ends_on + "T00:00:00Z") + 86400000;
      const elapsed =
        Date.parse(input.effectiveOn + "T00:00:00Z") -
        Date.parse(start + "T00:00:00Z");
      if (elapsed > 0)
        stub = mulRatio(
          current.planned_amount,
          BigInt(elapsed),
          BigInt(end - Date.parse(start + "T00:00:00Z")),
        );
    }
    const portion =
      "percent" in input.portion
        ? input.portion
        : input.portion.books.find((p) => p.bookId === book.id);
    if (!portion)
      throw new Error(
        `supply the identified component carrying amounts for ${book.name}`,
      );
    const measurement = measurePartialDisposal({
      ...values,
      accumulated: add(values.accumulated, stub),
      proceeds: input.proceeds,
      portion,
    });
    const disposal = computeDisposal({
      cost: measurement.removedCost,
      accumulated: measurement.removedAccumulated,
      proceeds: input.proceeds,
      accounts: {
        ...accounts,
        gainLossAccountId: category.gain_loss_account_id,
        proceedsAccountId: input.proceedsAccountId,
      },
    });
    await assertLifecyclePostingPolicy(tx, orgId, asset, disposal.lines);
    const groupDepreciable = add(
      measurement.removedCarrying,
      neg(measurement.removedSalvage),
    );
    let future = bookLines
      .filter((l) => l.posted_amount === null)
      .map((l) => ({
        startsOn:
          l.starts_on < input.effectiveOn ? input.effectiveOn : l.starts_on,
        date: l.ends_on,
        amount:
          l.id === current?.id
            ? add(l.planned_amount, neg(stub))
            : l.planned_amount,
      }));
    const suppliedPlan = input.transfer?.groupPlans?.find(
      (p) => p.bookId === book.id,
    );
    if (suppliedPlan) {
      let priorDate = "";
      for (const l of suppliedPlan.lines) {
        if (l.date <= priorDate)
          throw new Error(
            "group depreciation plan must list distinct accounting period ends in order",
          );
        priorDate = l.date;
        if (!isIsoCalendarDate(l.date) || l.date < input.effectiveOn)
          throw new Error(
            "group depreciation dates must be on or after transfer",
          );
        exact(l.amount, "group depreciation");
      }
      future = suppliedPlan.lines.map((l) => {
        const period = bookPeriods.find((p) => p.ends_on === l.date);
        if (!period)
          throw new Error(
            "group depreciation must name the configured book period end",
          );
        return {
          ...l,
          startsOn:
            period.starts_on < input.effectiveOn
              ? input.effectiveOn
              : period.starts_on,
        };
      });
    }
    const futureTotal = future.reduce((a, l) => add(a, l.amount), "0");
    if (
      input.transfer &&
      groupScope.length === 0 &&
      cmp(
        futureTotal,
        suppliedPlan
          ? groupDepreciable
          : add(
              add(values.cost, neg(values.accumulated)),
              neg(add(values.salvage, stub)),
            ),
      ) !== 0
    )
      throw new Error(
        `build the complete remaining depreciation plan in ${book.name} before transferring depreciable carrying value`,
      );
    let allocated = "0";
    const groupPlan = future.map((l, i) => {
      const amount =
        i === future.length - 1
          ? add(groupDepreciable, neg(allocated))
          : mulRatio(
              groupDepreciable,
              toUnits(l.amount),
              toUnits(futureTotal) || 1n,
            );
      allocated = add(allocated, amount);
      return { startsOn: l.startsOn, date: l.date, amount };
    });
    let unitsBefore: string | null = null,
      unitsRemaining: string | null = null;
    const schedule = schedules.find((s) => s.book_id === book.id)!;
    if (schedule.method === "units_of_production") {
      const used = (
        await tx.execute<{ amount: string }>(
          sql`select coalesce(sum(i.production_units),0)::text as amount from depreciation_inputs i join accounting_periods p on p.org_id=i.org_id and p.id=i.period_id where i.org_id=${orgId} and i.schedule_id=${schedule.id} and i.voided_at is null ${basis.cutoff ? sql`and p.ends_on>=${basis.cutoff}` : sql``}`,
        )
      ).rows[0]!.amount;
      const total = basis.unitsRemaining ?? schedule.units_total;
      if (total === null)
        throw new Error(
          `configure expected production capacity for ${book.name}`,
        );
      unitsBefore = add(total, neg(used));
      if (cmp(unitsBefore, "0") < 0)
        throw new Error("recorded production exceeds the asset capacity");
      unitsRemaining = measurement.full
        ? "0"
        : "percent" in input.portion
          ? mulRatio(
              unitsBefore,
              toUnits(measurement.remainingCost),
              toUnits(values.cost),
            )
          : "remainingProductionUnits" in portion &&
              portion.remainingProductionUnits !== undefined
            ? exact(
                portion.remainingProductionUnits,
                "remaining production capacity",
              )
            : null;
      if (unitsRemaining === null)
        throw new Error(
          `supply the identified component's remaining production capacity for ${book.name}`,
        );
      if (
        cmp(unitsRemaining, unitsBefore) > 0 ||
        (!measurement.full && cmp(unitsRemaining, "0") <= 0)
      )
        throw new Error(
          "partial disposal must retain positive production capacity no greater than the pre-disposal remainder",
        );
    }
    previews.push({
      bookId: book.id,
      calendarId,
      bookName: book.name,
      postsGl: book.posts_gl,
      stub,
      unitsBefore,
      unitsRemaining,
      depreciableBefore: add(
        add(values.cost, neg(values.accumulated)),
        neg(values.salvage),
      ),
      ...measurement,
      groupPlan,
      impairmentReleased:
        cmp(netImpairment, "0") > 0
          ? mulRatio(
              netImpairment,
              toUnits(measurement.removedCost),
              toUnits(values.cost),
            )
          : "0.0000",
      lines: disposal.lines,
    });
  }
  if (previews.some((p) => p.full !== previews[0]!.full))
    throw new Error(
      "all books must identify the same physical portion as fully or partially disposed",
    );
  let buyerCategory: Category | null = null;
  if (input.transfer && buyer) {
    if (
      seller.base_currency === elimination!.base_currency &&
      BigInt(
        input.transfer.sellerToGroupRate.split(".")[0]! +
          (input.transfer.sellerToGroupRate.split(".")[1] ?? "").padEnd(
            10,
            "0",
          ),
      ) !== 10000000000n
    )
      throw new Error("same-currency seller-to-group rate must be one");
    if (
      buyer.base_currency === elimination!.base_currency &&
      BigInt(
        input.transfer.buyerToGroupRate.split(".")[0]! +
          (input.transfer.buyerToGroupRate.split(".")[1] ?? "").padEnd(10, "0"),
      ) !== 10000000000n
    )
      throw new Error("same-currency buyer-to-group rate must be one");
    if (
      cmp(
        mulRate(input.proceeds, input.transfer.sellerToGroupRate),
        mulRate(input.transfer.buyerAmount, input.transfer.buyerToGroupRate),
      ) !== 0
    )
      throw new Error(
        "approved exchange rates must translate both sides of the transfer consideration to the same group amount",
      );
    await assertLifecyclePostingPolicy(
      tx,
      orgId,
      {
        subsidiary_id: elimination!.id,
        department_id: null,
        project_id: null,
        location_id: null,
      },
      [
        input.transfer.groupAssetAccountId,
        input.transfer.groupAccumulatedAccountId,
        input.transfer.groupDepreciationAccountId,
        input.transfer.groupGainLossAccountId,
        input.transfer.deferredTaxAccountId,
        input.transfer.taxExpenseAccountId,
        input.transfer.ctaAccountId,
      ].map((accountId) => ({ accountId, amount: "0" })),
    );
    buyerCategory =
      (
        await tx.execute<Category>(
          sql`select * from asset_categories where org_id=${orgId} and id=${input.transfer!.categoryId} for update`,
        )
      ).rows[0] ?? null;
    if (!buyerCategory?.is_active)
      throw new Error("select an active receiving asset category");
    if (
      buyerCategory.default_method === "units_of_production" &&
      !input.transfer.buyerProductionUnits
    )
      throw new Error(
        "supply the receiving asset production capacity for its units-of-production category",
      );
    // The existing intercompany pair is authoritative; transaction fields are
    // an operator confirmation of it, never another configurable relationship.
    await tx.execute(
      sql`select id from intercompany_pairs where org_id=${orgId} and is_active and ((from_subsidiary_id=${seller.id} and to_subsidiary_id=${buyer.id}) or (from_subsidiary_id=${buyer.id} and to_subsidiary_id=${seller.id})) for share`,
    );
    const pairLegs = await intercompanyBalancingLegs(tx, {
      orgId,
      ctx: await loadSubsidiaryContext(tx, orgId),
      originSubId: seller.id,
      originFxRate: "1",
      lines: [
        {
          accountId: accounts.assetAccountId,
          subsidiaryId: seller.id,
          amount: neg(input.proceeds),
          txnAmount: neg(input.proceeds),
          currency: seller.base_currency,
          fxRate: "1",
        },
        {
          accountId: buyerCategory.asset_account_id,
          subsidiaryId: buyer.id,
          amount: input.transfer.buyerAmount,
          txnAmount: input.proceeds,
          currency: seller.base_currency,
          fxRate: input.transfer.sellerToBuyerRate,
        },
      ],
    });
    if (
      pairLegs.find((l) => l.subsidiaryId === seller.id)?.accountId !==
        input.proceedsAccountId ||
      pairLegs.find((l) => l.subsidiaryId === buyer.id)?.accountId !==
        input.transfer.payableAccountId
    )
      throw new Error(
        "use the intercompany accounts configured for these entities under Setup → Subsidiaries",
      );
    if (
      seller.base_currency === buyer.base_currency &&
      cmp(input.proceeds, input.transfer.buyerAmount) !== 0
    )
      throw new Error(
        "same-currency seller proceeds and buyer cost must agree",
      );
    const duplicate = (
      await tx.execute(
        sql`select id from fixed_assets where org_id=${orgId} and asset_number=${input.transfer.assetNumber.trim()}`,
      )
    ).rows[0];
    if (duplicate)
      throw new Error(
        "the receiving asset number is already in use; choose an unused asset number",
      );
    await assertLifecyclePostingPolicy(
      tx,
      orgId,
      {
        subsidiary_id: buyer.id,
        department_id: null,
        project_id: null,
        location_id: null,
      },
      [
        {
          accountId: buyerCategory.asset_account_id,
          amount: input.transfer.buyerAmount,
        },
        {
          accountId: input.transfer.payableAccountId,
          amount: neg(input.transfer.buyerAmount),
        },
      ],
    );
  }
  const lineage = (id: string) => {
    const ids: string[] = [];
    let node = entities.find((e) => e.id === id);
    while (node && node.id !== elimination?.parent_id) {
      if (ids.includes(node.id))
        throw new Error("the consolidation hierarchy contains a cycle");
      ids.push(node.id);
      node = entities.find((e) => e.id === node!.parent_id);
    }
    if (input.transfer && !node)
      throw new Error(
        "both asset owners must belong to the selected consolidation group",
      );
    return ids;
  };
  const sellerPath = input.transfer ? lineage(seller.id) : [],
    buyerPath = input.transfer ? lineage(buyer!.id) : [];
  const pathIds = [...new Set([...sellerPath, ...buyerPath])];
  const ownership = input.transfer
    ? (
        await tx.execute<{
          subsidiary_id: string;
          method: string;
          ownership_percent: string;
          nci_equity_account_id: string | null;
          nci_income_account_id: string | null;
        }>(
          sql`select subsidiary_id,method,ownership_percent::text,nci_equity_account_id,nci_income_account_id from subsidiary_ownership_interests where org_id=${orgId} and is_active and effective_from<=${input.effectiveOn} and (effective_to is null or effective_to>=${input.effectiveOn}) order by subsidiary_id for share`,
        )
      ).rows.filter((p) => pathIds.includes(p.subsidiary_id))
    : [];
  if (ownership.some((p) => p.method !== "full"))
    throw new Error(
      "the transfer requires full control throughout both ownership paths; an associate or joint venture uses its separate-book disposal and acquisition plus ownership-method consolidation",
    );
  if (
    input.transfer &&
    (
      await tx.execute(
        sql`select 1 from consolidation_control_losses where org_id=${orgId} and reversed_by_change_id is null and effective_on<${input.effectiveOn} and exists(select 1 from jsonb_array_elements_text(excluded_subsidiary_ids) sub(id) where sub.id in(select jsonb_array_elements_text(${JSON.stringify(pathIds)}::jsonb))) limit 1`,
      )
    ).rows.length
  )
    throw new Error(
      "an asset owner is outside the controlled group after its disposal; this is not an internal group transfer",
    );
  const nci: {
    percent: string;
    ownershipPath: string[];
    equityAccountId: string;
    incomeAccountId: string;
  }[] = [];
  const ownershipPath: string[] = [];
  for (const subsidiaryId of sellerPath) {
    const policy = ownership.find((p) => p.subsidiary_id === subsidiaryId);
    const percent = policy?.ownership_percent ?? "100";
    if (cmp(percent, "100") < 0) {
      if (!policy?.nci_equity_account_id || !policy.nci_income_account_id)
        throw new Error(
          "configure non-controlling equity and income accounts throughout the selling ownership path",
        );
      nci.push({
        percent: add("100", neg(percent)),
        ownershipPath: [...ownershipPath],
        equityAccountId: policy.nci_equity_account_id,
        incomeAccountId: policy.nci_income_account_id,
      });
    }
    ownershipPath.push(percent);
  }
  const predecessors = (
    await tx.execute<{
      id: string;
      book_id: string;
      basis: {
        groupCost: string;
        groupAccumulated: string;
        groupSalvage: string;
        groupPlan: DatedDepreciation[];
        groupUnimpaired?: GroupAssetCounterfactual;
        buyerCost: string;
        buyerToGroupRate: string;
      };
      elimination_subsidiary_id: string;
      group_currency: string;
    }>(
      sql`select id,book_id,basis,elimination_subsidiary_id,group_currency from asset_transfer_bases where org_id=${orgId} and receiving_asset_id=${assetId} order by book_id for share`,
    )
  ).rows;
  const predecessorValuations: Record<string, GroupAssetValuation[]> = {};
  const groupComponents: Record<string, GroupAssetValuation> = {};
  for (const predecessor of predecessors) {
    const unresolved = (
      await tx.execute(
        sql`select 1 from asset_events v join journal_entries e on e.org_id=v.org_id and e.id=v.journal_entry_id where v.org_id=${orgId} and v.asset_id=${assetId} and e.book_id=${predecessor.book_id} and v.kind in('impaired','revalued') and e.status='posted' and not exists(select 1 from asset_events r where r.org_id=v.org_id and r.reverses_event_id=v.id) and not exists(select 1 from asset_transfer_measurements m where m.org_id=v.org_id and m.source_event_id=v.id) limit 1`,
      )
    ).rows;
    if (unresolved.length)
      throw new Error(
        "record and approve the receiving asset Group valuation before disposing or transferring its changed group basis",
      );
    predecessorValuations[predecessor.book_id] = await assetGroupHistory(
      tx,
      orgId,
      predecessor.id,
      input.effectiveOn,
    );
    const preview = previews.find((p) => p.bookId === predecessor.book_id)!;
    const identified =
      "books" in input.portion
        ? input.portion.books.find((b) => b.bookId === predecessor.book_id)
        : undefined;
    if (identified && !identified.group)
      throw new Error(
        "record the identified component's group cost, accumulated depreciation, residual value and retained service in the asset change's Group component section",
      );
    const periods = (
      await tx.execute<{ starts_on: string; ends_on: string }>(
        sql`select starts_on::text,ends_on::text from accounting_periods where org_id=${orgId} and fiscal_calendar_id=${preview.calendarId} and not is_adjustment and ends_on>=${input.effectiveOn} order by starts_on`,
      )
    ).rows;
    groupComponents[predecessor.book_id] = measureGroupComponent({
      basis: predecessor.basis,
      history: predecessorValuations[predecessor.book_id]!,
      effectiveOn: input.effectiveOn,
      originalBuyerCost: asset.acquisition_cost,
      buyerCostBefore: add(preview.remainingCost, preview.removedCost),
      removedBuyerCost: preview.removedCost,
      identified: identified?.group,
      onward: !!input.transfer,
      periods,
    });
  }
  if (
    "books" in input.portion &&
    input.portion.books.some(
      (b) => b.group && !predecessors.some((p) => p.book_id === b.bookId),
    )
  )
    throw new Error(
      "group component evidence requires a received intercompany asset in that accounting book",
    );
  return {
    predecessors,
    predecessorValuations,
    groupComponents,
    ownership,
    nci,
    asset,
    seller,
    buyer: buyer ?? null,
    elimination: elimination ?? null,
    category,
    accounts,
    books,
    schedules,
    lines,
    previews,
    buyerCategory,
    requiredSubsidiaryIds,
  };
}
export async function proposeAssetChange(
  orgId: string,
  assetId: string,
  actorId: string,
  input: AssetChangeInput,
): Promise<string> {
  validate(input);
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const tx = db;
      const identity = (
        await tx.execute<{ subsidiary_id: string }>(
          sql`select subsidiary_id from fixed_assets where org_id=${orgId} and id=${assetId}`,
        )
      ).rows[0];
      if (!identity) throw new Error("asset not found");
      const groupScope = (
        await tx.execute<{ elimination_subsidiary_id: string }>(
          sql`select distinct elimination_subsidiary_id from asset_transfer_bases where org_id=${orgId} and receiving_asset_id=${assetId} and reversed_by_change_id is null order by elimination_subsidiary_id`,
        )
      ).rows.map((r) => r.elimination_subsidiary_id);
      const required = [
        ...new Set([
          identity.subsidiary_id,
          ...groupScope,
          ...(input.transfer
            ? [
                input.transfer.subsidiaryId,
                input.transfer.eliminationSubsidiaryId,
              ]
            : []),
        ]),
      ];
      await access(
        tx,
        orgId,
        actorId,
        required,
        !!input.transfer || groupScope.length > 0,
      );
      const args = {
        orgId,
        subsidiaryId: identity.subsidiary_id,
        domain: "asset" as const,
        subjectId: assetId,
        operation: input.operation,
        effectiveOn: input.effectiveOn,
        reason: input.reason,
        actorId,
        idempotencyKey: input.idempotencyKey,
        payload: { ...input, requiredSubsidiaryIds: required },
      };
      const previous = await existingFinancialChange(tx, args);
      if (previous) return previous;
      const before = await snapshot(tx, orgId, assetId, actorId, input);
      return proposeFinancialChange(tx, { ...args, beforeState: before });
    }),
  );
}
export async function applyAssetChange(
  orgId: string,
  changeId: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const tx = db,
        change = await loadFinancialChange(tx, orgId, changeId);
      if (change.domain !== "asset")
        throw new Error("this is not an asset change");
      if (change.operation === "reversal")
        return applyAssetReversal(orgId, changeId, actorId);
      await lockAssetTaxLifecycle(
        tx,
        orgId,
        change.payload.requiredSubsidiaryIds as string[],
      );
      const input = change.payload as unknown as AssetChangeInput;
      validate(input);
      await access(
        tx,
        orgId,
        actorId,
        change.payload.requiredSubsidiaryIds as string[],
        !!input.transfer ||
          (change.payload.requiredSubsidiaryIds as string[]).length > 1,
      );
      if (change.status === "applied") return change.result!;
      const state = await snapshot(
        tx,
        orgId,
        change.subject_id,
        actorId,
        input,
      );
      assertFinancialChangeApproved(change, {
        domain: "asset",
        subjectId: change.subject_id,
        beforeState: state,
      });
      // The independent decision must cover BOTH legal entities, not merely the
      // seller used as the common workflow header.
      const approverScope = await actorAllowedSubsidiaryIds(
        tx,
        orgId,
        change.approved_by!,
      );
      if (
        approverScope &&
        state.requiredSubsidiaryIds.some((id) => !approverScope.has(id))
      )
        throw new Error(
          "the independent approver no longer has access to every affected legal entity; obtain a new approval",
        );
      const entries: string[] = [];
      for (const preview of state.previews) {
        const shared = {
          orgId,
          actorId,
          bookId: preview.bookId,
          calendarId: preview.calendarId,
          date: input.effectiveOn,
          asset: state.asset,
          currency: state.seller.base_currency,
        };
        const stubId = preview.postsGl
          ? await postAssetLifecycleEntry(tx, {
              ...shared,
              number: `AST-${changeId}-${preview.bookId}-STUB`,
              memo: `Elapsed depreciation before ${input.operation}: ${input.reason}`,
              origin: "depreciation",
              lines: [
                {
                  accountId: state.accounts.depreciationExpenseAccountId,
                  amount: preview.stub,
                },
                {
                  accountId: state.accounts.accumulatedDepreciationAccountId,
                  amount: neg(preview.stub),
                },
              ],
            })
          : null;
        const entryId = preview.postsGl
          ? await postAssetLifecycleEntry(tx, {
              ...shared,
              number: `AST-${changeId}-${preview.bookId}`,
              memo: `${input.operation}: ${input.reason}`,
              lines: preview.lines,
            })
          : null;
        if (stubId) entries.push(stubId);
        if (entryId) entries.push(entryId);
        await tx.execute(
          sql`insert into asset_basis_changes(org_id,asset_id,book_id,change_id,effective_on,cost_delta,accumulated_delta,salvage_delta,impairment_released,units_remaining,depreciable_after,journal_entry_id,stub_journal_entry_id,group_component,created_by) values(${orgId},${change.subject_id},${preview.bookId},${changeId},${input.effectiveOn},${neg(preview.removedCost)},${add(preview.stub, neg(preview.removedAccumulated))},${neg(preview.removedSalvage)},${preview.impairmentReleased},${preview.unitsRemaining},${add(add(preview.remainingCost, neg(preview.remainingAccumulated)), neg(preview.remainingSalvage))},${entryId},${stubId},${state.groupComponents[preview.bookId] ? JSON.stringify(state.groupComponents[preview.bookId]) : null}::jsonb,${actorId})`,
        );
        await tx.execute(
          sql`insert into asset_events(org_id,asset_id,kind,occurred_on,amount,journal_entry_id,book_id,financial_change_id,memo,created_by,updated_by) values(${orgId},${change.subject_id},${input.transfer ? "transferred" : preview.full ? "disposed" : "partially_disposed"},${input.effectiveOn},${input.proceeds},${entryId},${preview.bookId},${changeId},${`${preview.full ? "Full" : "Partial"} ${input.operation}: ${input.reason}`},${actorId},${actorId})`,
        );
      }
      const full = state.previews[0]!.full;
      if (full) {
        const updated = await tx.execute(
          sql`update fixed_assets set status='disposed',updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${change.subject_id} and status in('in_service','fully_depreciated') returning id`,
        );
        if (updated.rows.length !== 1)
          throw new Error("asset disposal state was not recorded");
      } else
        for (const preview of state.previews) {
          const rebuilt = await buildScheduleWithRunner(
            tx,
            change.subject_id,
            orgId,
            actorId,
            preview.bookId,
          );
          if (rebuilt.skippedMonths.length)
            throw new Error(
              `create accounting periods through ${rebuilt.skippedMonths.at(-1)} before applying this asset change`,
            );
        }
      let receivingAssetId: string | null = null;
      if (input.transfer && state.buyer && state.buyerCategory) {
        receivingAssetId = randomUUID();
        const t = input.transfer,
          c = state.buyerCategory;
        const inserted = await tx.execute(
          sql`insert into fixed_assets(id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,salvage_value,useful_life_months,depreciation_units_total,transferred_from_asset_id,created_by,updated_by) values(${receivingAssetId},${orgId},${state.buyer.id},${c.id},${t.assetNumber.trim()},${t.name.trim()},'in_service',${input.effectiveOn},${input.effectiveOn},${t.buyerAmount},${t.buyerSalvage},${t.lifeMonths},${t.buyerProductionUnits ?? null},${change.subject_id},${actorId},${actorId}) returning id`,
        );
        if (inserted.rows.length !== 1)
          throw new Error("receiving asset was not created");
        for (const preview of state.previews) {
          const entryId = preview.postsGl
            ? await postAssetLifecycleEntry(tx, {
                orgId,
                actorId,
                bookId: preview.bookId,
                date: input.effectiveOn,
                asset: {
                  subsidiary_id: state.buyer.id,
                  department_id: null,
                  project_id: null,
                  location_id: null,
                },
                currency: state.buyer.base_currency,
                origin: "intercompany",
                number: `AST-${changeId}-${preview.bookId}-BUY`,
                memo: `Intercompany asset acquisition: ${input.reason}`,
                lines: [
                  { accountId: c.asset_account_id, amount: t.buyerAmount },
                  {
                    accountId: t.payableAccountId,
                    amount: neg(t.buyerAmount),
                    currency: state.seller.base_currency,
                    txnAmount: neg(input.proceeds),
                    fxRate: t.sellerToBuyerRate,
                  },
                ],
              })
            : null;
          if (entryId) entries.push(entryId);
          await tx.execute(
            sql`insert into asset_events(org_id,asset_id,kind,occurred_on,amount,journal_entry_id,book_id,financial_change_id,memo,created_by,updated_by) values(${orgId},${receivingAssetId},'acquired',${input.effectiveOn},${t.buyerAmount},${entryId},${preview.bookId},${changeId},${input.reason},${actorId},${actorId})`,
          );
          let groupCost = mulRate(preview.removedCost, t.sellerToGroupRate),
            groupAccumulated = mulRate(
              preview.removedAccumulated,
              t.sellerToGroupRate,
            ),
            groupSalvage = mulRate(preview.removedSalvage, t.sellerToGroupRate),
            groupPlan = preview.groupPlan.map((l) => ({
              ...l,
              amount: mulRate(l.amount, t.sellerToGroupRate),
            }));
          let groupUnimpaired: GroupAssetCounterfactual | undefined;
          const predecessor = state.predecessors.find(
            (p) => p.book_id === preview.bookId,
          );
          if (predecessor) {
            if (
              predecessor.elimination_subsidiary_id !==
                t.eliminationSubsidiaryId ||
              predecessor.group_currency !== state.elimination!.base_currency
            )
              throw new Error(
                "an onward transfer must retain its existing group consolidation currency and elimination entity",
              );
            const component = state.groupComponents[preview.bookId]!;
            const transferred = transferGroupComponent(
              component,
              predecessor.basis.buyerToGroupRate,
              t.sellerToGroupRate,
            );
            groupCost = transferred.groupCost;
            groupAccumulated = transferred.groupAccumulated;
            groupSalvage = transferred.groupSalvage;
            groupPlan = transferred.groupPlan;
            groupUnimpaired = transferred.groupUnimpaired;
          }
          await tx.execute(
            sql`insert into asset_transfer_bases(org_id,change_id,source_asset_id,receiving_asset_id,book_id,effective_on,seller_subsidiary_id,buyer_subsidiary_id,elimination_subsidiary_id,group_currency,basis,created_by) values(${orgId},${changeId},${change.subject_id},${receivingAssetId},${preview.bookId},${input.effectiveOn},${state.seller.id},${state.buyer.id},${t.eliminationSubsidiaryId},${state.elimination!.base_currency},${JSON.stringify({ groupCost, groupAccumulated, groupSalvage, groupPlan, groupUnimpaired, nci: state.nci, buyerCost: mulRate(t.buyerAmount, t.buyerToGroupRate), buyerToGroupRate: t.buyerToGroupRate, ctaAccountId: t.ctaAccountId, groupAssetAccountId: t.groupAssetAccountId, groupAccumulatedAccountId: t.groupAccumulatedAccountId, groupDepreciationAccountId: t.groupDepreciationAccountId, groupGainLossAccountId: t.groupGainLossAccountId, taxRatePercent: t.taxRatePercent, deferredTaxAccountId: t.deferredTaxAccountId, taxExpenseAccountId: t.taxExpenseAccountId })}::jsonb,${actorId})`,
          );
          const rebuilt = await buildScheduleWithRunner(
            tx,
            receivingAssetId,
            orgId,
            actorId,
            preview.bookId,
          );
          if (rebuilt.skippedMonths.length)
            throw new Error(
              `create receiving depreciation periods through ${rebuilt.skippedMonths.at(-1)} before applying this transfer`,
            );
        }
      }
      await reconcileAssetDepreciationStatusWithRunner(
        tx,
        orgId,
        actorId,
        change.subject_id,
      );
      const result = {
        assetId: change.subject_id,
        receivingAssetId,
        entryIds: entries,
        full,
      };
      await completeFinancialChange(tx, orgId, changeId, actorId, result);
      return result;
    }),
  );
}
