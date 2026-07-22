import { sql } from "drizzle-orm";
import { db, schema, withOrg, withOrgContext } from "../db.ts";
import { fromUnits, toUnits } from "../money.ts";
import { postDocument } from "../posting.ts";
import { buildNativeContext } from "./native.ts";
import { NetSuiteSource, type NetSuiteFixedAssetSnapshot } from "./netsuite-source.ts";

type Row = Record<string, unknown>;

export interface NetSuiteFixedAssetSyncOptions {
  orgId: string;
  connectionId: string;
  actorId?: string | null;
}

export interface NetSuiteFixedAssetSyncResult {
  source: {
    assets: number;
    assetTypes: number;
    depreciationHistory: number;
    assetValues: number;
    sourceCost: string;
    sourceAccumulatedDepreciation: string;
    sourceNetBookValue: string;
  };
  target: {
    categories: number;
    assets: number;
    schedules: number;
    scheduleLines: number;
    acquisitionCost: string;
    accumulatedDepreciation: string;
    netBookValue: string;
  };
  created: { categories: number; assets: number };
  updated: { categories: number; assets: number };
  orphanHistoryRows: number;
  fixedAssetLedger: {
    sourceTransactions: number;
    existingTransactions: number;
    importedTransactions: number;
    balances: { accountRef: string; source: string; target: string }[];
  };
  mismatches: string[];
}

const text = (value: unknown): string | null => {
  const out = value == null ? "" : String(value).trim();
  return out || null;
};

const truthy = (value: unknown): boolean => value === true || value === "T";

/** NetSuite's RESTlet returns dates as MM/DD/YYYY; keep date-only values date-only. */
export function netSuiteFamDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso?.[1] ?? null;
}

const money = (value: unknown): string => fromUnits(toUnits(text(value) ?? "0"));
const absoluteMoney = (value: unknown): string => {
  const units = toUnits(text(value) ?? "0");
  return fromUnits(units < 0n ? -units : units);
};

const method = (row: Row): "straight_line" | "declining_balance" | "double_declining" | "units_of_production" | "manual" => {
  const label = (text(row.fam_method_label) ?? "").toLowerCase();
  if (label.includes("straight")) return "straight_line";
  if (label.includes("double") && label.includes("declin")) return "double_declining";
  if (label.includes("declin")) return "declining_balance";
  if (label.includes("unit")) return "units_of_production";
  return "manual";
};

const status = (row: Row, hasHistory: boolean): "draft" | "in_service" | "fully_depreciated" | "disposed" | "written_off" => {
  const label = (text(row.fam_status_label) ?? "").toLowerCase();
  if (label.includes("fully")) return "fully_depreciated";
  if (label.includes("dispose")) return "disposed";
  if (label.includes("write")) return "written_off";
  if (label === "new" || text(row.custrecord_assetstatus) === "6") return "draft";
  return hasHistory || netSuiteFamDate(row.custrecord_assetdeprstartdate) ? "in_service" : "draft";
};

interface FamState {
  sourceId: string;
  cost: string;
  bookValue: string;
  accumulated: string;
  histories: Row[];
  value: Row | null;
}

export function netSuiteFamState(asset: Row, value: Row | null, histories: Row[]): FamState {
  const sourceId = text(asset.id);
  if (!sourceId) throw new Error("NetSuite FAM asset without an internal id");
  const cost = money(asset.custrecord_assetcurrentcost ?? asset.custrecord_assetcost);
  const bookValue = value
    ? money(value.custrecord_slavebookvalue ?? value.custrecord_slavepriornbv ?? cost)
    : cost;
  const accumulatedUnits = toUnits(cost) - toUnits(bookValue);
  if (accumulatedUnits < 0n) {
    throw new Error(`NetSuite FAM asset ${sourceId} has book value ${bookValue} above current cost ${cost}`);
  }
  return { sourceId, cost, bookValue, accumulated: fromUnits(accumulatedUnits), histories, value };
}

const json = (value: unknown): string => JSON.stringify(value);

async function idMap(table: "accounts" | "subsidiaries" | "departments" | "projects" | "locations" | "parties", orgId: string) {
  const result = (await db.execute(sql.raw(
    `select id, custom->>'nsId' as source_ref from ${table} where org_id = '${orgId.replaceAll("'", "''")}' and custom->>'nsId' is not null`,
  ))) as unknown as { rows: { id: string; source_ref: string }[] };
  const out = new Map<string, string>();
  for (const row of result.rows) if (!out.has(row.source_ref)) out.set(row.source_ref, row.id);
  return out;
}

function requiredRef(map: Map<string, string>, sourceRef: unknown, label: string): string {
  const ref = text(sourceRef);
  const id = ref ? map.get(ref) : null;
  if (!id) throw new Error(`NetSuite FAM ${label} ${ref ?? "(blank)"} is not mapped in OpenBooks`);
  return id;
}

function optionalRef(map: Map<string, string>, sourceRef: unknown, label: string): string | null {
  const ref = text(sourceRef);
  if (!ref) return null;
  const id = map.get(ref);
  if (!id) throw new Error(`NetSuite FAM ${label} ${ref} is not mapped in OpenBooks`);
  return id;
}

function periodForDate(periods: { id: string; starts_on: string; ends_on: string; is_adjustment: boolean }[], date: string) {
  return periods.find((period) => !period.is_adjustment && period.starts_on <= date && period.ends_on >= date)
    ?? periods.find((period) => period.starts_on <= date && period.ends_on >= date)
    ?? [...periods].reverse().find((period) => period.ends_on <= date)
    ?? periods.at(-1)
    ?? null;
}

function extractionDate(snapshot: NetSuiteFixedAssetSnapshot): string {
  const date = new Date(snapshot.extractedAt);
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}

/**
 * Mirror only NetSuite FAM into the OpenBooks asset register.  The pull happens
 * before the DB transaction, so RESTlet latency never holds a tenant lock.  No
 * GL entries are created: native NetSuite journals are already owned by the
 * transaction connector, while imported FAM posted amounts establish the
 * register's exact opening carrying value.
 */
export async function syncNetSuiteFixedAssets(
  source: NetSuiteSource,
  options: NetSuiteFixedAssetSyncOptions,
): Promise<NetSuiteFixedAssetSyncResult> {
  const snapshot = await source.fixedAssets();
  const asOf = extractionDate(snapshot);
  const historyByAsset = new Map<string, Row[]>();
  const orphanHistory: Row[] = [];
  for (const row of snapshot.depreciationHistory) {
    const assetRef = text(row.custrecord_deprhistasset);
    if (!assetRef) orphanHistory.push(row);
    else historyByAsset.set(assetRef, [...(historyByAsset.get(assetRef) ?? []), row]);
  }
  const valueByAsset = new Map(
    snapshot.assetValues
      .map((row) => [text(row.custrecord_slaveparentasset), row] as const)
      .filter((entry): entry is [string, Row] => Boolean(entry[0])),
  );
  const states = snapshot.assets.map((asset) =>
    netSuiteFamState(asset, valueByAsset.get(String(asset.id)) ?? null, historyByAsset.get(String(asset.id)) ?? []));
  const sourceCost = states.reduce((sum, state) => sum + toUnits(state.cost), 0n);
  const sourceAccumulated = states.reduce((sum, state) => sum + toUnits(state.accumulated), 0n);
  const sourceBookValue = states.reduce((sum, state) => sum + toUnits(state.bookValue), 0n);

  const fixedAssetAccountRefs = [...new Set([
    ...snapshot.assetTypes.flatMap((row) => [
      row.custrecord_assettypeassetacc,
      row.custrecord_assettypedepracc,
      row.custrecord_assettypedeprchargeacc,
      row.custrecord_assettypedisposalacc,
      row.custrecord_assettypewritedownacc,
      row.custrecord_assettypewriteoffacc,
    ]),
    ...snapshot.assets.flatMap((row) => [
      row.custrecord_assetmainacc,
      row.custrecord_assetdepracc,
      row.custrecord_assetdeprchargeacc,
      row.custrecord_assetdisposalacc,
      row.custrecord_assetwritedownacc,
      row.custrecord_assetwriteoffacc,
    ]),
  ].map(text).filter((ref): ref is string => Boolean(ref)))];
  const sourceTransactionIds = await source.fixedAssetTransactionIds(fixedAssetAccountRefs);
  const sourceLedgerBalances = await source.fixedAssetAccountBalances(fixedAssetAccountRefs);
  const nativePreparation = await withOrgContext(options.orgId, async () => {
    const nativeContext = await buildNativeContext(options.orgId, source.refKey, source.baseCurrency);
    const existingResult = (await db.execute(sql`
      select custom->>${source.refKey} as source_ref
        from documents
       where org_id = ${options.orgId} and custom->>${source.refKey} is not null
    `)) as unknown as { rows: { source_ref: string }[] };
    return {
      nativeContext,
      existingRefs: new Set(existingResult.rows.map((row) => row.source_ref)),
    };
  });
  const missingTransactionIds = sourceTransactionIds.filter((id) => !nativePreparation.existingRefs.has(id));
  const nativeChanges = await source.nativeTransactionsByIds(missingTransactionIds, nativePreparation.nativeContext);
  if (nativeChanges.unbuildable.length || nativeChanges.nonLedgerRefs?.length) {
    const failures = [
      ...nativeChanges.unbuildable.map((row) => `${row.ref}: ${row.reason}`),
      ...(nativeChanges.nonLedgerRefs ?? []).map((ref) => `${ref}: non-ledger transaction`),
    ];
    throw new Error(`NetSuite FAM ledger transactions could not be imported: ${failures.join("; ")}`);
  }

  return withOrg(options.orgId, async () => {
    // withOrg deliberately pins one transaction client; keep its queries
    // sequential (pg does not support concurrent queries on one client).
    const accounts = await idMap("accounts", options.orgId);
    const subsidiaries = await idMap("subsidiaries", options.orgId);
    const departments = await idMap("departments", options.orgId);
    const projects = await idMap("projects", options.orgId);
    const locations = await idMap("locations", options.orgId);
    const parties = await idMap("parties", options.orgId);
    const books = (await db.execute(sql`
      select id from accounting_books where org_id = ${options.orgId} and is_primary order by id limit 1
    `)) as unknown as { rows: { id: string }[] };
    const bookId = books.rows[0]?.id;
    if (!bookId) throw new Error("Rassaun has no primary accounting book");
    const periodResult = (await db.execute(sql`
      select id, starts_on::text, ends_on::text, is_adjustment
        from accounting_periods where org_id = ${options.orgId} order by starts_on, ends_on
    `)) as unknown as { rows: { id: string; starts_on: string; ends_on: string; is_adjustment: boolean }[] };
    const asOfPeriod = periodForDate(periodResult.rows, asOf);
    if (!asOfPeriod) throw new Error(`Rassaun has no accounting period for the FAM snapshot ${asOf}`);

    let createdCategories = 0;
    let updatedCategories = 0;
    let createdAssets = 0;
    let updatedAssets = 0;
    const categoryBySource = new Map<string, string>();

    for (const assetType of snapshot.assetTypes) {
      const sourceId = text(assetType.id);
      if (!sourceId) throw new Error("NetSuite FAM asset type without an internal id");
      const rawMetadata = {
        source: "netsuite_fam",
        nsId: sourceId,
        netsuiteFam: {
          schemaVersion: 1,
          connectionId: options.connectionId,
          sourceId,
          sourceAccount: snapshot.sourceAccount,
          bridgeVersion: snapshot.bridgeVersion,
          lastSyncedAt: snapshot.extractedAt,
          assetType,
          depreciationMethods: snapshot.depreciationMethods,
          alternateMethods: snapshot.alternateMethods,
          alternateDefinitions: snapshot.alternateDefinitions,
          assetLifetimes: snapshot.assetLifetimes,
          orphanHistory,
        },
      };
      const existing = (await db.execute(sql`
        select id from asset_categories
         where org_id = ${options.orgId}
           and tax_attributes->>'source' = 'netsuite_fam'
           and tax_attributes->>'nsId' = ${sourceId}
           and tax_attributes->'netsuiteFam'->>'connectionId' = ${options.connectionId}
         limit 1
      `)) as unknown as { rows: { id: string }[] };
      const assetAccountId = requiredRef(accounts, assetType.custrecord_assettypeassetacc, "asset account");
      const accumulatedAccountId = requiredRef(accounts, assetType.custrecord_assettypedepracc, "accumulated depreciation account");
      const expenseAccountId = requiredRef(accounts, assetType.custrecord_assettypedeprchargeacc, "depreciation expense account");
      const gainLossAccountId = optionalRef(accounts, assetType.custrecord_assettypedisposalacc, "gain/loss account");
      const lifeMonths = Number(text(assetType.custrecord_assettypelifetime) ?? 0) || null;
      let categoryId: string;
      if (existing.rows[0]) {
        categoryId = existing.rows[0].id;
        await db.execute(sql`
          update asset_categories
             set name = ${text(assetType.name) ?? `NetSuite FAM type ${sourceId}`},
                 asset_account_id = ${assetAccountId},
                 accumulated_depreciation_account_id = ${accumulatedAccountId},
                 depreciation_expense_account_id = ${expenseAccountId},
                 gain_loss_account_id = ${gainLossAccountId},
                 default_method = ${method(assetType)}, default_life_months = ${lifeMonths},
                 default_convention = 'full_month', tax_attributes = ${json(rawMetadata)}::jsonb,
                 is_active = ${!truthy(assetType.isinactive)}, updated_at = now(), updated_by = ${options.actorId ?? null}
           where id = ${categoryId}
        `);
        updatedCategories += 1;
      } else {
        const inserted = (await db.execute(sql`
          insert into asset_categories
            (org_id, name, asset_account_id, accumulated_depreciation_account_id,
             depreciation_expense_account_id, gain_loss_account_id, default_method,
             default_life_months, default_convention, tax_attributes, is_active, created_by, updated_by)
          values
            (${options.orgId}, ${text(assetType.name) ?? `NetSuite FAM type ${sourceId}`}, ${assetAccountId},
             ${accumulatedAccountId}, ${expenseAccountId}, ${gainLossAccountId}, ${method(assetType)},
             ${lifeMonths}, 'full_month', ${json(rawMetadata)}::jsonb, ${!truthy(assetType.isinactive)},
             ${options.actorId ?? null}, ${options.actorId ?? null})
          returning id
        `)) as unknown as { rows: { id: string }[] };
        categoryId = inserted.rows[0]!.id;
        createdCategories += 1;
      }
      categoryBySource.set(sourceId, categoryId);
    }

    for (let assetIndex = 0; assetIndex < snapshot.assets.length; assetIndex += 1) {
      const asset = snapshot.assets[assetIndex]!;
      const state = states[assetIndex]!;
      const categorySourceRef = text(asset.custrecord_assettype);
      const categoryId = categorySourceRef ? categoryBySource.get(categorySourceRef) : null;
      if (!categoryId) throw new Error(`NetSuite FAM asset ${state.sourceId} has unmapped asset type ${categorySourceRef}`);
      const subsidiaryId = requiredRef(subsidiaries, asset.custrecord_assetsubsidiary, "subsidiary");
      const departmentId = optionalRef(departments, asset.custrecord_assetdepartment, "department");
      const projectId = optionalRef(projects, asset.custrecord_assetproject, "project");
      const locationId = optionalRef(locations, asset.custrecord_assetlocation, "location");
      const custodianPartyId = optionalRef(parties, asset.custrecord_assetcaretaker, "custodian");
      const sourceStatus = status(asset, state.histories.length > 0);
      const acquiredOn = netSuiteFamDate(asset.custrecord_assetpurchasedate);
      const inServiceOn = sourceStatus === "draft" ? null : netSuiteFamDate(asset.custrecord_assetdeprstartdate);
      const sourceMethod = method(asset);
      const lifeMonths = Number(text(asset.custrecord_assetlifetime) ?? 0) || null;
      const categoryAccounts = {
        asset: requiredRef(accounts, asset.custrecord_assetmainacc, "asset account"),
        accumulated: requiredRef(accounts, asset.custrecord_assetdepracc, "accumulated depreciation account"),
        expense: requiredRef(accounts, asset.custrecord_assetdeprchargeacc, "depreciation expense account"),
      };
      const assetAlternateDepreciation = snapshot.alternateDepreciation.filter((row) =>
        text(row.custrecord_altdeprasset ?? row.custrecord_altdepr_asset) === state.sourceId);
      const custom = {
        nsId: state.sourceId,
        source: "netsuite",
        sourceConnectionId: options.connectionId,
        sourceManaged: true,
        accounts: categoryAccounts,
        netsuiteFam: {
          schemaVersion: 1,
          connectionId: options.connectionId,
          sourceId: state.sourceId,
          sourceAccount: snapshot.sourceAccount,
          bridgeVersion: snapshot.bridgeVersion,
          lastSyncedAt: snapshot.extractedAt,
          sourceCost: state.cost,
          sourceBookValue: state.bookValue,
          sourceAccumulatedDepreciation: state.accumulated,
          originalPurchasePrice: money(asset.custrecord_klp_original_purc_price),
          asset,
          assetValue: state.value,
          depreciationHistory: state.histories,
          alternateDepreciation: assetAlternateDepreciation,
        },
      };
      const existing = (await db.execute(sql`
        select id from fixed_assets
         where org_id = ${options.orgId}
           and custom->'netsuiteFam'->>'connectionId' = ${options.connectionId}
           and custom->'netsuiteFam'->>'sourceId' = ${state.sourceId}
         limit 1
      `)) as unknown as { rows: { id: string }[] };
      let assetId: string;
      if (existing.rows[0]) {
        assetId = existing.rows[0].id;
        await db.execute(sql`
          update fixed_assets
             set subsidiary_id = ${subsidiaryId}, category_id = ${categoryId},
                 asset_number = ${text(asset.name) ?? `NS-${state.sourceId}`},
                 name = ${text(asset.altname) ?? text(asset.custrecord_assetdescr) ?? text(asset.name) ?? `Asset ${state.sourceId}`},
                 description = ${text(asset.custrecord_assetdescr)}, status = ${sourceStatus},
                 acquired_on = ${acquiredOn}, in_service_on = ${inServiceOn},
                 acquisition_cost = ${state.cost}, salvage_value = ${money(asset.custrecord_assetresidualvalue)},
                 depreciation_method = ${sourceMethod}, useful_life_months = ${lifeMonths},
                 depreciation_convention = 'full_month',
                 serial_number = ${text(asset.custrecord_assetserialno)}, department_id = ${departmentId},
                 project_id = ${projectId}, location_id = ${locationId}, custodian_party_id = ${custodianPartyId},
                 custom = coalesce(custom, '{}'::jsonb) || ${json(custom)}::jsonb,
                 updated_at = now(), updated_by = ${options.actorId ?? null}
           where id = ${assetId}
        `);
        updatedAssets += 1;
      } else {
        const inserted = (await db.execute(sql`
          insert into fixed_assets
            (org_id, subsidiary_id, category_id, asset_number, name, description, status,
             acquired_on, in_service_on, acquisition_cost, salvage_value, serial_number,
             depreciation_method, useful_life_months, depreciation_convention,
             department_id, project_id, location_id, custodian_party_id, custom, created_by, updated_by)
          values
            (${options.orgId}, ${subsidiaryId}, ${categoryId}, ${text(asset.name) ?? `NS-${state.sourceId}`},
             ${text(asset.altname) ?? text(asset.custrecord_assetdescr) ?? text(asset.name) ?? `Asset ${state.sourceId}`},
             ${text(asset.custrecord_assetdescr)}, ${sourceStatus}, ${acquiredOn}, ${inServiceOn},
             ${state.cost}, ${money(asset.custrecord_assetresidualvalue)}, ${text(asset.custrecord_assetserialno)},
             ${sourceMethod}, ${lifeMonths}, 'full_month',
             ${departmentId}, ${projectId}, ${locationId}, ${custodianPartyId}, ${json(custom)}::jsonb,
             ${options.actorId ?? null}, ${options.actorId ?? null})
          returning id
        `)) as unknown as { rows: { id: string }[] };
        assetId = inserted.rows[0]!.id;
        createdAssets += 1;
      }

      await db.execute(sql`
        delete from asset_events
         where org_id = ${options.orgId} and asset_id = ${assetId}
           and journal_entry_id is null and memo like '[NetSuite FAM history %]'
      `);
      for (const history of state.histories) {
        if ((text(history.fam_history_type_label) ?? "").toLowerCase() !== "acquisition") continue;
        const occurredOn = netSuiteFamDate(history.custrecord_deprhistdate) ?? acquiredOn ?? asOf;
        await db.execute(sql`
          insert into asset_events
            (org_id, asset_id, kind, occurred_on, amount, memo, created_by, updated_by)
          values
            (${options.orgId}, ${assetId}, 'acquired', ${occurredOn}, ${money(history.custrecord_deprhistamount)},
             ${`[NetSuite FAM history ${text(history.id) ?? "unknown"}]`}, ${options.actorId ?? null}, ${options.actorId ?? null})
        `);
      }

      const scheduleResult = (await db.execute(sql`
        select id from depreciation_schedules
         where org_id = ${options.orgId} and asset_id = ${assetId} and book_id = ${bookId} limit 1
      `)) as unknown as { rows: { id: string }[] };
      let scheduleId = scheduleResult.rows[0]?.id;
      if (scheduleId) {
        const localPosted = (await db.execute(sql`
          select count(*)::int as count from depreciation_schedule_lines
           where org_id = ${options.orgId} and schedule_id = ${scheduleId} and journal_entry_id is not null
        `)) as unknown as { rows: { count: number }[] };
        if (Number(localPosted.rows[0]?.count ?? 0) > 0) {
          throw new Error(`NetSuite-managed asset ${text(asset.name) ?? state.sourceId} has locally posted depreciation`);
        }
        await db.execute(sql`
          update depreciation_schedules
             set method = ${sourceMethod}, life_months = ${lifeMonths}, updated_at = now(), updated_by = ${options.actorId ?? null}
           where id = ${scheduleId}
        `);
      } else {
        const inserted = (await db.execute(sql`
          insert into depreciation_schedules
            (org_id, asset_id, book_id, method, life_months, created_by, updated_by)
          values (${options.orgId}, ${assetId}, ${bookId}, ${sourceMethod}, ${lifeMonths}, ${options.actorId ?? null}, ${options.actorId ?? null})
          returning id
        `)) as unknown as { rows: { id: string }[] };
        scheduleId = inserted.rows[0]!.id;
      }
      await db.execute(sql`
        delete from depreciation_schedule_lines
         where org_id = ${options.orgId} and schedule_id = ${scheduleId} and journal_entry_id is null
      `);

      // The local schedule permits one formula row per period, while imported
      // source history can legitimately contain several depreciation events in
      // the same period. Aggregate those events exactly and fold any opening
      // carrying-value adjustment into the as-of period before inserting.
      const importedByPeriod = new Map<string, {
        period: { id: string; starts_on: string; ends_on: string; is_adjustment: boolean };
        units: bigint;
      }>();
      let importedDepreciation = 0n;
      for (const history of state.histories) {
        const historyLabel = (text(history.fam_history_type_label) ?? "").toLowerCase();
        if (!historyLabel.includes("depreciat")) continue;
        const amount = absoluteMoney(history.custrecord_deprhistamount);
        const amountUnits = toUnits(amount);
        if (amountUnits === 0n) continue;
        const lineDate = netSuiteFamDate(history.custrecord_deprhistdate) ?? asOf;
        const linePeriod = periodForDate(periodResult.rows, lineDate) ?? asOfPeriod;
        importedDepreciation += amountUnits;
        const prior = importedByPeriod.get(linePeriod.id);
        importedByPeriod.set(linePeriod.id, { period: linePeriod, units: (prior?.units ?? 0n) + amountUnits });
      }
      const openingAdjustment = toUnits(state.accumulated) - importedDepreciation;
      if (openingAdjustment < 0n) {
        throw new Error(`NetSuite FAM depreciation history exceeds accumulated depreciation for asset ${state.sourceId}`);
      }
      if (openingAdjustment > 0n) {
        const prior = importedByPeriod.get(asOfPeriod.id);
        importedByPeriod.set(asOfPeriod.id, {
          period: asOfPeriod,
          units: (prior?.units ?? 0n) + openingAdjustment,
        });
      }
      let sequence = 0;
      const importedPeriods = [...importedByPeriod.values()]
        .sort((left, right) => left.period.starts_on.localeCompare(right.period.starts_on));
      for (const imported of importedPeriods) {
        const amount = fromUnits(imported.units);
        await db.execute(sql`
          insert into depreciation_schedule_lines
            (org_id, schedule_id, period_id, sequence, planned_amount, posted_amount, source, created_by, updated_by)
          values
            (${options.orgId}, ${scheduleId}, ${imported.period.id}, ${sequence}, ${amount}, ${amount}, 'imported',
             ${options.actorId ?? null}, ${options.actorId ?? null})
        `);
        sequence += 1;
      }
    }

    let importedLedgerTransactions = 0;
    for (const sourceDoc of nativeChanges.documents) {
      const document = {
        ...sourceDoc,
        subsidiaryId: sourceDoc.subsidiaryId ?? nativePreparation.nativeContext.rootSubsidiaryId,
      };
      if (!document.posting) throw new Error(`NetSuite FAM transaction ${document.sourceRef} is non-posting`);
      if (!nativePreparation.nativeContext.periodFor(document.documentDate)) {
        throw new Error(`NetSuite FAM transaction ${document.sourceRef} has no period for ${document.documentDate}`);
      }
      const existing = (await db.execute(sql`
        select id from documents
         where org_id = ${options.orgId} and custom->>${source.refKey} = ${document.sourceRef} limit 1
      `)) as unknown as { rows: { id: string }[] };
      if (existing.rows[0]) continue;
      const inserted = await db.insert(schema.documents).values({
        orgId: options.orgId,
        kind: document.kind as typeof schema.documents.$inferInsert["kind"],
        documentNumber: document.sourceRef,
        partyId: document.partyId,
        subsidiaryId: document.subsidiaryId,
        extraDims: document.extraDims ?? {},
        documentDate: document.documentDate,
        dueDate: document.dueDate,
        currency: document.currency ?? source.baseCurrency,
        fxRate: document.fxRate ?? "1",
        status: "approved",
        subtotal: document.subtotal ?? "0",
        taxTotal: "0",
        total: document.total ?? "0",
        memo: document.memo,
        referenceNumber: document.referenceNumber,
        custom: document.controlAccountId
          ? { [source.refKey]: document.sourceRef, controlAccountId: document.controlAccountId }
          : { [source.refKey]: document.sourceRef },
        createdBy: options.actorId ?? null,
        updatedBy: options.actorId ?? null,
      }).returning({ id: schema.documents.id });
      const documentId = inserted[0]!.id;
      await db.insert(schema.documentLines).values(document.lines.map((line) => ({
        orgId: options.orgId,
        documentId,
        lineNumber: line.lineNumber,
        accountId: line.accountId,
        itemId: line.itemId,
        amount: line.amount,
        taxCodeId: line.taxCodeId,
        taxAmount: line.taxAmount,
        taxOverridden: line.taxOverridden,
        partyId: line.partyId ?? null,
        departmentId: line.departmentId,
        projectId: line.projectId,
        subsidiaryId: line.subsidiaryId,
        extraDims: line.extraDims ?? {},
        description: line.description,
        createdBy: options.actorId ?? null,
        updatedBy: options.actorId ?? null,
      })));
      await postDocument(documentId, {
        control: nativePreparation.nativeContext.control,
        cardLiabilityAccountId: nativePreparation.nativeContext.control.ap,
        migration: true,
      });
      await db.execute(sql`
        update documents d set
          total = coalesce((select sum(jl.amount) from journal_lines jl
                             where jl.entry_id = d.posted_entry_id and jl.amount > 0), 0),
          tax_total = coalesce(abs((select sum(dl.tax_amount) from document_lines dl
                                    where dl.document_id = d.id)), 0),
          subtotal = coalesce((select sum(jl.amount) from journal_lines jl
                                where jl.entry_id = d.posted_entry_id and jl.amount > 0), 0)
                     - coalesce(abs((select sum(dl.tax_amount) from document_lines dl
                                     where dl.document_id = d.id)), 0)
        where d.id = ${documentId}
      `);
      importedLedgerTransactions += 1;
    }

    const targetResult = (await db.execute(sql`
      select count(distinct a.id)::int as assets,
             count(distinct a.category_id)::int as categories,
             count(distinct s.id)::int as schedules,
             count(l.id)::int as schedule_lines,
             coalesce(sum(a.acquisition_cost) filter (where asset_once = 1), 0)::text as acquisition_cost,
             coalesce(sum(l.posted_amount), 0)::text as accumulated
        from (
          select a.*, row_number() over (partition by a.id order by a.id) as asset_once
            from fixed_assets a
           where a.org_id = ${options.orgId}
             and a.custom->'netsuiteFam'->>'connectionId' = ${options.connectionId}
        ) a
        left join depreciation_schedules s on s.asset_id = a.id and s.book_id = ${bookId}
        left join depreciation_schedule_lines l on l.schedule_id = s.id and l.posted_amount is not null
    `)) as unknown as { rows: {
      assets: number; categories: number; schedules: number; schedule_lines: number;
      acquisition_cost: string; accumulated: string;
    }[] };
    const target = targetResult.rows[0]!;
    // The aggregate above repeats assets across schedule lines. Recompute cost
    // separately so a multi-line depreciation history remains penny-exact.
    const targetCostResult = (await db.execute(sql`
      select coalesce(sum(acquisition_cost), 0)::text as amount
        from fixed_assets
       where org_id = ${options.orgId}
         and custom->'netsuiteFam'->>'connectionId' = ${options.connectionId}
    `)) as unknown as { rows: { amount: string }[] };
    const targetCost = money(targetCostResult.rows[0]?.amount);
    const targetAccumulated = money(target.accumulated);
    const targetNbv = fromUnits(toUnits(targetCost) - toUnits(targetAccumulated));
    const mismatches: string[] = [];
    if (Number(target.assets) !== snapshot.assets.length) mismatches.push(`asset count ${target.assets} != ${snapshot.assets.length}`);
    if (Number(target.categories) !== snapshot.assetTypes.length) mismatches.push(`category count ${target.categories} != ${snapshot.assetTypes.length}`);
    if (toUnits(targetCost) !== sourceCost) mismatches.push(`cost ${targetCost} != ${fromUnits(sourceCost)}`);
    if (toUnits(targetAccumulated) !== sourceAccumulated) {
      mismatches.push(`accumulated depreciation ${targetAccumulated} != ${fromUnits(sourceAccumulated)}`);
    }
    if (toUnits(targetNbv) !== sourceBookValue) mismatches.push(`net book value ${targetNbv} != ${fromUnits(sourceBookValue)}`);

    const targetStateResult = (await db.execute(sql`
      select a.custom->'netsuiteFam'->>'sourceId' as source_id,
             a.acquisition_cost::text as cost,
             coalesce((select sum(l.posted_amount)
                         from depreciation_schedules s
                         join depreciation_schedule_lines l on l.schedule_id = s.id
                        where s.asset_id = a.id and s.book_id = ${bookId}
                          and l.posted_amount is not null), 0)::text as accumulated,
             a.custom->'netsuiteFam'->'asset'->>'id' as raw_asset_id,
             a.custom->'netsuiteFam'->'assetValue'->>'id' as raw_value_id,
             jsonb_array_length(a.custom->'netsuiteFam'->'depreciationHistory')::int as history_count
        from fixed_assets a
       where a.org_id = ${options.orgId}
         and a.custom->'netsuiteFam'->>'connectionId' = ${options.connectionId}
    `)) as unknown as { rows: {
      source_id: string; cost: string; accumulated: string;
      raw_asset_id: string | null; raw_value_id: string | null; history_count: number;
    }[] };
    const targetStateBySource = new Map(targetStateResult.rows.map((row) => [row.source_id, row]));
    for (const state of states) {
      const row = targetStateBySource.get(state.sourceId);
      if (!row) {
        mismatches.push(`asset ${state.sourceId} is missing`);
        continue;
      }
      if (toUnits(row.cost) !== toUnits(state.cost)) mismatches.push(`asset ${state.sourceId} cost differs`);
      if (toUnits(row.accumulated) !== toUnits(state.accumulated)) mismatches.push(`asset ${state.sourceId} accumulated depreciation differs`);
      const rowNbv = toUnits(row.cost) - toUnits(row.accumulated);
      if (rowNbv !== toUnits(state.bookValue)) mismatches.push(`asset ${state.sourceId} net book value differs`);
      if (row.raw_asset_id !== state.sourceId) mismatches.push(`asset ${state.sourceId} raw source row is missing`);
      if (row.raw_value_id !== (text(state.value?.id) ?? null)) mismatches.push(`asset ${state.sourceId} raw book-value row differs`);
      if (Number(row.history_count) !== state.histories.length) mismatches.push(`asset ${state.sourceId} history row count differs`);
    }

    const preservedGlobalResult = (await db.execute(sql`
      select jsonb_array_length(tax_attributes->'netsuiteFam'->'depreciationMethods')::int as methods,
             jsonb_array_length(tax_attributes->'netsuiteFam'->'alternateMethods')::int as alternate_methods,
             jsonb_array_length(tax_attributes->'netsuiteFam'->'alternateDefinitions')::int as alternate_definitions,
             jsonb_array_length(tax_attributes->'netsuiteFam'->'assetLifetimes')::int as asset_lifetimes,
             jsonb_array_length(tax_attributes->'netsuiteFam'->'orphanHistory')::int as orphan_history
        from asset_categories
       where org_id = ${options.orgId}
         and tax_attributes->>'source' = 'netsuite_fam'
         and tax_attributes->'netsuiteFam'->>'connectionId' = ${options.connectionId}
       order by id limit 1
    `)) as unknown as { rows: {
      methods: number; alternate_methods: number; alternate_definitions: number;
      asset_lifetimes: number; orphan_history: number;
    }[] };
    const preserved = preservedGlobalResult.rows[0];
    if (!preserved) mismatches.push("source FAM definition metadata is missing");
    else {
      if (Number(preserved.methods) !== snapshot.depreciationMethods.length) mismatches.push("depreciation method definitions differ");
      if (Number(preserved.alternate_methods) !== snapshot.alternateMethods.length) mismatches.push("alternate method definitions differ");
      if (Number(preserved.alternate_definitions) !== snapshot.alternateDefinitions.length) mismatches.push("alternate depreciation definitions differ");
      if (Number(preserved.asset_lifetimes) !== snapshot.assetLifetimes.length) mismatches.push("asset lifetime rows differ");
      if (Number(preserved.orphan_history) !== orphanHistory.length) mismatches.push("orphan depreciation history differs");
    }

    const targetLedgerResult = (await db.execute(sql`
      select a.account_ref,
             coalesce(sum(jl.amount) filter (where je.id is not null), 0)::text as balance
        from (
          select id, custom->>${source.refKey} as account_ref
            from accounts
           where org_id = ${options.orgId}
             and custom->>${source.refKey} = any(${`{${fixedAssetAccountRefs.join(",")}}`}::text[])
        ) a
        left join journal_lines jl on jl.account_id = a.id
        left join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
       group by a.account_ref
    `)) as unknown as { rows: { account_ref: string; balance: string }[] };
    const targetLedgerBalances = new Map(targetLedgerResult.rows.map((row) => [row.account_ref, money(row.balance)]));
    const ledgerBalances = fixedAssetAccountRefs.map((accountRef) => {
      const sourceBalance = money(sourceLedgerBalances.get(accountRef) ?? "0");
      const targetBalance = money(targetLedgerBalances.get(accountRef) ?? "0");
      if (toUnits(sourceBalance) !== toUnits(targetBalance)) {
        mismatches.push(`fixed-asset account ${accountRef} balance ${targetBalance} != ${sourceBalance}`);
      }
      return { accountRef, source: sourceBalance, target: targetBalance };
    });
    if (mismatches.length) throw new Error(`NetSuite FAM reconciliation failed: ${mismatches.join("; ")}`);

    return {
      source: {
        assets: snapshot.assets.length,
        assetTypes: snapshot.assetTypes.length,
        depreciationHistory: snapshot.depreciationHistory.length,
        assetValues: snapshot.assetValues.length,
        sourceCost: fromUnits(sourceCost),
        sourceAccumulatedDepreciation: fromUnits(sourceAccumulated),
        sourceNetBookValue: fromUnits(sourceBookValue),
      },
      target: {
        categories: Number(target.categories),
        assets: Number(target.assets),
        schedules: Number(target.schedules),
        scheduleLines: Number(target.schedule_lines),
        acquisitionCost: targetCost,
        accumulatedDepreciation: targetAccumulated,
        netBookValue: targetNbv,
      },
      created: { categories: createdCategories, assets: createdAssets },
      updated: { categories: updatedCategories, assets: updatedAssets },
      orphanHistoryRows: orphanHistory.length,
      fixedAssetLedger: {
        sourceTransactions: sourceTransactionIds.length,
        existingTransactions: sourceTransactionIds.length - missingTransactionIds.length,
        importedTransactions: importedLedgerTransactions,
        balances: ledgerBalances,
      },
      mismatches,
    };
  });
}
