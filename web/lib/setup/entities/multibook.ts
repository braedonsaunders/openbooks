import type { SetupEntity, SetupField, SetupOption } from "../types";

/** Setup-registry multi-book entities (Accounting group, Multi-book accounting gate). */

const label = (key: string) => `multiBook.${key}`;
const field = (
  key: string,
  kind: SetupField["kind"],
  extra: Partial<SetupField> = {},
): SetupField => ({ key, kind, labelKey: label(`fields.${key}`), ...extra });

const RATE_TYPES: SetupOption[] = ["spot", "month_average"].map((value) => ({
  value,
  labelKey: label(`rateTypes.${value}`),
}));
const CHANGE_KINDS: SetupOption[] = ["activation", "catch_up", "deactivation", "settings"].map(
  (value) => ({ value, labelKey: label(`changeKinds.${value}`) }),
);
const OPENING_STRATEGIES: SetupOption[] = ["opening_balances", "full_history"].map((value) => ({
  value,
  labelKey: label(`openingStrategies.${value}`),
}));
const MODES: SetupOption[] = ["adjustment_only", "full"].map((value) => ({
  value,
  labelKey: label(`modes.${value}`),
}));

/**
 * A secondary book's base currency for one subsidiary, effective-dated.
 * Writes go through the book currency endpoint, which closes the prior
 * version, audits the reason and refuses a version that would reinterpret
 * entries the book already holds.
 */
export const ACCOUNTING_BOOK_CURRENCIES_ENTITY: SetupEntity = {
  key: "accounting-book-currencies",
  table: "accounting_book_currencies",
  groupKey: "accounting",
  featureKey: "multiBookAccounting",
  iconKey: "coins",
  orgScoped: true,
  actorCols: true,
  orderBy: "book_id, subsidiary_id, effective_from desc",
  hasActive: false,
  allowDelete: false,
  importVia: "none",
  singularTitleKey: "entities.accounting-book-currencies.singularTitle",
  docSlug: "multi-book-accounting",
  mutationPath: "/api/accounting-books/currencies",
  mutationCreateKeys: [
    "bookId",
    "subsidiaryId",
    "currency",
    "rateType",
    "effectiveFrom",
    "effectiveTo",
    "reason",
  ],
  mutationUpdateKeys: ["effectiveTo", "reason"],
  formDescriptionKey: label("currencyFormDescription"),
  columns: [
    { key: "bookId", kind: "ref", ref: "accounting-books", labelKey: label("fields.bookId") },
    {
      key: "subsidiaryId",
      kind: "ref",
      ref: "subsidiaries",
      labelKey: label("fields.subsidiaryId"),
    },
    { key: "currency", kind: "code", labelKey: label("fields.currency") },
    { key: "rateType", kind: "badge", options: RATE_TYPES, labelKey: label("fields.rateType") },
    { key: "effectiveFrom", kind: "date", labelKey: label("fields.effectiveFrom") },
    { key: "effectiveTo", kind: "date", labelKey: label("fields.effectiveTo") },
  ],
  fields: [
    field("bookId", "ref", {
      ref: "accounting-books",
      required: true,
      lockedOnEdit: true,
      helpTextKey: label("help.bookId"),
    }),
    field("subsidiaryId", "ref", { ref: "subsidiaries", required: true, lockedOnEdit: true }),
    field("currency", "ref", {
      ref: "currencies",
      required: true,
      lockedOnEdit: true,
      helpTextKey: label("help.currency"),
    }),
    field("rateType", "select", {
      options: RATE_TYPES,
      required: true,
      lockedOnEdit: true,
      defaultValue: "spot",
      helpTextKey: label("help.rateType"),
    }),
    field("effectiveFrom", "date", { required: true, lockedOnEdit: true }),
    field("effectiveTo", "date", { helpTextKey: label("help.effectiveTo") }),
    field("reason", "textarea", {
      required: true,
      fullWidth: true,
      resetOnEdit: true,
      helpTextKey: label("help.reason"),
    }),
  ],
};

/**
 * The account a secondary book carries a chart account in, effective-dated
 * and optionally per subsidiary. The endpoint refuses a mapping that changes
 * the statement class, breaks a currency restriction or targets an account
 * unavailable to a covered subsidiary.
 */
export const ACCOUNTING_BOOK_ACCOUNT_MAPS_ENTITY: SetupEntity = {
  key: "accounting-book-account-maps",
  table: "accounting_book_account_maps",
  groupKey: "accounting",
  featureKey: "multiBookAccounting",
  iconKey: "layers",
  orgScoped: true,
  actorCols: true,
  orderBy: "book_id, source_account_id, effective_from desc",
  hasActive: false,
  allowDelete: false,
  importVia: "none",
  singularTitleKey: "entities.accounting-book-account-maps.singularTitle",
  docSlug: "multi-book-accounting",
  mutationPath: "/api/accounting-books/account-maps",
  mutationCreateKeys: [
    "bookId",
    "subsidiaryId",
    "sourceAccountId",
    "targetAccountId",
    "effectiveFrom",
    "effectiveTo",
    "reason",
  ],
  mutationUpdateKeys: ["effectiveTo", "reason"],
  formDescriptionKey: label("mapFormDescription"),
  columns: [
    { key: "bookId", kind: "ref", ref: "accounting-books", labelKey: label("fields.bookId") },
    {
      key: "sourceAccountId",
      kind: "ref",
      ref: "accounts",
      labelKey: label("fields.sourceAccountId"),
    },
    {
      key: "targetAccountId",
      kind: "ref",
      ref: "accounts",
      labelKey: label("fields.targetAccountId"),
    },
    {
      key: "subsidiaryId",
      kind: "ref",
      ref: "subsidiaries",
      labelKey: label("fields.mapSubsidiaryId"),
    },
    { key: "effectiveFrom", kind: "date", labelKey: label("fields.effectiveFrom") },
    { key: "effectiveTo", kind: "date", labelKey: label("fields.effectiveTo") },
  ],
  fields: [
    field("bookId", "ref", {
      ref: "accounting-books",
      required: true,
      lockedOnEdit: true,
      helpTextKey: label("help.bookId"),
    }),
    field("sourceAccountId", "ref", { ref: "accounts", required: true, lockedOnEdit: true }),
    field("targetAccountId", "ref", {
      ref: "accounts",
      required: true,
      lockedOnEdit: true,
      helpTextKey: label("help.targetAccountId"),
    }),
    field("subsidiaryId", "ref", {
      ref: "subsidiaries",
      lockedOnEdit: true,
      labelKey: label("fields.mapSubsidiaryId"),
      helpTextKey: label("help.mapSubsidiaryId"),
    }),
    field("effectiveFrom", "date", { required: true, lockedOnEdit: true }),
    field("effectiveTo", "date", { helpTextKey: label("help.effectiveTo") }),
    field("reason", "textarea", {
      required: true,
      fullWidth: true,
      resetOnEdit: true,
      helpTextKey: label("help.reason"),
    }),
  ],
};

/**
 * The governed history of each book's replication. A new record is a
 * change: activate full replication from a date (with how earlier history
 * enters the book), catch up, deactivate, or set the book's currency
 * difference account. Records are never edited.
 */
export const ACCOUNTING_BOOK_REPLICATION_ENTITY: SetupEntity = {
  key: "accounting-book-replication",
  table: "accounting_book_replication_runs",
  groupKey: "accounting",
  featureKey: "multiBookAccounting",
  iconKey: "history",
  orgScoped: true,
  orderBy: "created_at desc",
  hasActive: false,
  allowUpdate: false,
  allowDelete: false,
  importVia: "none",
  singularTitleKey: "entities.accounting-book-replication.singularTitle",
  docSlug: "multi-book-accounting",
  mutationPath: "/api/accounting-books/replication",
  mutationCreateKeys: [
    "bookId",
    "kind",
    "replicationFrom",
    "openingStrategy",
    "currencyDifferenceAccountId",
    "reason",
  ],
  formDescriptionKey: label("replicationFormDescription"),
  columns: [
    { key: "bookId", kind: "ref", ref: "accounting-books", labelKey: label("fields.bookId") },
    { key: "kind", kind: "badge", options: CHANGE_KINDS, labelKey: label("fields.kind") },
    { key: "modeAfter", kind: "badge", options: MODES, labelKey: label("fields.modeAfter") },
    { key: "replicationFrom", kind: "date", labelKey: label("fields.replicationFrom") },
    { key: "replicatedCount", kind: "number", labelKey: label("fields.replicatedCount") },
    { key: "createdAt", kind: "date", labelKey: label("fields.createdAt") },
  ],
  fields: [
    field("bookId", "ref", {
      ref: "accounting-books",
      required: true,
      helpTextKey: label("help.bookId"),
    }),
    field("kind", "select", {
      options: CHANGE_KINDS,
      required: true,
      defaultValue: "activation",
      helpTextKey: label("help.kind"),
    }),
    field("replicationFrom", "date", {
      showWhen: { field: "kind", in: ["activation"] },
      clearWhenHidden: true,
      helpTextKey: label("help.replicationFrom"),
    }),
    field("openingStrategy", "select", {
      options: OPENING_STRATEGIES,
      showWhen: { field: "kind", in: ["activation"] },
      clearWhenHidden: true,
      defaultValue: "opening_balances",
      helpTextKey: label("help.openingStrategy"),
    }),
    field("currencyDifferenceAccountId", "ref", {
      ref: "accounts",
      showWhen: { field: "kind", in: ["activation", "settings"] },
      clearWhenHidden: true,
      refAccountTypes: ["income_other", "expense_other", "income", "expense", "equity"],
      helpTextKey: label("help.currencyDifferenceAccountId"),
    }),
    field("reason", "textarea", {
      required: true,
      fullWidth: true,
      helpTextKey: label("help.reason"),
    }),
  ],
};

export const MULTI_BOOK_ENTITIES: SetupEntity[] = [
  ACCOUNTING_BOOK_CURRENCIES_ENTITY,
  ACCOUNTING_BOOK_ACCOUNT_MAPS_ENTITY,
  ACCOUNTING_BOOK_REPLICATION_ENTITY,
];
