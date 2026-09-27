import { sql } from "drizzle-orm";
import type { Money } from "../money/brands.ts";
import { addMoney, cmpMoney, negMoney } from "../money/brands.ts";
import { fromUnits, isZero, toUnits } from "../money/money.ts";
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { loadSubsidiaryContext, restrictionAdmits, uuidArray } from "../organization/subsidiaries.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { fundFeatureOff, fundPostingRefusal } from "./errors.ts";
import type { BalancingContext, BalancingLeg, BalancingLegProvider, BalancingLineView } from "../journal/balancing-hooks.ts";

const FUND_KEY = "fund";
const FEATURE_KEY = "fundAccounting";
const FUND_SETUP_REMEDY = "Choose an active fund allowed for this subsidiary under Setup → Accounting → Dimensions.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FundPairView {
  fromFundId: string;
  toFundId: string;
  dueFromAccountId: string;
  dueToAccountId: string;
  isActive?: boolean;
}

export interface FundPostingLine {
  accountId: string;
  amount: string;
  subsidiaryId: string;
  currency: string;
  txnAmount: string;
  fxRate: string;
  fundId: string | null;
}

interface ResidualCell {
  fundId: string;
  subsidiaryId: string;
  amount: Money;
}

interface FlowEdge {
  to: number;
  reverse: number;
  capacity: bigint;
  originalCapacity: bigint;
}

interface PairFlow {
  positiveFundId: string;
  negativeFundId: string;
  pair: FundPairView;
  edge: FlowEdge;
}

function displayFund(fundId: string, fundCodes: ReadonlyMap<string, string>): string {
  return fundCodes.get(fundId) ?? "unclassified fund";
}

function addFlowEdge(graph: FlowEdge[][], from: number, to: number, capacity: bigint): FlowEdge {
  const forward: FlowEdge = {
    to,
    reverse: graph[to]!.length,
    capacity,
    originalCapacity: capacity,
  };
  const reverse: FlowEdge = {
    to: from,
    reverse: graph[from]!.length,
    capacity: 0n,
    originalCapacity: 0n,
  };
  graph[from]!.push(forward);
  graph[to]!.push(reverse);
  return forward;
}

function maximumTransferFlow(graph: FlowEdge[][], source: number, sink: number): void {
  while (true) {
    const previous = new Array<{ node: number; edgeIndex: number } | null>(graph.length).fill(null);
    const queue = [source];
    previous[source] = { node: source, edgeIndex: -1 };
    for (let cursor = 0; cursor < queue.length && previous[sink] === null; cursor += 1) {
      const node = queue[cursor]!;
      for (let edgeIndex = 0; edgeIndex < graph[node]!.length; edgeIndex += 1) {
        const edge = graph[node]![edgeIndex]!;
        if (edge.capacity <= 0n || previous[edge.to] !== null) continue;
        previous[edge.to] = { node, edgeIndex };
        queue.push(edge.to);
        if (edge.to === sink) break;
      }
    }
    if (previous[sink] === null) return;

    let amount: bigint | null = null;
    for (let node = sink; node !== source;) {
      const step = previous[node]!;
      const edge = graph[step.node]![step.edgeIndex]!;
      amount = amount === null || edge.capacity < amount ? edge.capacity : amount;
      node = step.node;
    }
    if (amount === null || amount <= 0n) return;
    for (let node = sink; node !== source;) {
      const step = previous[node]!;
      const edge = graph[step.node]![step.edgeIndex]!;
      edge.capacity -= amount;
      graph[edge.to]![edge.reverse]!.capacity += amount;
      node = step.node;
    }
  }
}

/** Compute deterministic due-to/due-from legs without database access. */
export function interfundLegs(
  lines: readonly FundPostingLine[],
  pairs: readonly FundPairView[],
  fundCodes: ReadonlyMap<string, string>,
  baseCurrencyBySubsidiary: ReadonlyMap<string, string>,
  subsidiaryNames: ReadonlyMap<string, string> = new Map(),
): BalancingLeg[] {
  const cells = new Map<string, ResidualCell>();
  const missingBySubsidiary = new Map<string, Money>();
  for (const line of lines) {
    if (!line.fundId) {
      missingBySubsidiary.set(
        line.subsidiaryId,
        addMoney(missingBySubsidiary.get(line.subsidiaryId) ?? "0", line.amount),
      );
      continue;
    }
    const key = `${line.subsidiaryId}\u0000${line.fundId}`;
    const cell = cells.get(key);
    if (cell) cell.amount = addMoney(cell.amount, line.amount);
    else cells.set(key, { fundId: line.fundId, subsidiaryId: line.subsidiaryId, amount: line.amount as Money });
  }

  const missingResidual = [...missingBySubsidiary.values()].some((amount) => !isZero(amount));
  if (missingResidual) {
    throw fundPostingRefusal({
      message: "A journal entry has an unbalanced line without a fund assignment.",
      code: "fund_missing",
      remedy: "Assign the line to a fund or configure the default fund under Setup → Accounting → Dimensions.",
    });
  }

  const nonzero = [...cells.values()].filter((cell) => !isZero(cell.amount));
  if (nonzero.length <= 1) return [];

  const bySubsidiary = new Map<string, ResidualCell[]>();
  for (const cell of nonzero) {
    const list = bySubsidiary.get(cell.subsidiaryId);
    if (list) list.push(cell);
    else bySubsidiary.set(cell.subsidiaryId, [cell]);
  }

  const activePairs = pairs.filter((pair) => pair.isActive !== false);
  const pairByDirection = new Map<string, FundPairView>();
  for (const pair of [...activePairs].sort((a, b) =>
    `${a.fromFundId}:${a.toFundId}`.localeCompare(`${b.fromFundId}:${b.toFundId}`),
  )) {
    pairByDirection.set(`${pair.fromFundId}\u0000${pair.toFundId}`, pair);
  }

  const legs: BalancingLeg[] = [];
  for (const [subsidiaryId, subsidiaryCells] of [...bySubsidiary.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const subsidiaryTotal = subsidiaryCells.reduce((total, cell) => addMoney(total, cell.amount), "0.0000" as Money);
    if (!isZero(subsidiaryTotal)) {
      const name = subsidiaryNames.get(subsidiaryId) ?? subsidiaryId;
      throw fundPostingRefusal({
        message: `Journal lines for subsidiary "${name}" do not balance before interfund transfers.`,
        code: "subsidiary_unbalanced",
        remedy: "Correct the entry so each subsidiary balances before configuring interfund pairs.",
      });
    }

    const ordered = [...subsidiaryCells].sort((a, b) =>
      displayFund(a.fundId, fundCodes).localeCompare(displayFund(b.fundId, fundCodes)),
    );
    const positive = ordered.filter((cell) => cmpMoney(cell.amount, "0") > 0);
    const negative = ordered.filter((cell) => cmpMoney(cell.amount, "0") < 0);
    if (positive.length === 0 && negative.length === 0) continue;

    const source = 0;
    const positiveOffset = 1;
    const negativeOffset = positiveOffset + positive.length;
    const sink = negativeOffset + negative.length;
    const graph: FlowEdge[][] = Array.from({ length: sink + 1 }, () => []);
    let totalPositive = 0n;
    positive.forEach((cell, index) => {
      const units = toUnits(cell.amount);
      totalPositive += units;
      addFlowEdge(graph, source, positiveOffset + index, units);
    });
    negative.forEach((cell, index) => {
      addFlowEdge(graph, negativeOffset + index, sink, -toUnits(cell.amount));
    });

    const pairFlows: PairFlow[] = [];
    for (let p = 0; p < positive.length; p += 1) {
      for (let n = 0; n < negative.length; n += 1) {
        const positiveFundId = positive[p]!.fundId;
        const negativeFundId = negative[n]!.fundId;
        // The from fund carries the due-from asset; the to fund carries the due-to liability.
        const pair = pairByDirection.get(`${negativeFundId}\u0000${positiveFundId}`);
        if (!pair) continue;
        const edge = addFlowEdge(
          graph,
          positiveOffset + p,
          negativeOffset + n,
          totalPositive,
        );
        pairFlows.push({ positiveFundId, negativeFundId, pair, edge });
      }
    }
    maximumTransferFlow(graph, source, sink);

    const positiveRemainder = positive.map((cell, index) => ({
      cell,
      units: graph[source]![index]!.capacity,
    }));
    if (positiveRemainder.some(({ units }) => units > 0n)) {
      const unmatchedPositive = positiveRemainder.find(({ units }) => units > 0n)!.cell;
      const unmatchedNegative = negative.find((cell) =>
        !pairByDirection.has(`${cell.fundId}\u0000${unmatchedPositive.fundId}`),
      ) ?? negative[0]!;
      const fromCode = displayFund(unmatchedNegative.fundId, fundCodes);
      const toCode = displayFund(unmatchedPositive.fundId, fundCodes);
      throw fundPostingRefusal({
        message: `No active interfund pair connects fund "${fromCode}" to fund "${toCode}".`,
        code: "interfund_pair_missing",
        remedy: "Create the pair under Setup → Nonprofit → Interfund pairs.",
      });
    }

    const baseCurrency = baseCurrencyBySubsidiary.get(subsidiaryId);
    if (!baseCurrency) {
      const name = subsidiaryNames.get(subsidiaryId) ?? subsidiaryId;
      throw fundPostingRefusal({
        message: `The functional currency is unavailable for subsidiary "${name}".`,
        code: "subsidiary_currency_missing",
        remedy: "Configure the subsidiary's functional currency before posting.",
      });
    }

    for (const flow of pairFlows) {
      const amountUnits = flow.edge.originalCapacity - flow.edge.capacity;
      if (amountUnits <= 0n) continue;
      const amount = fromUnits(amountUnits) as Money;
      const pair = flow.pair;
      legs.push(
        {
          accountId: pair.dueFromAccountId,
          amount,
          currency: baseCurrency,
          txnAmount: amount,
          fxRate: "1",
          subsidiaryId,
          extraDims: { [FUND_KEY]: flow.negativeFundId },
          memo: `Interfund due from ${displayFund(flow.positiveFundId, fundCodes)}`,
        },
        {
          accountId: pair.dueToAccountId,
          amount: negMoney(amount),
          currency: baseCurrency,
          txnAmount: negMoney(amount),
          fxRate: "1",
          subsidiaryId,
          extraDims: { [FUND_KEY]: flow.positiveFundId },
          memo: `Interfund due to ${displayFund(flow.negativeFundId, fundCodes)}`,
        },
      );
    }
  }
  return legs;
}

interface FundSegmentLookup {
  segmentId: string;
  defaultValueId: string | null;
  isActive: boolean;
  fundId: string | null;
  fundCode: string | null;
  fundName: string | null;
  fundIsActive: boolean | null;
  restrictionSubsidiaryId: string | null;
  includeChildren: boolean | null;
  isClassified: boolean | null;
}

interface FundPairLookup {
  subsidiaryId: string;
  subsidiaryName: string;
  baseCurrency: string;
  fromFundId: string | null;
  toFundId: string | null;
  dueFromAccountId: string | null;
  dueToAccountId: string | null;
}

function rawFundId(line: BalancingLineView, defaultValueId: string | null): string | null {
  const dims = line.extraDims && typeof line.extraDims === "object" ? line.extraDims : null;
  if (!dims || !Object.prototype.hasOwnProperty.call(dims, FUND_KEY)) return defaultValueId;
  const value = dims[FUND_KEY];
  return typeof value === "string" ? value : value == null ? "null" : String(value);
}

/** Provider registered at the composition root for the generic fund segment. */
export const fundBalancingLegProvider: BalancingLegProvider = async (
  runner: SqlExecutor,
  ctx: BalancingContext,
  lines: readonly BalancingLineView[],
): Promise<readonly BalancingLeg[]> => {
  if (lines.length === 0) return [];
  const explicitIds = [...new Set(lines.flatMap((line) => {
    const dims = line.extraDims && typeof line.extraDims === "object" ? line.extraDims : null;
    const value = dims && Object.prototype.hasOwnProperty.call(dims, FUND_KEY) ? dims[FUND_KEY] : null;
    return typeof value === "string" && UUID_RE.test(value) ? [value] : [];
  }))];

  // One org/key index lookup returns the segment default and every named value's
  // activity, classification, and subsidiary restriction in the same query.
  const lookup = await runner.execute<FundSegmentLookup>(sql`
    with fund_segment as (
      select org_id, id, default_value_id, is_active, feature_key
        from segment_definitions
       where org_id = ${ctx.orgId} and key = ${FUND_KEY} and source_kind = 'custom'
    ), requested_values as (
      select unnest(${uuidArray(explicitIds)}::uuid[]) as id
      union
      select default_value_id from fund_segment where default_value_id is not null
    )
    select fs.id as "segmentId", fs.default_value_id as "defaultValueId",
           fs.is_active as "isActive",
           sv.id as "fundId", sv.code as "fundCode", sv.name as "fundName",
           sv.is_active as "fundIsActive", sv.subsidiary_id as "restrictionSubsidiaryId",
           sv.subsidiary_include_children as "includeChildren",
           (f.id is not null) as "isClassified"
      from fund_segment fs
      left join requested_values rv on true
      left join segment_values sv
        on sv.org_id = fs.org_id and sv.segment_id = fs.id and sv.id = rv.id
      left join funds f on f.org_id = sv.org_id and f.id = sv.id
     order by sv.id
  `);
  const segment = lookup.rows[0];
  if (!segment) return [];

  const defaultValueId = segment.defaultValueId;
  const values = new Map<string, FundSegmentLookup>();
  for (const row of lookup.rows) if (row.fundId) values.set(row.fundId, row);
  const effectiveIds = lines.map((line) => rawFundId(line, defaultValueId));
  const hasNonDefaultFund = effectiveIds.some((fundId) => fundId !== null && fundId !== defaultValueId);
  if (hasNonDefaultFund) {
    if (!(await orgFeatureEnabled(ctx.orgId, FEATURE_KEY, runner))) throw fundFeatureOff();
    await acquireOrgFeatureGateLock(runner, ctx.orgId);
    if (!(await lockAndCheckOrgFeature(runner, ctx.orgId, FEATURE_KEY))) throw fundFeatureOff();
  }

  const lineAssignments = lines.map((line, index) => ({ line, fundId: effectiveIds[index]! }));
  let subsidiaryContext: Awaited<ReturnType<typeof loadSubsidiaryContext>> | undefined;
  for (const { line, fundId } of lineAssignments) {
    if (fundId === null) continue;
    const value = values.get(fundId);
    if (!value) {
      throw fundPostingRefusal({
        message: "A journal line's fund assignment does not reference a fund in this organization.",
        code: "fund_assignment_invalid",
        remedy: FUND_SETUP_REMEDY,
      });
    }
    const fundCode = value.fundCode || value.fundName || "unclassified fund";
    if (!value.fundIsActive) {
      throw fundPostingRefusal({
        message: `Fund "${fundCode}" is inactive and cannot receive postings.`,
        code: "fund_inactive",
        remedy: FUND_SETUP_REMEDY,
      });
    }
    if (!value.isClassified) {
      throw fundPostingRefusal({
        message: `Fund "${fundCode}" has no nonprofit accounting classification.`,
        code: "fund_unclassified",
        remedy: "Complete the fund's accounting classification under Setup → Accounting → Dimensions.",
      });
    }
    if (value.restrictionSubsidiaryId) {
      subsidiaryContext ??= await loadSubsidiaryContext(runner, ctx.orgId);
      if (!restrictionAdmits(
        subsidiaryContext,
        value.restrictionSubsidiaryId,
        value.includeChildren === true,
        line.subsidiaryId,
      )) {
        const restrictedName = subsidiaryContext.byId.get(value.restrictionSubsidiaryId)?.name ?? "another subsidiary";
        const lineName = subsidiaryContext.byId.get(line.subsidiaryId)?.name ?? "the posting subsidiary";
        throw fundPostingRefusal({
          message: `Fund "${fundCode}" is restricted to ${restrictedName} and cannot be posted to ${lineName}.`,
          code: "fund_subsidiary_mismatch",
          remedy: FUND_SETUP_REMEDY,
        });
      }
    }
  }

  const fundCodes = new Map<string, string>();
  for (const [fundId, value] of values) fundCodes.set(fundId, value.fundCode || value.fundName || "unclassified fund");
  const normalizedLines: FundPostingLine[] = lineAssignments.map(({ line, fundId }) => ({
    accountId: line.accountId,
    amount: line.amount,
    subsidiaryId: line.subsidiaryId,
    currency: line.currency,
    txnAmount: line.txnAmount,
    fxRate: line.fxRate,
    fundId,
  }));
  const nonzeroFunds = new Set<string>();
  const residuals = new Map<string, Money>();
  for (const line of normalizedLines) {
    const key = `${line.subsidiaryId}\u0000${line.fundId ?? "<missing>"}`;
    residuals.set(key, addMoney(residuals.get(key) ?? "0", line.amount));
  }
  for (const [key, amount] of residuals) if (!isZero(amount)) nonzeroFunds.add(key);
  if (nonzeroFunds.size <= 1) return [];

  const fundIds = [...new Set([...nonzeroFunds].map((key) => key.slice(key.indexOf("\u0000") + 1)).filter((id) => id !== "<missing>"))];
  const subsidiaryIds = [...new Set([...nonzeroFunds]
    .map((key) => key.slice(0, key.indexOf("\u0000")))
    .filter((id) => UUID_RE.test(id)))];
  const pairLookup = await runner.execute<FundPairLookup>(sql`
    select s.id as "subsidiaryId", s.name as "subsidiaryName", s.base_currency as "baseCurrency",
           p.from_fund_id as "fromFundId", p.to_fund_id as "toFundId",
           p.due_from_account_id as "dueFromAccountId", p.due_to_account_id as "dueToAccountId"
      from subsidiaries s
      left join fund_pairs p
        on p.org_id = s.org_id and p.is_active
       and p.from_fund_id = any(${uuidArray(fundIds)}::uuid[])
       and p.to_fund_id = any(${uuidArray(fundIds)}::uuid[])
     where s.org_id = ${ctx.orgId}
       and s.id = any(${uuidArray(subsidiaryIds)}::uuid[])
     order by s.id, p.from_fund_id, p.to_fund_id
  `);
  const pairs: FundPairView[] = [];
  const baseCurrencyBySubsidiary = new Map<string, string>();
  const subsidiaryNames = new Map<string, string>();
  for (const row of pairLookup.rows) {
    baseCurrencyBySubsidiary.set(row.subsidiaryId, row.baseCurrency);
    subsidiaryNames.set(row.subsidiaryId, row.subsidiaryName);
    if (row.fromFundId && row.toFundId && row.dueFromAccountId && row.dueToAccountId) {
      pairs.push({
        fromFundId: row.fromFundId,
        toFundId: row.toFundId,
        dueFromAccountId: row.dueFromAccountId,
        dueToAccountId: row.dueToAccountId,
        isActive: true,
      });
    }
  }
  return interfundLegs(normalizedLines, pairs, fundCodes, baseCurrencyBySubsidiary, subsidiaryNames);
};
