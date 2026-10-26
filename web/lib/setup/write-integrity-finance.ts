import "server-only";
import { isUuid } from "../list-params";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/platform/db";
import type { SetupEntity } from "./registry";
import {
  hasNonUuidEntry,
  INTEGRITY_CONTINUES,
  uuidArrayParam,
  type SetupIntegrityVerdict,
} from "./write-shared";

/** Ordered setup integrity rules: Segments, subsidiaries, intercompany pairs, payment cards, ownership interests, exchange rates, rate-book assignments and consolidation groups. */
export async function validateFinanceIntegrity(
  entity: SetupEntity,
  body: Record<string, unknown>,
  orgId: string,
  rowId: string | undefined,
  executor: SqlExecutor,
): Promise<SetupIntegrityVerdict> {
  if (entity.key === "segment-definitions") {
    const key = String(body.key ?? "");
    if (!rowId && !/^[a-z][a-z0-9_]{0,62}$/.test(key)) {
      return "The key must start with a lowercase letter and contain only lowercase letters, numbers, and underscores";
    }
    if (rowId) {
      const existing = await executor.execute(
        sql`
        select source_kind from segment_definitions where id = ${rowId} and org_id = ${orgId}`,
        "objects",
      );
      if (!existing[0]) return "not found";
    }
  }

  if (entity.key === "segment-values") {
    const existing = rowId
      ? (
          await executor.execute(
            sql`
          select segment_id, parent_id from segment_values where id = ${rowId} and org_id = ${orgId}`,
            "objects",
          )
        )[0]
      : null;
    if (rowId && !existing) return "not found";
    const segmentId = String(body.segmentId ?? existing?.segment_id ?? "");
    if (!isUuid(segmentId)) return "Values can only be created for a custom segment";
    const segment = await executor.execute(
      sql`
      select id, is_hierarchical from segment_definitions
       where id = ${segmentId} and org_id = ${orgId} and source_kind = 'custom'`,
      "objects",
    );
    if (!segment[0]) return "Values can only be created for a custom segment";
    const parentId =
      body.parentId === undefined ? (existing?.parent_id ?? null) : body.parentId || null;
    if (parentId) {
      if (!segment[0].is_hierarchical) return "This segment is not hierarchical";
      if (!isUuid(String(parentId))) return "Choose a parent value from the same segment";
      const parent = await executor.execute(
        sql`
        select id from segment_values where id = ${String(parentId)} and org_id = ${orgId}
         and segment_id = ${segmentId}`,
        "objects",
      );
      if (!parent[0]) return "Choose a parent value from the same segment";
      if (rowId) {
        // This is the early, user-facing check. segment_value_guard repeats it
        // after taking the per-tenant/per-segment storage fence, which closes
        // the concurrent cross-reparent window for this route and every other
        // writer (bulk import and direct SQL included).
        const cycle = await executor.execute(
          sql`
          with recursive descendants as (
            select id from segment_values
             where id = ${rowId} and org_id = ${orgId} and segment_id = ${segmentId}
            union
            select value.id from segment_values value
            join descendants descendant on value.parent_id = descendant.id
             where value.org_id = ${orgId} and value.segment_id = ${segmentId}
          ) select 1 from descendants where id = ${String(parentId)} limit 1`,
          "objects",
        );
        if (cycle.length) return "A segment value cannot be parented beneath itself";
      }
    }
  }

  if (entity.key === "subsidiaries") {
    const existing = rowId
      ? ((
          await executor.execute<{
            id: string;
            parent_id: string | null;
            is_active: boolean;
            is_elimination: boolean;
          }>(
            sql`
          select id, parent_id, is_active, is_elimination from subsidiaries
           where id = ${rowId} and org_id = ${orgId}`,
            "objects",
          )
        )[0] ?? null)
      : null;
    if (rowId && !existing) return "not found";
    const parentId = body.parentId === undefined ? existing?.parent_id : body.parentId || null;
    if (!rowId && !parentId) return "A new subsidiary must have a parent";
    if (existing?.parent_id === null && parentId) return "The root subsidiary cannot be moved";
    if (existing?.parent_id === null && body.isActive === false)
      return "The root subsidiary cannot be archived";
    if (parentId) {
      if (!isUuid(String(parentId))) return "Invalid parent subsidiary";
      const parent = await executor.execute(
        sql`
        select id from subsidiaries
         where id = ${String(parentId)} and org_id = ${orgId} and is_active`,
        "objects",
      );
      if (!parent[0]) return "Parent subsidiary not found";
      if (rowId) {
        const cycle = await executor.execute(
          sql`
          with recursive descendants as (
            select id from subsidiaries where id = ${rowId} and org_id = ${orgId}
            union all
            select s.id from subsidiaries s join descendants d on s.parent_id = d.id
             where s.org_id = ${orgId}
          ) select 1 from descendants where id = ${String(parentId)} limit 1`,
          "objects",
        );
        if (cycle.length) return "A subsidiary cannot be parented beneath itself";
      }
    }
    if (
      rowId &&
      body.isElimination !== undefined &&
      body.isElimination !== existing?.is_elimination
    ) {
      const used = await executor.execute(
        sql`
        select 1 from journal_entries where org_id = ${orgId} and subsidiary_id = ${rowId} limit 1`,
        "objects",
      );
      if (used.length)
        return "Elimination status cannot change after the subsidiary has ledger activity";
    }
  }

  if (entity.key === "intercompany-pairs") {
    const current = rowId
      ? (
          await executor.execute(
            sql`
          select * from intercompany_pairs where id = ${rowId} and org_id = ${orgId}`,
            "objects",
          )
        )[0]
      : null;
    const fromId = String(body.fromSubsidiaryId ?? current?.from_subsidiary_id ?? "");
    const toId = String(body.toSubsidiaryId ?? current?.to_subsidiary_id ?? "");
    const dueFromId = String(body.dueFromAccountId ?? current?.due_from_account_id ?? "");
    const dueToId = String(body.dueToAccountId ?? current?.due_to_account_id ?? "");
    if (fromId === toId) return "Intercompany subsidiaries must be different";
    const subsidiaries = await executor.execute(
      sql`
      select id from subsidiaries where org_id = ${orgId} and is_active and not is_elimination
       and id = any(${`{${[fromId, toId].join(",")}}`}::uuid[])`,
      "objects",
    );
    if (subsidiaries.length !== 2) return "Choose two active, non-elimination subsidiaries";
    const accounts = await executor.execute<{ id: string; type: string; eliminate: boolean }>(
      sql`
      select id, type, eliminate from accounts where org_id = ${orgId} and is_active and not is_summary
       and id = any(${`{${[dueFromId, dueToId].join(",")}}`}::uuid[])`,
      "objects",
    );
    const byId = new Map<string, { id: string; type: string; eliminate: boolean }>(
      accounts.map((a): [string, { id: string; type: string; eliminate: boolean }] => [a.id, a]),
    );
    const dueFrom = byId.get(dueFromId);
    const dueTo = byId.get(dueToId);
    if (!dueFrom || !dueTo) return "Choose active posting accounts from this organization";
    if (!String(dueFrom.type).startsWith("asset_")) return "The due-from account must be an asset";
    if (!String(dueTo.type).startsWith("liability_"))
      return "The due-to account must be a liability";
    if (!dueFrom.eliminate || !dueTo.eliminate)
      return "Both intercompany accounts must be marked for elimination";
    // Optional intercompany receivable/payable control accounts per side:
    // eliminated posting accounts of the control type.
    for (const [key, column, type, label] of [
      [
        "fromReceivableAccountId",
        "from_receivable_account_id",
        "asset_receivable",
        "from-side intercompany receivable",
      ],
      [
        "fromPayableAccountId",
        "from_payable_account_id",
        "liability_payable",
        "from-side intercompany payable",
      ],
      [
        "toReceivableAccountId",
        "to_receivable_account_id",
        "asset_receivable",
        "to-side intercompany receivable",
      ],
      [
        "toPayableAccountId",
        "to_payable_account_id",
        "liability_payable",
        "to-side intercompany payable",
      ],
    ] as const) {
      const raw = body[key] !== undefined ? body[key] : current?.[column];
      if (raw === null || raw === undefined || raw === "") continue;
      if (!isUuid(String(raw))) return `Choose a valid ${label} account`;
      const control = (
        await executor.execute<{
          type: string;
          eliminate: boolean;
          is_active: boolean;
          is_summary: boolean;
        }>(
          sql`
        select type, eliminate, is_active, is_summary from accounts where org_id = ${orgId} and id = ${String(raw)}`,
          "objects",
        )
      )[0];
      if (!control || !control.is_active || control.is_summary)
        return `Choose an active posting account for the ${label} account`;
      if (control.type !== type)
        return `The ${label} account must be a ${type === "asset_receivable" ? "receivable" : "payable"} account`;
      if (!control.eliminate) return `The ${label} account must be marked for elimination`;
    }
    const duplicate = await executor.execute(
      sql`
      select 1 from intercompany_pairs where org_id = ${orgId}
       and id is distinct from ${rowId ?? null}
       and ((from_subsidiary_id = ${fromId} and to_subsidiary_id = ${toId})
         or (from_subsidiary_id = ${toId} and to_subsidiary_id = ${fromId})) limit 1`,
      "objects",
    );
    if (duplicate.length) return "An intercompany pair already exists for these subsidiaries";
  }
  if (entity.key === "payment-cards") {
    // A card is a posting instrument: its holder must be an employee of this
    // org and its liability account a postable liability (0171). Without this
    // fence a card could point at another tenant's party or at an expense
    // account, and the failure would surface only at posting time.
    const current = rowId
      ? (
          await executor.execute(
            sql`
          select * from payment_cards where id = ${rowId} and org_id = ${orgId}`,
            "objects",
          )
        )[0]
      : null;
    const holderId = String(body.holderPartyId ?? current?.holder_party_id ?? "");
    const liabilityId = String(body.liabilityAccountId ?? current?.liability_account_id ?? "");
    const holder =
      holderId && isUuid(holderId)
        ? await executor.execute(
            sql`
          select p.id from parties p
           join employee_roles e on e.party_id = p.id and e.org_id = p.org_id and e.is_active
          where p.id = ${holderId} and p.org_id = ${orgId} and p.is_active`,
            "objects",
          )
        : null;
    if (!holder?.length) return "Choose an active employee of this organization as the cardholder";
    const liability =
      liabilityId && isUuid(liabilityId)
        ? await executor.execute<{ id: string; type: string }>(
            sql`
          select id, type from accounts
           where id = ${liabilityId} and org_id = ${orgId} and is_active and not is_summary`,
            "objects",
          )
        : null;
    const liabilityRow = liability?.[0];
    if (!liabilityRow)
      return "Choose an active posting account from this organization as the card liability";
    if (!String(liabilityRow.type).startsWith("liability_"))
      return "The card liability must be a liability account";
  }
  if (entity.key === "subsidiary-ownership-interests") {
    const current = rowId
      ? (
          await executor.execute(
            sql`select * from subsidiary_ownership_interests where id=${rowId} and org_id=${orgId}`,
            "objects",
          )
        )[0]
      : null;
    const value = (key: string, column: string) => body[key] ?? current?.[column] ?? null;
    const method = String(value("method", "method") ?? "full");
    const ownership = String(value("ownershipPercent", "ownership_percent") ?? "");
    if (!/^(?:100(?:\.0+)?|(?:\d{1,2})(?:\.\d{1,10})?)$/.test(ownership) || ownership === "0") {
      return "Ownership must be greater than 0% and no more than 100%";
    }
    const fullyOwned = /^100(?:\.0+)?$/.test(ownership);
    const accountRules: [string, string, (type: string) => boolean, string][] = [
      [
        "investmentAccountId",
        "investment_account_id",
        (type) => type.startsWith("asset_"),
        "Investment must use an asset account",
      ],
      [
        "equityIncomeAccountId",
        "equity_income_account_id",
        (type) => type.startsWith("income"),
        "Equity income must use an income account",
      ],
      [
        "distributionAccountId",
        "distribution_account_id",
        (type) => type === "equity",
        "Distribution must use an equity account",
      ],
      [
        "distributionIncomeAccountId",
        "distribution_income_account_id",
        (type) => type.startsWith("income"),
        "Distribution income must use an income account",
      ],
      [
        "nciEquityAccountId",
        "nci_equity_account_id",
        (type) => type === "equity",
        "NCI equity must use an equity account",
      ],
      [
        "nciIncomeAccountId",
        "nci_income_account_id",
        (type) => type.startsWith("expense"),
        "NCI profit allocation must use an expense account",
      ],
      [
        "goodwillAccountId",
        "goodwill_account_id",
        (type) => type.startsWith("asset_"),
        "Goodwill must use an asset account",
      ],
      [
        "fairValueAdjustmentAccountId",
        "fair_value_adjustment_account_id",
        (type) => type.startsWith("asset_"),
        "Fair-value adjustment must use an asset account",
      ],
    ];
    const ids = [
      ...new Set(
        accountRules
          .map(([key, column]) => value(key, column))
          .filter(Boolean)
          .map(String),
      ),
    ];
    if (hasNonUuidEntry(ids))
      return "Ownership accounts must be valid accounts from this organization";
    const rows = ids.length
      ? ((await executor.execute(
          sql`
          select id,type from accounts where org_id=${orgId} and is_active and not is_summary
            and id=any(${uuidArrayParam(ids)}::uuid[])
        `,
          "objects",
        )) as { id: string; type: string }[])
      : [];
    const typeById = new Map(rows.map((account) => [account.id, account.type]));
    for (const [key, column, accepts, message] of accountRules) {
      const id = value(key, column);
      if (!id) continue;
      const type = typeById.get(String(id));
      if (!type || !accepts(type)) return message;
    }
    if (
      method === "full" &&
      !fullyOwned &&
      (!value("nciEquityAccountId", "nci_equity_account_id") ||
        !value("nciIncomeAccountId", "nci_income_account_id"))
    ) {
      return "Full consolidation below 100% requires both NCI equity and NCI profit-allocation accounts";
    }
    // The ownership_interest_guard trigger refuses full-method rows without
    // these legs: preflight it here so the refusal is a typed
    // user-language 400 naming the missing accounts, never the trigger's
    // raw SQL INSERT echoing through describeDbError.
    if (
      method === "full" &&
      (!value("goodwillAccountId", "goodwill_account_id") ||
        !value("fairValueAdjustmentAccountId", "fair_value_adjustment_account_id"))
    ) {
      return "Full consolidation requires goodwill and fair-value adjustment accounts";
    }
  }
  if (entity.key === "fx-rates" || entity.key === "consolidated-fx-rates") {
    const from = String(body.fromCurrency ?? "");
    const to = String(body.toCurrency ?? "");
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || from === to) {
      return "Choose two different ISO currency codes";
    }
    const currencies = await executor.execute(
      sql`
      select code from currencies where code = any(${`{${[from, to].join(",")}}`}::text[])`,
      "objects",
    );
    if (currencies.length !== 2) return "Unknown currency code";
    const rateFields =
      entity.key === "fx-rates" ? ["rate"] : ["currentRate", "averageRate", "historicalRate"];
    if (
      rateFields.some((key) => {
        if (body[key] === undefined) return false;
        const value = String(body[key]).trim();
        return !/^(?:\d+)(?:\.\d{1,10})?$/.test(value) || /^0(?:\.0+)?$/.test(value);
      })
    ) {
      return "Exchange rates must be greater than zero";
    }
    if (entity.key === "consolidated-fx-rates") {
      const periodId = String(body.periodId ?? "");
      if (!rowId) {
        const period = await executor.execute(
          sql`
          select 1 from accounting_periods where id = ${periodId} and org_id = ${orgId}`,
          "objects",
        );
        if (!period.length) return "Choose an accounting period from this organization";
      }
      if (rowId && body.source !== "manual") {
        return "Set the source to Manual before overriding a consolidated rate";
      }
    }
  }
  if (entity.key === "item-rate-book-assignments") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select rate_book_id as "rateBookId", customer_id as "customerId", project_id as "projectId",
               effective_from as "effectiveFrom", effective_to as "effectiveTo", date_basis as "dateBasis"
          from item_rate_book_assignments where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Rate book assignment not found";
      values = { ...current[0], ...body };
    }
    if (values.customerId && values.projectId) return "Choose a customer or a project, not both";
    if (!["usage_date", "project_start"].includes(String(values.dateBasis ?? "usage_date")))
      return "Choose a valid schedule date";
    if (
      values.effectiveFrom &&
      values.effectiveTo &&
      String(values.effectiveTo) < String(values.effectiveFrom)
    ) {
      return "The end date cannot precede the start date";
    }
    const scope = values.projectId
      ? sql`project_id = ${values.projectId}`
      : values.customerId
        ? sql`customer_id = ${values.customerId}`
        : sql`project_id is null and customer_id is null`;
    const refs = await executor.execute(
      sql`
        select
          exists(select 1 from item_rate_books where id = ${values.rateBookId} and org_id = ${orgId}) as book_ok,
          ${values.customerId ? sql`exists(select 1 from customer_roles where party_id = ${values.customerId} and org_id = ${orgId} and is_active)` : sql`true`} as customer_ok,
          ${values.projectId ? sql`exists(select 1 from projects where id = ${values.projectId} and org_id = ${orgId})` : sql`true`} as project_ok
      `,
      "objects",
    );
    const overlap = await executor.execute(
      sql`
        select 1 from item_rate_book_assignments
         where org_id = ${orgId} and id is distinct from ${rowId ?? null} and is_active
           and ${scope}
           and daterange(effective_from, effective_to, '[]') &&
               daterange(${values.effectiveFrom ?? null}::date, ${values.effectiveTo ?? null}::date, '[]')
         limit 1
      `,
      "objects",
    );
    if (!refs[0]?.book_ok || !refs[0]?.customer_ok || !refs[0]?.project_ok) {
      return "Choose records from this organization";
    }
    if (overlap.length)
      return "This scope already has an active rate book for part of that date range";
  }
  // Consolidation groups: the payer must be a party of this organization
  // and the billing subsidiary an active entity of it — a group pointing
  // elsewhere would consolidate every period into a refusal at run time.
  // Range and enum domains are storage CHECKs; the messages below name the
  // field before the database has to.
  if (entity.key === "consolidation-groups") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select payer_party_id as "payerPartyId", billing_subsidiary_id as "billingSubsidiaryId",
               cadence, cutoff_day as "cutoffDay", grouping
          from consolidation_groups where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Consolidation group not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    if (!["weekly", "monthly"].includes(String(values.cadence ?? "monthly")))
      return "Choose a weekly or monthly cadence";
    if (
      !["by_child", "by_subscription", "by_product"].includes(String(values.grouping ?? "by_child"))
    ) {
      return "Choose how the consolidated invoice groups its lines";
    }
    const cutoff = Number(values.cutoffDay);
    if (!Number.isInteger(cutoff) || cutoff < 1 || cutoff > 28)
      return "Choose a cut-off day between 1 and 28";
    const refs = await executor.execute(
      sql`
      select
        exists(select 1 from parties where id = ${String(values.payerPartyId ?? "")} and org_id = ${orgId}) as payer_ok,
        ${
          values.billingSubsidiaryId
            ? sql`exists(select 1 from subsidiaries where id = ${String(values.billingSubsidiaryId)} and org_id = ${orgId} and is_active)`
            : sql`true`
        } as subsidiary_ok
    `,
      "objects",
    );
    if (!refs[0]?.payer_ok) return "Choose the payer from this organization";
    if (!refs[0]?.subsidiary_ok) return "Choose an active billing entity from this organization";
  }
  return INTEGRITY_CONTINUES;
}
