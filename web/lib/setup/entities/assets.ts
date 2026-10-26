/** Setup-registry assets entities (split from registry.ts; pure moves only). */
import type { SetupEntity, SetupEntityValidationHook } from "../types";
import {
  POOL_METHODS,
  TAX_DEPRECIATION_MODELS,
  MACRS_SYSTEMS,
  MACRS_METHODS,
  TAX_DEPRECIATION_CONVENTIONS,
  DEPRECIATION_METHODS,
  CAPITALIZATION_MATCH_KINDS,
  DEPRECIATION_CONVENTIONS,
  END_OF_LIFE,
} from "../options";
import { MAX_DEPRECIATION_PERIODS } from "@openbooks/engine/assets/depreciation-limits";

/**
 * A capitalization rule names exactly one match target for its kind: an
 * account, an item, or an item category. The table's checks enforce the same
 * shape; this names the remedy before the write.
 */
const validateCapitalizationRuleWrite: SetupEntityValidationHook = async ({ body, rowId }) => {
  if (rowId) return null;
  const kind = String(body.matchKind ?? "");
  const present = (key: string) =>
    body[key] !== undefined && body[key] !== null && String(body[key]).trim() !== "";
  if (
    kind === "account" &&
    (!present("accountId") || present("itemId") || present("itemCategory"))
  ) {
    return "An account rule names the account only; clear the item and item category.";
  }
  if (kind === "item" && (!present("itemId") || present("accountId") || present("itemCategory"))) {
    return "An item rule names the item only; clear the account and item category.";
  }
  if (
    kind === "item_category" &&
    (!present("itemCategory") || present("accountId") || present("itemId"))
  ) {
    return "An item-category rule names the category only; clear the account and item.";
  }
  if (!["account", "item", "item_category"].includes(kind))
    return "Choose what the rule matches: an account, an item or an item category.";
  return null;
};

export const ASSET_ENTITIES: SetupEntity[] = [
  // --- Assets --------------------------------------------------------------
  {
    key: "asset-categories",
    table: "asset_categories",
    actorCols: true,
    groupKey: "assets",
    featureKey: "fixedAssets",
    iconKey: "landmark",
    orgScoped: true,
    orderBy: "name",
    hasActive: true,
    docSlug: "fixed-assets-depreciation",
    columns: [
      { key: "name", kind: "text" },
      { key: "defaultMethod", kind: "text" },
      { key: "defaultLifeMonths", kind: "number" },
      { key: "isActive", kind: "badge-active" },
    ],
    fields: [
      { key: "name", kind: "text", required: true },
      { key: "assetAccountId", kind: "ref", ref: "accounts", required: true },
      { key: "accumulatedDepreciationAccountId", kind: "ref", ref: "accounts", required: true },
      { key: "depreciationExpenseAccountId", kind: "ref", ref: "accounts", required: true },
      { key: "gainLossAccountId", kind: "ref", ref: "accounts" },
      { key: "defaultMethod", kind: "select", options: DEPRECIATION_METHODS },
      { key: "defaultDepreciationMethodId", kind: "ref", ref: "depreciation-methods" },
      {
        key: "defaultConvention",
        kind: "select",
        options: DEPRECIATION_CONVENTIONS,
        keepDefault: true,
      },
      { key: "defaultLifeMonths", kind: "integer", min: 1, max: MAX_DEPRECIATION_PERIODS },
      { key: "taxAttributes", kind: "json", keepDefault: true },
      { key: "isActive", kind: "boolean" },
    ],
  },
  {
    // Configurable tax depreciation regimes (built-ins: ca_cca, uk_wda, au_pool,
    // nz_pool). Add a jurisdiction the engine doesn't ship, or shadow a built-in.
    key: "tax-regimes",
    rehomed: true, // subtab of Fixed Assets & Depreciation setup
    table: "tax_regimes",
    singularTitleKey: "entities.tax-regimes.singularTitle",
    actorCols: true,
    groupKey: "assets",
    featureKey: "fixedAssets",
    iconKey: "landmark",
    orgScoped: true,
    naturalKey: "code",
    hasActive: true,
    docSlug: "setup-assets-group",
    columns: [
      { key: "code", kind: "code" },
      { key: "name", kind: "text" },
      { key: "countryCode", kind: "text" },
      { key: "calculationModel", kind: "text" },
      { key: "classAttribute", kind: "text" },
      { key: "isActive", kind: "badge-active" },
    ],
    fields: [
      { key: "code", kind: "text", required: true, lockedOnEdit: true },
      { key: "name", kind: "text", required: true },
      { key: "countryCode", kind: "country" },
      {
        key: "calculationModel",
        kind: "select",
        options: TAX_DEPRECIATION_MODELS,
        keepDefault: true,
      },
      { key: "classAttribute", kind: "text", keepDefault: true },
      { key: "isActive", kind: "boolean" },
    ],
  },
  {
    // Configurable pool CLASSES per regime (rate, method, first-year fraction,
    // recapture/terminal behavior). Org rows override the built-in class table.
    key: "tax-pool-classes",
    parentRecords: [{ entityKey: "tax-regimes", fieldKey: "regime", valueKey: "code" }],
    rehomed: true, // owned by the Tax Regime record drawer
    table: "tax_pool_classes",
    singularTitleKey: "entities.tax-pool-classes.singularTitle",
    actorCols: true,
    groupKey: "assets",
    featureKey: "fixedAssets",
    iconKey: "landmark",
    orgScoped: true,
    orderBy: "regime, class_code",
    hasActive: true,
    docSlug: "setup-assets-group",
    columns: [
      { key: "regime", kind: "text" },
      { key: "classCode", kind: "code" },
      { key: "name", kind: "text" },
      { key: "rate", kind: "number" },
      { key: "method", kind: "text" },
      { key: "isActive", kind: "badge-active" },
    ],
    fields: [
      { key: "regime", kind: "text", required: true },
      { key: "classCode", kind: "text", required: true, lockedOnEdit: true },
      { key: "name", kind: "text", required: true },
      { key: "rate", kind: "decimal", required: true },
      { key: "method", kind: "select", options: POOL_METHODS, keepDefault: true },
      { key: "firstYearFraction", kind: "decimal", keepDefault: true },
      { key: "allowRecapture", kind: "boolean", keepDefault: true },
      { key: "allowTerminalLoss", kind: "boolean", keepDefault: true },
      { key: "costCap", kind: "decimal" },
      { key: "depreciationSystem", kind: "select", options: MACRS_SYSTEMS },
      { key: "macrsMethod", kind: "select", options: MACRS_METHODS },
      { key: "recoveryPeriodYears", kind: "decimal" },
      { key: "convention", kind: "select", options: TAX_DEPRECIATION_CONVENTIONS },
      { key: "isActive", kind: "boolean" },
    ],
  },
  {
    // Dated first-year rules per regime/class (half-year rule, AII, immediate
    // expensing) — legislatively volatile, so config not code.
    key: "tax-first-year-rules",
    parentRecords: [{ entityKey: "tax-regimes", fieldKey: "regime", valueKey: "code" }],
    rehomed: true, // owned by the Tax Regime record drawer
    table: "tax_first_year_rules",
    singularTitleKey: "entities.tax-first-year-rules.singularTitle",
    actorCols: true,
    groupKey: "assets",
    featureKey: "fixedAssets",
    iconKey: "landmark",
    orgScoped: true,
    orderBy: "regime, class_code",
    hasActive: false,
    docSlug: "setup-assets-group",
    columns: [
      { key: "regime", kind: "text" },
      { key: "classCode", kind: "code" },
      { key: "firstYearFraction", kind: "number" },
      { key: "acquiredFrom", kind: "date" },
    ],
    fields: [
      { key: "regime", kind: "text", required: true },
      { key: "classCode", kind: "text" },
      { key: "acquiredFrom", kind: "date" },
      { key: "acquiredTo", kind: "date" },
      { key: "firstYearFraction", kind: "decimal", keepDefault: true },
      { key: "enhancedMultiplier", kind: "decimal" },
    ],
  },
  {
    // The depreciation formula builder — user-authored methods (formula over the
    // depreciation variable set: NB, OC, RV, AL, CP, …). Referenced by code from
    // an asset category's Default method.
    key: "depreciation-methods",
    rehomed: true, // subtab of Fixed Assets & Depreciation setup
    table: "depreciation_methods",
    actorCols: true,
    groupKey: "assets",
    featureKey: "fixedAssets",
    iconKey: "landmark",
    orgScoped: true,
    naturalKey: "code",
    hasActive: true,
    docSlug: "fixed-assets-depreciation",
    columns: [
      { key: "code", kind: "code" },
      { key: "name", kind: "text" },
      { key: "formula", kind: "text" },
      { key: "isActive", kind: "badge-active" },
    ],
    fields: [
      { key: "code", kind: "text", required: true, lockedOnEdit: true },
      { key: "name", kind: "text", required: true },
      { key: "formula", kind: "textarea", required: true },
      { key: "endOfLife", kind: "select", options: END_OF_LIFE, keepDefault: true },
      { key: "isActive", kind: "boolean" },
    ],
  },
  {
    // Multi-book: per-book, per-category depreciation policy (a tax/alternate book
    // runs a different method than the primary posting book).
    key: "depreciation-book-policies",
    rehomed: true, // subtab of Fixed Assets & Depreciation setup
    table: "depreciation_book_policies",
    actorCols: true,
    groupKey: "assets",
    featureKey: "fixedAssets",
    iconKey: "landmark",
    orgScoped: true,
    orderBy: "book_id, category_id",
    hasActive: false,
    docSlug: "fixed-assets-depreciation",
    columns: [
      { key: "bookId", kind: "ref", ref: "accounting-books" },
      { key: "categoryId", kind: "ref", ref: "asset-categories" },
      { key: "method", kind: "text" },
      { key: "lifeMonths", kind: "number" },
    ],
    fields: [
      { key: "bookId", kind: "ref", ref: "accounting-books", required: true },
      { key: "categoryId", kind: "ref", ref: "asset-categories", required: true },
      { key: "method", kind: "select", options: DEPRECIATION_METHODS, keepDefault: true },
      { key: "depreciationMethodId", kind: "ref", ref: "depreciation-methods" },
      { key: "lifeMonths", kind: "integer", min: 1, max: MAX_DEPRECIATION_PERIODS },
      { key: "ratePercent", kind: "percent" },
      { key: "unitsTotal", kind: "decimal" },
      { key: "convention", kind: "select", options: DEPRECIATION_CONVENTIONS, keepDefault: true },
    ],
  },
  {
    // Which posted purchase lines become asset proposals: one account, item
    // or item category, an optional legal entity, and the minimum amount to
    // capitalize, effective-dated. Terms are immutable once written; end a
    // rule and add a new one to change policy from a date forward.
    key: "asset-capitalization-rules",
    table: "asset_capitalization_rules",
    actorCols: true,
    groupKey: "assets",
    featureKey: "assetProposals",
    iconKey: "landmark",
    orgScoped: true,
    orderBy: "effective_from desc, name",
    hasActive: true,
    allowDelete: false,
    docSlug: "fixed-assets-depreciation",
    validateWrite: validateCapitalizationRuleWrite,
    columns: [
      { key: "name", kind: "text" },
      { key: "matchKind", kind: "text" },
      { key: "minimumAmount", kind: "number" },
      { key: "effectiveFrom", kind: "date" },
      { key: "isActive", kind: "badge-active" },
    ],
    fields: [
      { key: "name", kind: "text", required: true },
      {
        key: "matchKind",
        kind: "select",
        options: CAPITALIZATION_MATCH_KINDS,
        required: true,
        lockedOnEdit: true,
      },
      { key: "accountId", kind: "ref", ref: "accounts", lockedOnEdit: true },
      { key: "itemId", kind: "ref", ref: "items", lockedOnEdit: true },
      { key: "itemCategory", kind: "text", lockedOnEdit: true },
      { key: "subsidiaryId", kind: "ref", ref: "subsidiaries", lockedOnEdit: true },
      { key: "assetCategoryId", kind: "ref", ref: "asset-categories" },
      {
        key: "minimumAmount",
        kind: "decimal",
        decimalScale: 4,
        defaultValue: "0",
        required: true,
        lockedOnEdit: true,
      },
      { key: "effectiveFrom", kind: "date", required: true, lockedOnEdit: true },
      { key: "effectiveTo", kind: "date" },
      { key: "isActive", kind: "boolean" },
    ],
  },
];
