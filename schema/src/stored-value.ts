import { sql } from 'drizzle-orm';
import { bigint, boolean, date, foreignKey, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, currencyCode, fxRate, id, orgRef } from './helpers';
import { subsidiaries } from './subsidiaries';

/**
 * Stored value (gift cards and store credit) is a liability, never revenue.
 * Selling a gift card credits the liability; redemption debits it against AR.
 * `stored_value_entries` is the immutable subledger; corrections are reversal
 * entries. Storage shape for migration 0495, with the issuing subsidiary per
 * account and the functional equivalent plus rate per entry from 0527.
 */
export const storedValuePrograms = pgTable('stored_value_programs', {
  id: id(), orgId: orgRef(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['gift_card', 'store_credit'] }).notNull(),
  liabilityAccountId: uuid('liability_account_id'),
  breakageIncomeAccountId: uuid('breakage_income_account_id'),
  breakagePolicy: text('breakage_policy', { enum: ['none', 'proportional', 'remote'] }).notNull().default('none'),
  breakageRate: numeric('breakage_rate', { precision: 19, scale: 10 }).notNull().default('0'),
  expiryMonths: integer('expiry_months'),
  inactivityMonths: integer('inactivity_months').notNull().default(24),
  currency: currencyCode('currency'),
  isActive: boolean('is_active').notNull().default(true),
  custom: jsonb('custom').notNull().default({}),
  ...auditColumns,
}, t => [uniqueIndex('stored_value_programs_org_id_id').on(t.orgId, t.id),
  uniqueIndex('stored_value_programs_org_kind_name').on(t.orgId, t.kind, t.name)]);

export const storedValueAccounts = pgTable('stored_value_accounts', {
  id: id(), orgId: orgRef(),
  programId: uuid('program_id').notNull(),
  kind: text('kind', { enum: ['gift_card', 'store_credit'] }).notNull(),
  codeHash: text('code_hash').notNull(),
  codeLast4: text('code_last4').notNull(),
  customerPartyId: uuid('customer_party_id'),
  currency: currencyCode('currency').notNull(),
  issuedMinor: bigint('issued_minor', { mode: 'bigint' }).notNull().default(0n),
  balanceMinor: bigint('balance_minor', { mode: 'bigint' }).notNull().default(0n),
  breakageRecognizedMinor: bigint('breakage_recognized_minor', { mode: 'bigint' }).notNull().default(0n),
  status: text('status', { enum: ['active', 'frozen', 'closed', 'expired'] }).notNull().default('active'),
  expiresOn: date('expires_on'),
  lastActivityOn: date('last_activity_on').notNull().default(sql`CURRENT_DATE`),
  sourceDocumentId: uuid('source_document_id'),
  liabilityAccountId: uuid('liability_account_id'),
  /** The legal entity that owes the balance (→ subsidiaries). */
  subsidiaryId: uuid('subsidiary_id').notNull(),
  custom: jsonb('custom').notNull().default({}),
  ...auditColumns,
}, t => [uniqueIndex('stored_value_accounts_org_id_id').on(t.orgId, t.id),
  uniqueIndex('stored_value_accounts_org_code_hash').on(t.orgId, t.codeHash),
  foreignKey({
    columns: [t.orgId, t.subsidiaryId],
    foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    name: 'stored_value_accounts_subsidiary_id_fkey',
  })]);

export const storedValueEntries = pgTable('stored_value_entries', {
  id: id(), orgId: orgRef(),
  accountId: uuid('account_id').notNull(),
  kind: text('kind', { enum: ['issue', 'redeem', 'adjust', 'expire', 'breakage', 'reversal'] }).notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  balanceAfter: bigint('balance_after', { mode: 'bigint' }).notNull(),
  currency: currencyCode('currency').notNull(),
  /** The same movement in the account subsidiary's functional currency. */
  functionalAmountMinor: bigint('functional_amount_minor', { mode: 'bigint' }).notNull(),
  /** The card→functional rate the functional amount was priced at. */
  fxRate: fxRate('fx_rate').notNull(),
  documentId: uuid('document_id'),
  documentLineId: uuid('document_line_id'),
  journalEntryId: uuid('journal_entry_id'),
  idempotencyKey: text('idempotency_key').notNull(),
  reason: text('reason'),
  actorId: uuid('actor_id'),
  ...auditColumns,
}, t => [uniqueIndex('stored_value_entries_org_id_id').on(t.orgId, t.id),
  uniqueIndex('stored_value_entries_org_idempotency').on(t.orgId, t.idempotencyKey)]);
