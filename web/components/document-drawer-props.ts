import type { ReactNode } from "react";
import type { FormLayoutConfig } from "@openbooks/customization";
import type { DrawerMode } from "@/lib/drawer-mode";
import type { DocKindConfig } from "../lib/document-kinds";
import type { CustomFieldDefClient } from "./custom-field-inputs";
import type {
  BuiltinSegmentOpt,
  DocPayload,
  Opt,
  SegmentOpt,
  SubsidiaryOpt,
} from "./document-drawer-types";

export interface DocumentDrawerProps {
  payload: DocPayload;
  config: DocKindConfig;
  basePath: string;
  /** Related records retain their party/project/report drawer host. */
  relatedNavigation?: boolean;
  parties?: Opt[];
  accounts: Opt[];
  taxCodes?: Opt[];
  taxGroups?: Opt[];
  cards?: Opt[];
  /** Reconcilable card-liability accounts: the card picker fallback when no
   * card instruments exist. Only passed by loaders for
   * fundingSource='card' kinds. */
  cardAccounts?: Opt[];
  bankAccounts?: Opt[];
  departments: Opt[];
  projects: Opt[];
  locations?: Opt[];
  classes?: Opt[];
  segments?: SegmentOpt[];
  builtinSegments?: BuiltinSegmentOpt[];
  items?: Opt[];
  /** Active warehouses for the line-level stock-location picker. Only passed
   *  by loaders for kinds with inventory lines; empty/undefined (or a single
   *  location, which the writer stamps silently) renders NO picker. */
  stockLocations?: { id: string; code: string | null }[];
  /** The org's subsidiaries (depth-first tree order). Only passed by pages in
   *  multi-subsidiary orgs — empty/undefined renders NO subsidiary UI. */
  subsidiaries?: SubsidiaryOpt[];
  headerDefs: CustomFieldDefClient[];
  lineDefs: CustomFieldDefClient[];
  canCreate: boolean;
  canPost: boolean;
  /**
   * Unsaved create (`?doc=new&kind=`): the drawer edits a blank in-memory
   * payload with autosave disarmed — no revision machinery runs because no
   * persisted row exists. Save POSTs the collection once (Idempotency-Key
   * per drawer session) and routes to the persisted id; Cancel/close
   * navigates away and writes nothing. Reuses this same drawer, layout, and
   * validation — never a forked create form.
   */
  createMode?: boolean;
  /** Initial presentation mode. Creation flows request edit; existing records
   *  continue to default to view. Status and permission checks still apply. */
  initialMode?: DrawerMode;
  /** Resolved transaction form layout; when present the header + line columns
   *  render from it (move/hide/rename/custom fields). Omitted only for the
   *  defensive loading fallback used while a page is resolving. */
  layout?: FormLayoutConfig;
  /** Available org form layouts (for the per-record "Custom Form" picker). */
  availableLayouts?: { id: string; name: string; isDefault?: boolean }[];
  currentLayoutId?: string | null;
  /** Record-type key (for the form-preference API). */
  recordType?: string;
  /** User holds admin.customization.manage — shows the Customize entry that
   *  deep-links into the form designer for this record type. */
  canCustomize?: boolean;
  /** Optional kind-specific section rendered read-only at the bottom of the
   *  drawer body (e.g. online payment links on customer invoices). */
  afterContent?: ReactNode;
  /** Server-known entry-mode allocation gate (Allocations → entry
   *  distributions, parent gate resolved). Only `true` queries entry
   *  candidates; false or absent skips them, so an organization without the
   *  module never calls an endpoint the server must refuse. */
  allocationsEntryEnabled?: boolean;
  /** RMA create link resolved by the invoice loader's permission and feature gates. */
  returnAuthorizationHref?: string | null;
  /** Receive payment (posted invoice) or Pay bill (posted bill) link, opening
   *  the new payment with the party and this document preselected. Resolved
   *  by the loader from the open balance and the payment permission. */
  settlementHref?: string | null;
  /**
   * The organization is registered for Canadian goods tax, so a customer
   * invoice may compute it natively from the place of supply. Only then is
   * the selection offered; other organizations never see it.
   */
  nativeGoodsTaxAvailable?: boolean;
  /** Server-known promotions gate. When explicitly false the drawer renders
   *  no promotion action or chip instead of probing an endpoint the server
   *  must refuse. Undefined preserves the hidden default. */
  promotionsEnabled?: boolean;
  /** Tender settlement accounts for paid-at-sale kinds (bank + asset
   *  clearing). Only passed by the cash-sales loader; absent renders no
   *  tenders section. */
  tenderAccounts?: { id: string; number: string | null; name: string | null }[] | null;
  /** Prefilled-refund entry link for a posted cash sale, resolved by the
   *  cash-sales loader's permission and feature gates. */
  refundHref?: string | null;
  /** Prefilled-credit entry link for a posted vendor bill, resolved by the
   *  AP bills loader's permission and subsidiary gates. */
  creditHref?: string | null;
  /** Org default tender account (till defaults) prefill for new tenders. */
  defaultTenderAccountId?: string | null;
  /** Active employees for the close-out server picker on cash sales.
   *  Absent renders no server choice: tips pool for the house split. */
  serverOptions?: { value: string; label: string }[];
  /** cash_sales.deposit: record till drops from a posted cash sale. */
  canDeposit?: boolean;
  /** Till-drop destinations (configured deposit accounts). Empty renders
   *  the section with Company Settings as the remedy instead of a form. */
  depositAccounts?: { id: string; number: string | null; name: string | null }[] | null;
  /** Org-today default for the drop date, resolved by the loader. */
  depositDefaultDate?: string;
  /** Active marketplace facilitators for the "tax collected by" line column.
   *  Empty or absent hides the column: with no facilitator there is nothing
   *  to choose. Only sales kinds offer it (see marketplaceColumn). */
  marketplaceFacilitators?: { name: string }[];
  /** Active contractor-withholding registrations covering the bill's scope,
   *  resolved by the loader from withholding enrollments. Empty or absent
   *  hides the withholding treatment and direct-materials columns: with no
   *  registration there is nothing to classify, and scheme guidance never
   *  renders by default. Authority-generated documents keep their columns
   *  through generatedAuthority instead. */
  withholdingSchemes?: { code: string }[];
  /** Current amortization templates for the vendor bill line columns,
   *  resolved by the loader while Expense amortization is on. Absent hides
   *  the columns; stored line values still round-trip unchanged. */
  amortizationTemplates?: { id: string; label: string }[];
  /** Server-known stored-value gate. When explicitly false the tender
   *  section offers no gift card / store credit method. Undefined preserves
   *  the hidden default. */
  storedValueEnabled?: boolean;
}
