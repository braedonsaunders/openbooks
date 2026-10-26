import { loadAccounts } from "../../../../lib/setup/ref-options";
import {
  assetCarryingMinor,
  ContractCostError,
  contractCostAttentionItems,
  currencyExponent,
  minorUnitsToCanonical,
  scheduleForAsset,
} from "@openbooks/engine/revenue";
import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { subsidiaryVisibleFilter } from "@openbooks/engine/organization/scope";
import { db } from "@openbooks/engine/platform/database";
import { periodDisplayLabel, periodDisplayLabelSql } from "@openbooks/engine/periods/period-policy";
import { isUuid, mergeHref, pickString } from "../../../../lib/list-params";
import { can, requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import type { ContractCostDrawer } from "./ContractCostDrawer";

type ContractCostDrawerProps = Parameters<typeof ContractCostDrawer>[0];

export interface AssetScheduleRow {
  month: string;
  periodId: string | null;
  /** The covering period labelled in the viewer's locale. */
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
  expenseAccounts: { value: string; label: string }[];
  policy: {
    basis: string;
    practicalExpedient: boolean;
    customerLifeMonths: number | null;
    assetAccountId: string | null;
    amortizationExpenseAccountId: string | null;
  } | null;
  drawerOpen: boolean;
  drawer: ContractCostDrawerProps | null;
  activeView: "attention" | "assets";
  tabs: { href: string; label: string; active?: boolean; count?: number | null }[];
  onAttention: boolean;
  onAssets: boolean;
}

function contractCostAssetVisibility(
  alias: "a" | "asset",
  allowed: ReadonlySet<string> | null,
): SQL {
  if (allowed === null) return sql``;
  const table = sql.raw(alias);
  return sql`and (
    (${table}.revenue_contract_id is not null and exists (
      select 1 from revenue_contracts scoped_contract
       where scoped_contract.org_id = ${table}.org_id
         and scoped_contract.id = ${table}.revenue_contract_id
         ${subsidiaryVisibleFilter(sql`scoped_contract.subsidiary_id`, allowed, { orgWideNull: true })}
    ) or ${table}.capitalize_entry_id is not null and exists (
      select 1 from journal_entries scoped_entry
       where scoped_entry.org_id = ${table}.org_id
         and scoped_entry.id = ${table}.capitalize_entry_id
         ${subsidiaryVisibleFilter(sql`scoped_entry.subsidiary_id`, allowed)}
    ))
    and (${table}.revenue_contract_id is null or exists (
      select 1 from revenue_contracts scoped_contract
       where scoped_contract.org_id = ${table}.org_id
         and scoped_contract.id = ${table}.revenue_contract_id
         ${subsidiaryVisibleFilter(sql`scoped_contract.subsidiary_id`, allowed, { orgWideNull: true })}
    ))
    and (${table}.capitalize_entry_id is null or exists (
      select 1 from journal_entries scoped_entry
       where scoped_entry.org_id = ${table}.org_id
         and scoped_entry.id = ${table}.capitalize_entry_id
         ${subsidiaryVisibleFilter(sql`scoped_entry.subsidiary_id`, allowed)}
    ))
  )`;
}

async function loadAssetPayload(
  assetId: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  locale: string,
): Promise<ContractCostAssetPayload | null> {
  const row = (
    await db.execute<{
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
    }>(
      sql`
    select a.id, a.revenue_contract_id as contract_id, c.contract_number,
           customer.display_name as customer, rep.display_name as sales_rep,
           a.cost_type, a.amount_minor::text, a.currency,
           a.capitalized_on::text, a.amort_start_on::text, a.amort_end_on::text,
           a.method, a.status, a.capitalize_entry_id
      from contract_cost_assets a
      left join revenue_contracts c on c.org_id = a.org_id and c.id = a.revenue_contract_id
       ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
      left join parties customer on customer.org_id = a.org_id and customer.id = a.customer_party_id
      left join parties rep on rep.org_id = a.org_id and rep.id = a.rep_party_id
     where a.org_id = ${orgId} and a.id = ${assetId}
       ${contractCostAssetVisibility("a", allowedSubsidiaryIds)}`,
      "objects",
    )
  )[0];
  if (!row) return null;
  // The asset prices in its own currency through the shared ISO exponent:
  // a missing registry row refuses by name (the registry is read-only, so
  // the remedy is recording in a registry currency), never a 2dp guess
  // that would misprice zero- and three-decimal currencies.
  const exponent = await currencyExponent(db, row.currency);
  const schedule = await scheduleForAsset(db, orgId, assetId);
  const periodNames = new Map(
    (
      await db.execute<{ id: string; name: string }>(
        sql`
      select p.id, ${periodDisplayLabelSql(locale, "p")} as name
        from accounting_periods p where p.org_id = ${orgId}`,
        "objects",
      )
    ).map((p) => [p.id, p.name]),
  );
  const postedByPeriod = new Map(
    (
      await db.execute<{ period_id: string; entry_id: string }>(
        sql`
      select period_id, journal_entry_id as entry_id from contract_cost_amortization
       where org_id = ${orgId} and asset_id = ${assetId}`,
        "objects",
      )
    ).map((r) => [r.period_id, r.entry_id]),
  );
  const entries = await db.execute<{
    id: string;
    origin: string;
    posting_date: string;
    period_name: string;
  }>(
    sql`
    select distinct je.id, je.origin, je.posting_date::text, ${periodDisplayLabelSql(locale, "p")} as period_name
      from journal_entries je
      join journal_lines jl on jl.org_id = je.org_id and jl.entry_id = je.id
      join accounting_books ab on ab.org_id = je.org_id and ab.id = je.book_id and ab.is_primary
      left join accounting_periods p on p.org_id = je.org_id and p.id = je.period_id
     where je.org_id = ${orgId}
       and jl.contributor_kind = 'contract_cost_asset'
       and jl.contributor_ref = ${assetId}
      and je.status in ('posted', 'reversed')
      ${subsidiaryVisibleFilter(sql`je.subsidiary_id`, allowedSubsidiaryIds)}
     order by je.posting_date`,
    "objects",
  );
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
      carrying: minorUnitsToCanonical(
        row.contract_id === null && row.capitalize_entry_id === null
          ? BigInt(row.amount_minor)
          : await assetCarryingMinor(db, orgId, assetId, allowedSubsidiaryIds),
        exponent,
      ),
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
    entries: entries.map((e) => ({
      id: e.id,
      origin: e.origin,
      postingDate: e.posting_date,
      periodName: e.period_name,
    })),
  };
}

export async function loadContractCosts(
  sp: Record<string, string | string[] | undefined>,
): Promise<ContractCostsData> {
  const t = await getTranslations("contractCosts");
  const locale = await getLocale();

  const authz = await requirePermission("contract_costs.read");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "contractCosts");
  const canManage = can(authz, "contract_costs.manage");
  const canApprove = can(authz, "contract_costs.approve");

  const periods = await db.execute<{
    id: string;
    fiscal_year: number;
    period_number: number;
    is_adjustment: boolean;
    starts_on: string;
    ends_on: string;
  }>(
    sql`
    select id, fiscal_year, period_number, is_adjustment, starts_on::text as starts_on, ends_on::text as ends_on
      from accounting_periods p
     where p.org_id = ${orgId} and not p.is_adjustment
       ${
         authz.allowedSubsidiaryIds === null
           ? sql``
           : sql`and exists (
         select 1 from subsidiaries s
          where s.org_id = p.org_id and s.fiscal_calendar_id = p.fiscal_calendar_id
            ${subsidiaryVisibleFilter(sql`s.id`, authz.allowedSubsidiaryIds)}
       )`
       }
     order by p.starts_on desc`,
    "objects",
  );
  const selectedPeriodId =
    typeof sp.period === "string" && isUuid(sp.period) && periods.some((p) => p.id === sp.period)
      ? sp.period
      : (periods[0]?.id ?? null);

  const org = (
    await db.execute<{ base_currency: string }>(
      sql`
    select base_currency from orgs where id = ${orgId}`,
      "objects",
    )
  )[0];
  // The workspace totals in the organization's own base currency — never a
  // USD guess. The column is NOT NULL, so an empty read means this account
  // cannot see the organization at all (missing or out of scope), not that
  // configuration is absent: the remedy is access, never editing a company
  // record the reader cannot see.
  if (!org) {
    throw new ContractCostError("This organization is not available to the current account.", {
      code: "contract_cost_org_unavailable",
      remedy:
        "Sign in with an account that belongs to this organization, or ask an administrator for access, then reopen the contract-cost workspace.",
    });
  }
  const baseCurrency = org.base_currency;
  const exponent = await currencyExponent(db, baseCurrency);

  // The balance includes posted and reversed history so reversals offset
  // their original entries, and reads only the primary book. Scale with
  // numeric power to preserve exact minor units without float exponentiation.
  const balance = (
    await db.execute<{ carrying: string }>(
      sql`
    select coalesce(round(sum(jl.amount * power(10::numeric, cur.minor_units))), 0)::text as carrying
      from journal_lines jl
      join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
      join accounting_books ab on ab.org_id = je.org_id and ab.id = je.book_id and ab.is_primary
      join currencies cur on cur.code = jl.currency
     where jl.org_id = ${orgId}
       and jl.contributor_kind = 'contract_cost_asset'
       and je.status in ('posted', 'reversed')
       ${subsidiaryVisibleFilter(sql`je.subsidiary_id`, authz.allowedSubsidiaryIds)}`,
      "objects",
    )
  )[0];
  const amortized = selectedPeriodId
    ? (
        await db.execute<{ total: string }>(
          sql`
        select coalesce(sum(amort.amount_minor), 0)::text as total
          from contract_cost_amortization amort
          join journal_entries je on je.org_id = amort.org_id and je.id = amort.journal_entry_id
         where amort.org_id = ${orgId} and amort.period_id = ${selectedPeriodId}
           ${subsidiaryVisibleFilter(sql`je.subsidiary_id`, authz.allowedSubsidiaryIds)}
           and exists (
             select 1 from contract_cost_assets a
              where a.org_id = amort.org_id
                and a.id = amort.asset_id
                ${contractCostAssetVisibility("a", authz.allowedSubsidiaryIds)}
           )`,
          "objects",
        )
      )[0]
    : null;

  const activeAssets = Number(
    (
      await db.execute<{ n: string }>(
        sql`
      select count(*)::text as n from contract_cost_assets a
       where a.org_id = ${orgId} and a.status = 'active'
         ${contractCostAssetVisibility("a", authz.allowedSubsidiaryIds)}`,
        "objects",
      )
    )[0]?.n ?? "0",
  );

  const attention: ContractCostAttentionRow[] = (
    await contractCostAttentionItems(db, orgId, authz.allowedSubsidiaryIds)
  ).map((item) => ({
    assetId: item.assetId,
    kind: item.kind,
    contractNumber: item.contractNumber,
    carrying: minorUnitsToCanonical(BigInt(item.carryingMinor), exponent),
    capitalizedOn: item.capitalizedOn,
  }));

  const contracts = await db.execute<{ id: string; number: string; customer: string }>(
    sql`
    select c.id, c.contract_number as number, coalesce(p.display_name, '') as customer
      from revenue_contracts c
      left join parties p on p.org_id = c.org_id and p.id = c.customer_id
     where c.org_id = ${orgId} and c.status = 'active'
       ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
     order by c.contract_number`,
    "objects",
  );

  // The capitalize and import pickers offer the same postable accounts every
  // company-settings picker offers, narrowed to the expense and liability
  // types an original commission expense can sit in.
  const expenseAccounts = (await loadAccounts(orgId, authz.allowedSubsidiaryIds))
    .filter(
      (account) =>
        account.accountType?.startsWith("expense") || account.accountType?.startsWith("liability"),
    )
    .map(({ value, label }) => ({ value, label }));

  const policy =
    (
      await db.execute<{
        basis: string;
        practical_expedient: boolean;
        customer_life_months: number | null;
        asset_account_id: string | null;
        amortization_expense_account_id: string | null;
      }>(
        sql`
    select policy.basis, policy.practical_expedient, policy.customer_life_months,
           asset_account.id as asset_account_id, expense_account.id as amortization_expense_account_id
      from contract_cost_policies policy
      left join accounts asset_account on asset_account.org_id = policy.org_id and asset_account.id = policy.asset_account_id
       ${subsidiaryVisibleFilter(sql`asset_account.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
      left join accounts expense_account on expense_account.org_id = policy.org_id and expense_account.id = policy.amortization_expense_account_id
       ${subsidiaryVisibleFilter(sql`expense_account.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
     where policy.org_id = ${orgId} and policy.effective_from <= current_date
     order by policy.effective_from desc limit 1`,
        "objects",
      )
    )[0] ?? null;

  const assetId = typeof sp.asset === "string" ? sp.asset : undefined;
  const payload =
    assetId && isUuid(assetId)
      ? await loadAssetPayload(assetId, orgId, authz.allowedSubsidiaryIds, locale)
      : null;
  // Attention and assets are sibling views behind URL tabs: one body shows
  // at a time. An open drawer forces its assets list; otherwise attention
  // leads while actionable.
  const requestedView = pickString(sp.view);
  const activeView =
    payload !== null
      ? "assets"
      : requestedView === "assets" || requestedView === "attention"
        ? requestedView
        : attention.length > 0
          ? "attention"
          : "assets";
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
    periods: periods.map((p) => ({
      id: String(p.id),
      name: periodDisplayLabel(
        {
          fiscalYear: Number(p.fiscal_year),
          periodNumber: Number(p.period_number),
          adjustment: p.is_adjustment,
          startsOn: p.starts_on,
          endsOn: p.ends_on,
        },
        locale,
      ),
    })),
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
    activeView,
    tabs: [
      {
        // Sibling views keep the workspace filters (period and the drawer
        // snapshot) so switching never resets the page around the tabs.
        href: mergeHref("/revenue/contract-costs", sp, { view: "attention" }),
        label: t("views.attention"),
        active: activeView === "attention",
        count: attention.length,
      },
      {
        href: mergeHref("/revenue/contract-costs", sp, { view: "assets" }),
        label: t("views.assets"),
        active: activeView === "assets",
      },
    ],
    onAttention: activeView === "attention",
    onAssets: activeView === "assets",
  };
}

const f = ref<ContractCostsData>();

export function contractCostsSpec(data: ContractCostsData): PageSpec {
  return page({
    route: "/revenue/contract-costs",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget("module-home-tabs", { tabs: data.tabs }),
          widget(
            "run-amortization",
            {
              periods: data.periods,
              selectedPeriodId: data.selectedPeriodId,
              activeAssets: data.activeAssets,
            },
            f("canManage"),
          ),
          widget(
            "capitalize-cost",
            {
              contracts: data.contracts,
              expenseAccounts: data.expenseAccounts,
              policy: data.policy,
              baseCurrency: data.baseCurrency,
            },
            f("canManage"),
          ),
          widget(
            "import-commissions",
            {
              contracts: data.contracts,
              expenseAccounts: data.expenseAccounts,
              baseCurrency: data.baseCurrency,
            },
            f("canManage"),
          ),
        ],
      }),
    ],
    body: [
      {
        ...widgetBlock("contract-costs-workspace", {
          assetBalance: data.assetBalance,
          periodAmortized: data.periodAmortized,
          baseCurrency: data.baseCurrency,
          attention: data.attention,
          canManage: data.canManage,
          policy: data.policy,
        }),
        when: f("onAttention"),
      },
      {
        ...widgetBlock("entity-list-view", {
          recordType: "contract_cost_asset",
          sp: data.currentParams,
          drawer: data.drawer
            ? { widget: "contract-cost-drawer", props: { drawer: data.drawer } }
            : null,
        }),
        when: f("onAssets"),
      },
    ],
  });
}
