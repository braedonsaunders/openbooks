import type { SegmentDependencyRule } from "@openbooks/engine/organization/segment-dependency-rules";
import type { TaxComponentConfig } from "@openbooks/engine/tax/tax";

export type Opt = {
  id: string;
  display_name?: string;
  number?: string;
  name?: string;
  code?: string;
  rate?: string;
  label?: string;
  subsidiary_id?: string | null;
  /** The party's organization-defined short code; pickers match it as typed. */
  short_code?: string | null;
  tax_components?: TaxComponentConfig[];
  /** Settlement currency the account accepts (null = any). */
  currency_restriction?: string | null;
  /** The party's vendor or customer role currency, which a new document
   *  defaults to when a currency choice is offered. */
  currency?: string | null;
  /** True when the item carries an inventory costing profile (line pickers). */
  has_inventory_profile?: boolean | null;
};

export interface SubsidiaryOpt {
  id: string;
  name: string;
  /** Root = 0; used to indent the picker like a tree. */
  depth: number;
}
export interface SegmentOpt {
  id?: string;
  key: string;
  name: string;
  showOnHeader: boolean;
  showOnLines: boolean;
  values: { id: string; code: string | null; name: string }[];
  /** Dependency rules restricting this segment's values (segment value dependencies). */
  dependencies?: SegmentDependencyRule[];
}
export interface BuiltinSegmentOpt {
  id?: string;
  key: string;
  storageColumn: string | null;
  showOnHeader: boolean;
  showOnLines: boolean;
  dependencies?: SegmentDependencyRule[];
}

// Stable identities for the omitted-`segments`/`builtinSegments` defaults. A
// `= []` default would hand the drawer's `payload_` memo a fresh array on every
// render, and the render-time dirty tracker keys on that memo's identity —
// an ever-churning identity re-renders forever.
export const EMPTY_SEGMENTS: SegmentOpt[] = [];
export const EMPTY_BUILTIN_SEGMENTS: BuiltinSegmentOpt[] = [];
export const EMPTY_FACILITATORS: { name: string }[] = [];
/** One posted receipt or shipment a credit memo may still return against. */
export interface ReturnableSourceOption {
  movementId: string;
  movedAt: string;
  documentNumber: string | null;
  remaining: string;
  lotId: string | null;
  lotCode: string | null;
  serialId: string | null;
  serialCode: string | null;
  itemId: string;
  stockLocationId: string;
}

export interface LineRow extends Record<string, unknown> {
  /** Loader line id this row edits (empty = new row); the save round-trips
   *  it and a redraw adopts replacement ids via toRow. */
  lineId: string;
  /**
   * Client-only React identity for the line grid (never serialized — the
   * save payload picks explicit fields). Server ids are empty for new rows
   * and are replaced on every redraw, so neither can key the grid: without
   * this, a reorder/duplicate leaves two rows sharing one key and an
   * uncommitted cell draft commits onto the wrong line.
   */
  clientKey: string;
  accountId: string;
  itemId: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  costRate: string;
  billRate: string;
  billAmount: string;
  isBillable: boolean;
  departmentId: string;
  projectId: string;
  locationId: string;
  classId: string;
  /** First and last day of the work the line bills (YYYY-MM-DD or blank). */
  workFrom: string;
  workTo: string;
  /** Warehouse for inventory receipt/issue effects; blank unless the line's
   *  item is stocked. */
  stockLocationId: string;
  /** Amortization template the line defers through (blank = expense now) and
   *  its optional service window (YYYY-MM-DD or blank). */
  amortizationTemplateId: string;
  amortizationStartOn: string;
  amortizationEndOn: string;
  /** On a credit memo, the posted receipt or shipment this line returns.
   *  Blank = a purely financial credit line that moves no stock. The chosen
   *  movement carries its own lot/serial, so the row stores only its id. A
   *  vendor credit may instead store NO_RETURN_SENTINEL: an allowance with
   *  no goods returned, which settles commercially and moves no stock. */
  returnSourceMovementId: string;
  taxProfileId: string;
  amount: string;
  taxInputAmount: string;
  withholdingTreatment: string;
  withholdingMaterialsCost: string;
  taxOverridden: boolean;
  taxAmount: string;
  /** Marketplace collecting this line's tax (facilitator name); blank = the
   *  merchant collects. Round-trips through toRow and the save payload. */
  marketplaceFacilitator: string;
  /** Entry-mode distribution staging (exploded into child lines on save). */
  distributionGroupId: string;
  distributionRuleId: string;
  distributionRuleName: string;
  distributionVersionId: string;
  distributionLocked: boolean;
  /** Rule key staged for explosion; blank once the server materializes children. */
  distributionKey: string;
  /** Promotion code carried by a discount line; blank on ordinary lines. */
  promotionCode: string;
}

/** The distribution slice of a grid row: server line → row, row → collapse. */
export interface DistributionLineFields {
  distributionGroupId: string;
  distributionRuleId: string;
  distributionRuleName: string;
  distributionVersionId: string;
  distributionLocked: boolean;
  distributionKey: string;
}

/**
 * Distribution columns off a document-line read. Tolerant by design: the
 * read path gains these columns from A4, so a line without them (older
 * payloads, other writers) is simply ungrouped — never an error.
 */
export function distributionFieldsOf(line: Record<string, unknown>): DistributionLineFields {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    distributionGroupId: text(line.distribution_group_id),
    distributionRuleId: text(line.distribution_rule_id),
    distributionRuleName: text(line.distribution_rule_name),
    distributionVersionId: text(line.distribution_version_id),
    distributionLocked: line.distribution_locked === true,
    distributionKey: "",
  };
}

export function clearedDistributionFields(): DistributionLineFields {
  return {
    distributionGroupId: "",
    distributionRuleId: "",
    distributionRuleName: "",
    distributionVersionId: "",
    distributionLocked: false,
    distributionKey: "",
  };
}
export interface DocPayload {
  doc: Record<string, unknown>;
  lines: Record<string, unknown>[];
  tenders?: unknown;
}

/** The document header: `documents` plus the loader's joins. Dates, uuids
 *  and numerics arrive from the driver as strings; nullable columns,
 *  left-join columns and kind-specific extras stay nullable. Column
 *  nullability per schema (`balance_due` is loader-computed, so it also
 *  accepts numbers). */
export interface DocumentDoc extends Record<string, unknown> {
  id: string;
  status: string;
  currency: string;
  kind: string;
  payment_card_id: string | null;
  reference_number: string | null;
  party_name: string | null;
  memo: string | null;
  due_date: string | null;
  document_date: string | null;
  billing_method: string | null;
  updated_at: string;
  project_id: string | null;
  posting_date: string | null;
  payment_hold_reason: string | null;
  location_id: string | null;
  is_final_invoice: boolean;
  internal_notes: string | null;
  expected_pay_date: string | null;
  work_completed_on: string | null;
  entry_id: string | null;
  department_id: string | null;
  class_id: string | null;
  balance_due: string | number | null;
  total: string;
  tax_total: string;
  subtotal: string;
  subsidiary_id: string | null;
  party_id: string | null;
  extra_dims: Record<string, string | null>;
  document_number: string | null;
  custom: Record<string, unknown>;
}

/** Narrow a loader's untyped document row to the header fields this drawer
 *  reads. Loader rows always carry strings (or string maps for
 *  custom/extra_dims) here, so valid payloads pass through unchanged. */
export function asDocumentDoc(raw: Record<string, unknown>): DocumentDoc {
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  const dims = (value: unknown): Record<string, string | null> =>
    isLineMap(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, string | null] =>
              entry[1] === null || typeof entry[1] === "string",
          ),
        )
      : {};
  const decimal = (value: unknown): string | number | null =>
    typeof value === "string" || typeof value === "number" ? value : null;
  return {
    ...raw,
    id: text(raw.id) ?? "",
    status: text(raw.status) ?? "",
    currency: text(raw.currency) ?? "",
    kind: text(raw.kind) ?? "",
    payment_card_id: text(raw.payment_card_id),
    reference_number: text(raw.reference_number),
    party_name: text(raw.party_name),
    memo: text(raw.memo),
    due_date: text(raw.due_date),
    document_date: text(raw.document_date),
    billing_method: text(raw.billing_method),
    updated_at: text(raw.updated_at) ?? "",
    project_id: text(raw.project_id),
    posting_date: text(raw.posting_date),
    payment_hold_reason: text(raw.payment_hold_reason),
    location_id: text(raw.location_id),
    is_final_invoice: raw.is_final_invoice === true,
    internal_notes: text(raw.internal_notes),
    expected_pay_date: text(raw.expected_pay_date),
    work_completed_on: text(raw.work_completed_on),
    entry_id: text(raw.entry_id),
    department_id: text(raw.department_id),
    class_id: text(raw.class_id),
    balance_due: decimal(raw.balance_due),
    total: text(raw.total) ?? "0",
    tax_total: text(raw.tax_total) ?? "0",
    subtotal: text(raw.subtotal) ?? "0",
    subsidiary_id: text(raw.subsidiary_id),
    party_id: text(raw.party_id),
    extra_dims: dims(raw.extra_dims),
    document_number: text(raw.document_number),
    custom: isLineMap(raw.custom) ? raw.custom : {},
  };
}

/** Line text columns are uuids/text-or-null; numerics are handled with String(). */
export function lineText(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export function isLineMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
