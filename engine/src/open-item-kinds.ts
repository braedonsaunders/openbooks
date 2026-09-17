/**
 * Document kinds carrying an AR/AP open balance — the single population every
 * open-payables/open-receivables reader must agree on: the dashboard tiles
 * and AR/AP cockpits (`web/lib/cash/open-items.ts`), the formal aging and its
 * per-item detail (`web/lib/reports/aging.ts`), and the continuous-close
 * cash-alerts transcription (`engine/src/agents/cash.ts`). A kind added to
 * one reader and not the others is the P5.1 divergence class (AP tile ≠ AP
 * aging for orgs with outstanding expense reports); a source-text guard
 * (`engine/src/open-item-kinds.test.ts`) fails any literal kind list in
 * those readers, so the next kind joins here or nowhere.
 *
 * Deliberately NOT `web/lib/document-kinds.ts` AP_KINDS/AR_KINDS, even though
 * the memberships look alike. Those scope the bills/invoices LISTS and their
 * drawers (an expense report must never appear in the bills list — it has its
 * own), while these scope open BALANCES. Same-shaped names for different
 * concepts would invite exactly the conflation this module exists to kill:
 * keep list scope and balance membership on separate constants.
 *
 * AP includes `expense_report`: a posted out-of-pocket report is money the
 * company owes a person, and an aging of what we owe that omits it is
 * incomplete (F-u1-P5.1). Company-paid card spend stays out through the
 * posting invariant, not the list — card-liability control lines are never
 * stamped `is_open_item`, and every reader here filters on open-item lines
 * (openItems additionally joins the control account type), so only genuine
 * employee payables are admitted. No imports: this module must stay loadable
 * from engine, web, and (later) client-safe contexts alike.
 */
export const AR_OPEN_ITEM_KINDS = ["customer_invoice", "customer_credit"] as const;

export const AP_OPEN_ITEM_KINDS = ["vendor_bill", "expense_report", "vendor_credit"] as const;

export type OpenItemKind = (typeof AR_OPEN_ITEM_KINDS | typeof AP_OPEN_ITEM_KINDS)[number];
