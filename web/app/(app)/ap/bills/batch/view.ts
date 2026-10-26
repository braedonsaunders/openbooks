import "server-only";
import { notFound } from "next/navigation";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { page, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { can, requirePermission } from "../../../../../lib/authz";
import { orgInfo } from "../../../../../lib/data";
import { DOC_KINDS, createPermission, postPermission } from "../../../../../lib/document-kinds";
import {
  accountOptions,
  isDocKindEnabled,
  partyOptions,
  taxCodeOptions,
  taxGroupOptions,
} from "../../../../../lib/documents";
import { currencyMinorUnits } from "../../../../../lib/iso-currencies";
import { isMultiSubsidiary, subsidiaryOptions } from "../../../../../lib/subsidiaries";
import type { BatchBillEntryProps, BatchTaxProfile } from "./BatchBillEntry";

const BATCH_BILL_KIND = "vendor_bill";

export type BatchBillEntryData = BatchBillEntryProps;

/**
 * Batch bill entry: many vendor bills keyed on one grid. The page needs the
 * same create permission as a single bill; posting needs the post permission,
 * and both are enforced again by the endpoints each row saves through. The
 * pickers are the bill drawer's own, scoped to the caller's subsidiaries.
 */
export async function loadBatchBillEntry(): Promise<BatchBillEntryData> {
  const authz = await requirePermission(createPermission(BATCH_BILL_KIND));
  const orgId = authz.user.orgId;
  if (!(await isDocKindEnabled(orgId, BATCH_BILL_KIND))) notFound();
  const scope = authz.allowedSubsidiaryIds;
  const [org, today, vendors, accounts, taxCodes, taxGroups, multiSubsidiary] = await Promise.all([
    orgInfo(orgId),
    businessToday(orgId),
    partyOptions("vendor", orgId, scope),
    accountOptions(DOC_KINDS[BATCH_BILL_KIND]!, orgId, scope),
    taxCodeOptions(orgId),
    taxGroupOptions(orgId),
    isMultiSubsidiary(orgId),
  ]);
  if (!org?.base_currency) throw new Error("Organization base currency is not configured");
  const entities = (await subsidiaryOptions(false, false, orgId)).filter(
    (option) => (!scope || scope.has(option.id)) && (multiSubsidiary || option.parentId === null),
  );
  const defaultEntity = entities[0];
  if (!defaultEntity) notFound();
  if (!defaultEntity.baseCurrency)
    throw new Error("An accessible legal entity with a configured functional currency is required");
  const subsidiaries = multiSubsidiary
    ? entities.map((option) => ({
        id: option.id,
        name: option.name,
        baseCurrency: option.baseCurrency,
      }))
    : null;
  const taxProfiles: BatchTaxProfile[] = [
    ...taxCodes.map((code) => ({
      value: `code:${code.id}`,
      label: code.code ?? code.name ?? "",
      components: code.tax_components ?? [],
    })),
    ...taxGroups.map((group) => ({
      value: `group:${group.id}`,
      label: group.code ?? group.name ?? "",
      components: group.tax_components ?? [],
    })),
  ];
  return {
    orgId,
    userId: authz.user.id,
    today,
    currency: defaultEntity.baseCurrency,
    minorUnits: currencyMinorUnits(defaultEntity.baseCurrency),
    vendors: vendors.map((vendor) => ({
      id: vendor.id,
      display_name: vendor.display_name ?? "",
      short_code: vendor.short_code ?? null,
    })),
    accounts: accounts.map((account) => ({
      id: account.id,
      number: account.number ?? null,
      name: account.name ?? "",
    })),
    taxProfiles,
    subsidiaries: subsidiaries && subsidiaries.length > 0 ? subsidiaries : null,
    defaultSubsidiaryId: defaultEntity.id,
    canPost: can(authz, postPermission(BATCH_BILL_KIND)),
    canCreateVendor: can(authz, "parties.manage"),
    helpHref: "/docs/batch-bill-entry",
  };
}

export function batchBillEntrySpec(data: BatchBillEntryData): PageSpec {
  return page({
    route: "/ap/bills/batch",
    // The entry grid owns its header actions (save all, post all), so it
    // renders its own list-page chrome.
    layout: "bare",
    header: [],
    body: [widgetBlock("batch-bill-entry", { ...data })],
  });
}
