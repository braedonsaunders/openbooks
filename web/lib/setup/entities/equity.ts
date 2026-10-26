/** Setup-registry equity entities: the effective-dated equity account policy (pure descriptor; validation attaches server-side). */
import type { SetupEntity } from "../types";

const EQUITY = ["equity"] as const;
const EXPENSE = ["cogs", "expense", "expense_other", "expense_deferred"] as const;
const CONVERTIBLE = ["liability_current_other", "liability_long_term", "equity"] as const;
const LIABILITY = ["liability_current_other", "liability_long_term"] as const;

export const EQUITY_ENTITIES: SetupEntity[] = [
  {
    // One version per legal entity and effective date. Versions are retained
    // history: a change is a new version from its date, so posted equity
    // entries keep the accounts they were posted to.
    key: "equity-account-policies",
    table: "equity_account_policies",
    groupKey: "accounting",
    featureKey: "equity",
    writePermission: "equity.manage",
    // A version is a governed equity action: the equity engine validates it
    // and submits it to any enabled Equity action Flow, which may hold it for
    // approval before it applies.
    command: { name: "recordEquityAccountPolicy", permission: "equity.manage", feature: "equity" },
    // Governed versions are recorded one at a time through the command, never in bulk.
    importVia: "none",
    iconKey: "book-open",
    orgScoped: true,
    actorCols: true,
    hasActive: false,
    allowUpdate: false,
    allowDelete: false,
    orderBy: "effective_from desc",
    columns: [
      { key: "subsidiaryId", kind: "ref", ref: "subsidiaries" },
      { key: "effectiveFrom", kind: "date" },
      { key: "commonStockAccountId", kind: "ref", ref: "accounts" },
      { key: "apicAccountId", kind: "ref", ref: "accounts" },
      { key: "compensationExpenseAccountId", kind: "ref", ref: "accounts" },
    ],
    fields: [
      { key: "subsidiaryId", kind: "ref", ref: "subsidiaries", required: true, legalEntity: true },
      { key: "effectiveFrom", kind: "date", required: true },
      {
        key: "commonStockAccountId",
        kind: "ref",
        ref: "accounts",
        required: true,
        refAccountTypes: EQUITY,
      },
      {
        key: "preferredStockAccountId",
        kind: "ref",
        ref: "accounts",
        required: true,
        refAccountTypes: EQUITY,
      },
      {
        key: "apicAccountId",
        kind: "ref",
        ref: "accounts",
        required: true,
        refAccountTypes: EQUITY,
      },
      {
        key: "apicShareBasedAccountId",
        kind: "ref",
        ref: "accounts",
        required: true,
        refAccountTypes: EQUITY,
        helpTextKey: "fieldHelp.apicShareBasedAccount",
      },
      {
        key: "compensationExpenseAccountId",
        kind: "ref",
        ref: "accounts",
        required: true,
        refAccountTypes: EXPENSE,
      },
      {
        key: "treasuryStockAccountId",
        kind: "ref",
        ref: "accounts",
        required: true,
        refAccountTypes: EQUITY,
      },
      {
        key: "convertibleInstrumentsAccountId",
        kind: "ref",
        ref: "accounts",
        required: true,
        refAccountTypes: CONVERTIBLE,
        helpTextKey: "fieldHelp.convertibleInstrumentsAccount",
      },
      // Mapped by the legal entities that carry interest-bearing notes or
      // early-exercisable options; a posting that needs one refuses until it is.
      { key: "interestExpenseAccountId", kind: "ref", ref: "accounts", refAccountTypes: EXPENSE },
      {
        key: "accruedInterestAccountId",
        kind: "ref",
        ref: "accounts",
        refAccountTypes: LIABILITY,
        helpTextKey: "fieldHelp.accruedInterestAccount",
      },
      {
        key: "earlyExerciseDepositAccountId",
        kind: "ref",
        ref: "accounts",
        refAccountTypes: LIABILITY,
        helpTextKey: "fieldHelp.earlyExerciseDepositAccount",
      },
      { key: "reason", kind: "textarea", required: true },
    ],
  },
];
