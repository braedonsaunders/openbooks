/** Setup-registry point-of-sale entities: registers, drawer cash reasons and quick keys (pure descriptors; validation attaches server-side). */
import type { SetupEntity } from "../types";

/** Tender settlement accounts: bank plus asset clearing, the same set document tenders accept. */
const TENDER_ACCOUNT_TYPES = ["asset_bank", "asset_current_other"] as const;

const CASH_DIRECTION_OPTIONS = [
  { value: "pay_in", labelKey: "options.posCashDirection.payIn" },
  { value: "pay_out", labelKey: "options.posCashDirection.payOut" },
];

export const POS_ENTITIES: SetupEntity[] = [
  {
    // A register is the till's configuration. A tender kind is accepted
    // exactly when its settlement account is set, so there is one switch
    // per tender and no separate allow-list to drift from the accounts.
    key: "pos-registers",
    table: "pos_registers",
    actorCols: true,
    groupKey: "sales",
    featureKey: "posRegister",
    writePermission: "pos.manage",
    iconKey: "receipt",
    orgScoped: true,
    naturalKey: "code",
    hasActive: true,
    formSections: [
      {
        titleKey: "entities.pos-registers.singular",
        fields: ["code", "name", "subsidiaryId", "locationId", "stockLocationId", "isActive"],
      },
      { titleKey: "fields.defaultCustomerId", fields: ["defaultCustomerId", "priceLevelId"] },
      {
        titleKey: "fields.cashAccountId",
        fields: [
          "cashAccountId",
          "cardAccountId",
          "otherAccountId",
          "acceptsStoredValue",
          "denominations",
        ],
      },
      { titleKey: "fields.receiptHeader", fields: ["receiptHeader", "receiptFooter"] },
    ],
    columns: [
      { key: "code", kind: "code" },
      { key: "name", kind: "text" },
      { key: "subsidiaryId", kind: "ref", ref: "subsidiaries" },
      { key: "stockLocationId", kind: "ref", ref: "stock-locations" },
      { key: "cashAccountId", kind: "ref", ref: "accounts" },
      { key: "isActive", kind: "badge-active" },
    ],
    fields: [
      { key: "code", kind: "text", required: true, lockedOnEdit: true },
      { key: "name", kind: "text", required: true },
      {
        key: "subsidiaryId",
        kind: "ref",
        ref: "subsidiaries",
        required: true,
        legalEntity: true,
        lockedOnEdit: true,
      },
      { key: "locationId", kind: "ref", ref: "locations" },
      { key: "stockLocationId", kind: "ref", ref: "stock-locations" },
      {
        key: "defaultCustomerId",
        kind: "ref",
        ref: "customers",
        helpTextKey: "fieldHelp.posDefaultCustomer",
      },
      { key: "priceLevelId", kind: "ref", ref: "price-levels" },
      {
        key: "cashAccountId",
        kind: "ref",
        ref: "accounts",
        required: true,
        refAccountTypes: TENDER_ACCOUNT_TYPES,
        helpTextKey: "fieldHelp.posCashAccount",
      },
      {
        key: "cardAccountId",
        kind: "ref",
        ref: "accounts",
        refAccountTypes: TENDER_ACCOUNT_TYPES,
        helpTextKey: "fieldHelp.posCardAccount",
      },
      {
        key: "otherAccountId",
        kind: "ref",
        ref: "accounts",
        refAccountTypes: TENDER_ACCOUNT_TYPES,
        helpTextKey: "fieldHelp.posOtherAccount",
      },
      { key: "acceptsStoredValue", kind: "boolean", defaultValue: false, booleanStyle: "switch" },
      {
        key: "denominations",
        kind: "stringArray",
        arrayStorage: "text",
        keepDefault: true,
        helpTextKey: "fieldHelp.posDenominations",
      },
      { key: "receiptHeader", kind: "textarea" },
      { key: "receiptFooter", kind: "textarea" },
      {
        key: "isActive",
        kind: "boolean",
        defaultValue: true,
        booleanStyle: "switch",
        fullWidth: true,
      },
    ],
  },
  {
    // Why cash entered or left a drawer outside a sale, and the account the
    // movement posts against (float funding, supplies, petty expenses).
    key: "pos-cash-reasons",
    table: "pos_cash_reasons",
    actorCols: true,
    groupKey: "sales",
    featureKey: "posRegister",
    writePermission: "pos.manage",
    iconKey: "coins",
    orgScoped: true,
    naturalKey: "code",
    hasActive: true,
    columns: [
      { key: "code", kind: "code" },
      { key: "name", kind: "text" },
      { key: "direction", kind: "badge", options: CASH_DIRECTION_OPTIONS },
      { key: "accountId", kind: "ref", ref: "accounts" },
      { key: "isActive", kind: "badge-active" },
    ],
    fields: [
      { key: "code", kind: "text", required: true, lockedOnEdit: true },
      { key: "name", kind: "text", required: true },
      {
        key: "direction",
        kind: "select",
        required: true,
        lockedOnEdit: true,
        options: CASH_DIRECTION_OPTIONS,
      },
      { key: "accountId", kind: "ref", ref: "accounts", required: true },
      {
        key: "isActive",
        kind: "boolean",
        defaultValue: true,
        booleanStyle: "switch",
        fullWidth: true,
      },
    ],
    filters: [{ key: "direction", options: CASH_DIRECTION_OPTIONS }],
  },
  {
    key: "pos-quick-keys",
    table: "pos_quick_keys",
    actorCols: true,
    groupKey: "sales",
    featureKey: "posRegister",
    writePermission: "pos.manage",
    iconKey: "layers",
    orgScoped: true,
    orderBy: "position, label",
    hasActive: true,
    columns: [
      { key: "position", kind: "number" },
      { key: "itemId", kind: "ref", ref: "items" },
      { key: "label", kind: "text" },
      { key: "registerId", kind: "ref", ref: "pos-registers" },
      { key: "isActive", kind: "badge-active" },
    ],
    fields: [
      { key: "itemId", kind: "ref", ref: "items", required: true, searchableReferences: true },
      { key: "label", kind: "text" },
      { key: "position", kind: "integer", min: 0, max: 999, keepDefault: true },
      {
        key: "registerId",
        kind: "ref",
        ref: "pos-registers",
        helpTextKey: "fieldHelp.posQuickKeyRegister",
      },
      {
        key: "isActive",
        kind: "boolean",
        defaultValue: true,
        booleanStyle: "switch",
        fullWidth: true,
      },
    ],
  },
];
