import {
  assetCarryingMinor,
  contractCostAttentionItems,
  minorUnitsToCanonical,
  scheduleForAsset,
} from '@openbooks/engine/revenue'
import "server-only";

import { getTranslations } from "next-intl/server";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/database";
import { isUuid, pickString } from "../../../../lib/list-params";
import { can, requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import type { ContractCostDrawer } from "./ContractCostDrawer";

type ContractCostDrawerProps = Parameters<typeof ContractCostDrawer>[0];

export interface AssetScheduleRow {
  month: string;
  periodId: string | null;
  periodName: string | null;
  amount: string;
  posted: boolean;
  entryId: string | null;
}

export interface ContractCostAssetPayload {
  asset: {
    id: string;
    contractId: string | null;
    contractNumber: string | null;
    customer: string | null;
    salesRep: string | null;
    costType: string;
    amount: string;
    currency: string;
    capitalizedOn: string;
    amortStartOn: string;
    amortEndOn: string;
    method: string;
    status: string;
    carrying: string;
    capitalizeEntryId: string | null;
  };
  schedule: AssetScheduleRow[];
  entries: { id: string; origin: string; postingDate: string; periodName: string }[];
}

export interface ContractCostAttentionRow {
  assetId: string;
  kind: "unlinked" | "churned";
  contractNumber: string | null;
  carrying: string;
  capitalizedOn: string;
}

export interface ContractCostsData {
  title: string;
  description: string;
  currentParams: Record<string, string | string[] | undefined>;
  canManage: boolean;
  canApprove: boolean;
  baseCurrency: string;
  assetBalance: string;
  periodAmortized: string;
  selectedPeriodId: string | null;
  periods: { id: string; name: string }[];
  activeAssets: number;
  attention: ContractCostAttentionRow[];
  contracts: { id: string; number: string; customer: string }[];
  expenseAccounts: { id: string; code: string; name: string }[];
  policy: {
    basis: string;
    practicalExpedient: boolean;
    customerLifeMonths: number | null;
    assetAccountId: string | null;
    amortizationExpenseAccountId: string | null;
  } | null;
  drawerOpen: boolean;
  drawer: ContractCostDrawerProps | null;
}

async function loadAssetPayload(assetId: string, orgId: string): Promise<ContractCostAssetPayload | null> {
  const row = (await db.execute<{
    id: string;
    contract_id: string | null;
    contract_number: string | null;
    customer: string | null;
    sales_rep: string | null;
    cost_type: string;
    amount_minor: string;
    currency: string;
    capitalized_on: string;
    amort_start_on: string;
    amort_end_on: string;
    method: string;
    status: string;
    capitalize_entry_id: string | null;
  }>(sql`
    select a.id, a.revenue_contract_id as contract_id, c.contract_number,
           customer.display_name as customer, rep.display_name as sales_rep,
           a.cost_type, a.amount_minor::text, a.currency,
           a.capitalized_on::text, a.amort_start_on::text, a.amort_end_on::text,
           a.method, a.status, a.capitalize_entry_id
      from contract_cost_assets a
      left join revenue_contracts c on c.org_id = a.org_id and c.id = a.revenue_contract_id
      left join parties customer on customer.id = a.customer_party_id
      left join parties rep on rep.id = a.rep_party_id
     where a.org_id = ${orgId} and a.id = ${assetId}`)).rows[0];
  if (!row) return null;
  const exponent = (await db.execute<{ minor_units: number }>(sql`
    select minor_units from currencies where code = ${row.currency}`)).rows[0]?.minor_units ?? 2;
  const schedule = await scheduleForAsset(db, orgId, assetId);
  const periodNames = new Map(
    (await db.execute<{ id: string; name: string }>(sql`
      select id, name from accounting_periods where org_id = ${orgId}`)).rows.map((p) => [p.id, p.name]),
  );
  const postedByPeriod = new Map(
    (await db.execute<{ period_id: string; entry_id: string }>(sql`
      select period_id, journal_entry_id as entry_id from contract_cost_amortization
       where org_id = ${orgId} and asset_id = ${assetId}`)).rows.map((r) => [r.period_id, r.entry_id]),
  );
  const entries = (await db.execute<{ id: string; origin: string; posting_date: string; period_name: string }>(sql`
    select distinct je.id, je.origin, je.posting_date::text, p.name as period_name
      from journal_entries je
      join journal_lines jl on jl.org_id = je.org_id and jl.entry_id = je.id
      left join accounting_periods p on p.org_id = je.org_id and p.id = je.period_id
     where je.org_id = ${orgId}
       and jl.contributor_kind = 'contract_cost_asset'
       and jl.contributor_ref = ${assetId}
       and je.status in ('posted', 'reversed')
     order by je.posting_date`)).rows;
  return {
    asset: {
      id: row.id,
      contractId: row.contract_id,
      contractNumber: row.contract_number,
      customer: row.customer,
      salesRep: row.sales_rep,
      costType: row.cost_type,
      amount: minorUnitsToCanonical(BigInt(row.amount_minor), exponent),
      currency: row.currency,
      capitalizedOn: row.capitalized_on,
      amortStartOn: row.amort_start_on,
      amortEndOn: row.amort_end_on,
      method: row.method,
      status: row.status,
      carrying: minorUnitsToCanonical(await assetCarryingMinor(db, orgId, assetId), exponent),
      capitalizeEntryId: row.capitalize_entry_id,
    },
    schedule: schedule.map((line) => ({
      month: line.month,
      periodId: line.periodId,
      periodName: line.periodId ? (periodNames.get(line.periodId) ?? null) : null,
      amount: minorUnitsToCanonical(line.amountMinor, exponent),
      posted: line.periodId ? postedByPeriod.has(line.periodId) : false,
      entryId: line.periodId ? (postedByPeriod.get(line.periodId) ?? null) : null,
    })),
    entries: entries.map((e) => ({ id: e.id, origin: e.origin, postingDate: e.posting_date, periodName: e.period_name })),
  };
}

export async function loadContractCosts(
  sp: Record<string, string | string[] | undefined>,
): Promise<ContractCostsData> {
  const t = await getTranslations("contractCosts");

  const authz = await requirePermission("contract_costs.read");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "contractCosts");
  const canManage = can(authz, "contract_costs.manage");
  const canApprove = can(authz, "contract_costs.approve");

  const periods = (await db.execute<{ id: string; name: string }>(sql`
    select id, name from accounting_periods
     where org_id = ${orgId} and not is_adjustment
     order by starts_on desc`)).rows;
  const selectedPeriodId =
    typeof sp.period === "string" && isUuid(sp.period) && periods.some((p) => p.id === sp.period)
      ? sp.period
      : (periods[0]?.id ?? null);

  const org = (await db.execute<{ base_currency: string }>(sql`
    select base_currency from orgs where id = ${orgId}`)).rows[0];
  const baseCurrency = org?.base_currency ?? "USD";
  const exponent = (await db.execute<{ minor_units: number }>(sql`
    select minor_units from currencies where code = ${baseCurrency}`)).rows[0]?.minor_units ?? 2;

  // The balance in minor units, summed in SQL: every tagged asset leg posts
  // in the organization base currency (the engine refuses the rest), so one
  // exponent converts the whole carrying amount with no float anywhere.
  const balance = (await db.execute<{ carrying: string }>(sql`
    select coalesce(sum((jl.amount * (10 ^ cur.minor_units))::bigint), 0)::text as carrying
      from journal_lines jl
      join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
      join currencies cur on cur.code = jl.currency
     where jl.org_id = ${orgId}
       and jl.contributor_kind = 'contract_cost_asset'
       and je.status in ('posted', 'reversed')`)).rows[0];
  const amortized = selectedPeriodId
    ? (await db.execute<{ total: string }>(sql`
        select coalesce(sum(amount_minor), 0)::text as total
          from contract_cost_amortization
         where org_id = ${orgId} and period_id = ${selectedPeriodId}`)).rows[0]
    : null;

  const activeAssets = Number(
    (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from contract_cost_assets
       where org_id = ${orgId} and status = 'active'`)).rows[0]?.n ?? "0",
  );

  const attention: ContractCostAttentionRow[] = (
    await contractCostAttentionItems(db, orgId)
  ).map((item) => ({
    assetId: item.assetId,
    kind: item.kind,
    contractNumber: item.contractNumber,
    carrying: minorUnitsToCanonical(BigInt(item.carryingMinor), exponent),
    capitalizedOn: item.capitalizedOn,
  }));

  const contracts = (await db.execute<{ id: string; number: string; customer: string }>(sql`
    select c.id, c.contract_number as number, coalesce(p.display_name, '') as customer
      from revenue_contracts c
      left join parties p on p.id = c.customer_id
     where c.org_id = ${orgId} and c.status = 'active'
     order by c.contract_number`)).rows;

  const expenseAccounts = (await db.execute<{ id: string; code: string; name: string }>(sql`
    select a.id, a.code, a.name
      from accounts a
      join account_types t on t.code = a.type
     where a.org_id = ${orgId} and a.is_posting and t.category in ('expense', 'liability')
     order by a.code`)).rows;

  const policy = (await db.execute<{
    basis: string;
    practical_expedient: boolean;
    customer_life_months: number | null;
    asset_account_id: string | null;
    amortization_expense_account_id: string | null;
  }>(sql`
    select basis, practical_expedient, customer_life_months,
           asset_account_id, amortization_expense_account_id
      from contract_cost_policies
     where org_id = ${orgId} and effective_from <= current_date
     order by effective_from desc limit 1`)).rows[0] ?? null;

  const assetId = typeof sp.asset === "string" ? sp.asset : undefined;
  const payload = assetId && isUuid(assetId) ? await loadAssetPayload(assetId, orgId) : null;
  const requestedReturn = pickString(sp.drawerReturn);

  const drawer: ContractCostDrawerProps | null = payload
    ? {
        payload,
        canManage,
        canApprove,
        contracts,
        policy,
        baseCurrency,
        closeHref: requestedReturn?.startsWith("/revenue/contract-costs")
          ? requestedReturn
          : "/revenue/contract-costs",
      }
    : null;

  return {
    title: t("workspace.title"),
    description: t("workspace.description"),
    currentParams: sp,
    canManage,
    canApprove,
    baseCurrency,
    assetBalance: minorUnitsToCanonical(BigInt(balance?.carrying ?? "0"), exponent),
    periodAmortized: minorUnitsToCanonical(BigInt(amortized?.total ?? "0"), exponent),
    selectedPeriodId,
    periods: periods.map((p) => ({ id: String(p.id), name: p.name })),
    activeAssets,
    attention,
    contracts,
    expenseAccounts,
    policy: policy
      ? {
          basis: policy.basis,
          practicalExpedient: policy.practical_expedient,
          customerLifeMonths: policy.customer_life_months,
          assetAccountId: policy.asset_account_id,
          amortizationExpenseAccountId: policy.amortization_expense_account_id,
        }
      : null,
    drawerOpen: Boolean(drawer),
    drawer,
  };
}

const f = ref<ContractCostsData>();

export function contractCostsSpec(data: ContractCostsData): PageSpec {
  return page({
    route: '/revenue/contract-costs',
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget("run-amortization", {
            periods: data.periods,
            selectedPeriodId: data.selectedPeriodId,
            activeAssets: data.activeAssets,
          }, f("canManage")),
          widget("capitalize-cost", {
            contracts: data.contracts,
            expenseAccounts: data.expenseAccounts,
            policy: data.policy,
            baseCurrency: data.baseCurrency,
          }, f("canManage")),
          widget("import-commissions", {
            contracts: data.contracts,
            expenseAccounts: data.expenseAccounts,
            baseCurrency: data.baseCurrency,
          }, f("canManage")),
        ],
      }),
    ],
    body: [
      widgetBlock("contract-costs-workspace", {
        assetBalance: data.assetBalance,
        periodAmortized: data.periodAmortized,
        baseCurrency: data.baseCurrency,
        attention: data.attention,
        canManage: data.canManage,
        policy: data.policy,
      }),
      widgetBlock("entity-list-view", {
        recordType: "contract_cost_asset",
        sp: data.currentParams,
        drawer: data.drawer
          ? { widget: "contract-cost-drawer", props: { drawer: data.drawer } }
          : null,
      }),
    ],
  });
}
