import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Bank feed connections — the single registry of HOW statements reach a bank
 * account, unifying every provider under Company Settings → Bank Feeds:
 *
 *   - manual      : statements are uploaded by hand (no automation)
 *   - sftp        : a bank drops files on the built-in SFTP endpoint
 *                   (the sftp_servers / sftp_import_schedules machinery)
 *   - plaid       : Plaid Transactions (US/CA aggregator)
 *   - gocardless  : GoCardless Bank Account Data / Nordigen (pan-European, free)
 *   - truelayer   : TrueLayer Data API (UK/EU open banking)
 *
 * API providers store sealed credentials and are polled by the scheduler
 * (engine/src/bank-feed-providers.ts → importStatement, source 'feed_api').
 * `manual` and `sftp` carry no credentials — they document the account's feed
 * so the Banking cockpit can show one coherent connection list.
 */
export const bankFeedConnections = pgTable(
  "bank_feed_connections",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    provider: text("provider", {
      enum: ["manual", "sftp", "plaid", "gocardless", "truelayer"],
    }).notNull(),
    /** The reconcilable GL account this feed imports into. */
    accountId: uuid("account_id").notNull(),
    status: text("status", {
      enum: ["pending", "connected", "error", "disconnected"],
    })
      .notNull()
      .default("pending"),
    /** Sealed provider credentials (sealJson: secret_id/secret_key, access_token,
     *  requisition, client_id/secret, …). Never returned to the client. */
    credentials: text("credentials"),
    /** The provider's own account identifier to pull transactions for. */
    externalAccountId: text("external_account_id"),
    syncCadence: text("sync_cadence", { enum: ["manual", "hourly", "daily"] })
      .notNull()
      .default("daily"),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastResult: jsonb("last_result"),
    lastError: text("last_error"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("bank_feed_connections_org").on(t.orgId, t.isActive),
    index("bank_feed_connections_due").on(t.isActive, t.nextSyncAt),
  ],
);
