import { sql } from "drizzle-orm";
import type { CommercialDocumentKind } from "../records/commercial-document-kind.ts";
import type { GoodsTaxSnapshot } from "@openbooks/engine/tax";
import { db } from "../platform/db.ts";
import type { runRecordFlows } from "../flows/index.ts";
import type { CustomFieldViewer } from "../records/custom-fields.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import type { computeBillTotals, computeBillTotalsWithProvider } from "./document-totals.ts";
import type { DocumentLineInput } from "./document-input.ts";
import type { validateExtraDims } from "../organization/segments.ts";

/** The organization's base currency: a new draft's default and the totals fallback. */
export async function orgBaseCurrency(orgId: string): Promise<string> {
  const r = await db.execute<{ base_currency: string }>(
    sql`select base_currency from orgs where id = ${orgId}`,
    "objects",
  );
  return r[0]?.base_currency ?? "CAD";
}

export type PreparedDocumentTotals = Awaited<ReturnType<typeof computeBillTotalsWithProvider>>;

/** The caller's ship-from/ship-to override for provider tax, or null when none is stored. */
export function documentTaxProviderAddresses(custom: Record<string, unknown> | undefined): {
  shipFrom?: Record<string, string | null>;
  shipTo?: Record<string, string | null>;
} | null {
  if (!custom) return null;
  const raw = custom.taxProviderAddresses as Record<string, unknown> | undefined;
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new DocumentEditError(
      422,
      "document tax location override must be an object with shipFrom/shipTo addresses",
    );
  }
  return {
    ...(raw.shipFrom == null ? {} : { shipFrom: raw.shipFrom as Record<string, string | null> }),
    ...(raw.shipTo == null ? {} : { shipTo: raw.shipTo as Record<string, string | null> }),
  };
}

export interface DocumentEditContext {
  /** Internal, declaration-owned quote/order initialization; transport bodies cannot set it. */
  commercialKind?: CommercialDocumentKind;
  orgId: string;
  userId: string;
  /** Role-derived audience for custom-field values. Missing viewers fail closed. */
  customFieldViewer?: CustomFieldViewer;
  allowedSubsidiaryIds?: ReadonlySet<string> | null;
  /**
   * Customer scope asserted by the caller (a portal session, a signed link):
   * the new party binding names this customer party, proven owned by the
   * caller before the write. Replaces the actor-role subsidiary check for
   * that binding only; every other scope check still applies.
   */
  customerPartyId?: string | null;
  /** Provenance recorded on the transaction audit + flow events. */
  source: "ui" | "api" | "mcp" | "assistant" | "posted_correction";
  /** Fire on_update record flows after the edit commits (default true). */
  runFlows?: boolean;
  /**
   * Return the on_update flow event instead of firing it, for callers that
   * own a wider transaction: firing mid-transaction would run flows against
   * an uncommitted row over a separate connection. The caller fires the
   * returned event after its own commit. Only honored when runFlows is not
   * false; PATCH never sets it.
   */
  deferFlows?: boolean;
  /** Internal create-path provider preflight; never supplied by API callers. */
  precomputedTotals?: PreparedDocumentTotals | null;
  /**
   * An RMA inspection may stage a zero-priced vendor-return draft before an
   * operator selects the supplier receipt. This is honored only for that
   * initial create; later line saves and posting still require a disposition.
   */
  deferVendorReturnDisposition?: boolean;
}

/** The on_update flow event an edit would fire — returned, not fired, under ctx.deferFlows. */
export type DocumentUpdateFlowEvent = Parameters<typeof runRecordFlows>[0];

/** The transaction an edit's validation reads and writes run on. */
export type DocumentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Header segment values after validation refused any invalid assignment; null when none were supplied. */
export type ValidatedHeaderDims = Extract<
  ReturnType<typeof validateExtraDims>,
  { ok: true }
> | null;

/** The executor for pre-transaction validation: the caller's transaction when it owns the edit. */
export type DocumentEditRunner = DocumentTransaction | typeof db;

/** One validated line, ready to replace the document's persisted lines. */
export type PreparedDocumentLine = {
  accountId: string;
  itemId: string | null;
  description: string | null;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  amount: string;
  taxCodeId: string | null;
  taxGroupId: string | null;
  taxInputAmount: string;
  taxAmount: string;
  taxOverridden: boolean;
  withholdingTreatment: "labour" | "materials" | "excluded" | null;
  withholdingMaterialsCost: string | null;
  taxComponents: ReturnType<typeof computeBillTotals>["lines"][number]["taxComponents"];
  nativeGoodsTax?: GoodsTaxSnapshot;
  providerQuote?: ReturnType<typeof computeBillTotals>["lines"][number]["providerQuote"];
  marketplaceFacilitator: string | null;
  partyId: string | null;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  classId: string | null;
  workFrom?: string | null;
  workTo?: string | null;
  amortizationTemplateId: string | null;
  amortizationStartOn: string | null;
  amortizationEndOn: string | null;
  stockLocationId: string | null;
  extraDims: Record<string, string | null>;
  custom: Record<string, unknown>;
  distributionGroupId: string | null;
  distributionRuleId: string | null;
  distributionVersionId: string | null;
  distributionLocked: boolean;
};

/** The draft row as the edit transaction locked it. */
export type LockedEditDocument = {
  kind: string;
  status: string;
  updatedAt: string;
  partyId: string | null;
  subsidiaryId: string | null;
  extraDims: unknown;
};

/** A withholding input change written onto a generated bill's own source line. */
export type GeneratedWithholdingUpdate = {
  id: string;
  treatment: DocumentLineInput["withholdingTreatment"];
  cost: string | null;
};
