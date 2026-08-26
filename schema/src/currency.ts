import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, orgRef } from "./helpers";

/** Tenant-owned automatic FX feed. Credentials are AES-GCM sealed JSON. */
export const fxProviderConfigs = pgTable(
  "fx_provider_configs",
  {
    id: id(),
    orgId: orgRef(),
    provider: text("provider", { enum: ["bank_of_canada", "ecb", "open_exchange_rates"] }).notNull(),
    displayName: text("display_name").notNull(),
    baseCurrency: currencyCode("base_currency").notNull(),
    currencies: jsonb("currencies").$type<string[]>().notNull().default([]),
    schedule: text("schedule", { enum: ["manual", "daily", "weekdays", "weekly"] }).notNull().default("daily"),
    syncHourUtc: integer("sync_hour_utc").notNull().default(22),
    lookbackDays: integer("lookback_days").notNull().default(7),
    isEnabled: boolean("is_enabled").notNull().default(false),
    /** Sealed JSON, currently { apiKey } for Open Exchange Rates. */
    secrets: text("secrets"),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastObservationDate: date("last_observation_date"),
    lastError: text("last_error"),
    ...auditColumns,
  },
  (t) => [uniqueIndex("fx_provider_configs_org").on(t.orgId), index("fx_provider_configs_due").on(t.isEnabled, t.nextSyncAt)],
);

/** Immutable operational history for test/manual/scheduled provider calls. */
export const fxProviderRuns = pgTable(
  "fx_provider_runs",
  {
    id: id(),
    orgId: orgRef(),
    providerConfigId: uuid("provider_config_id").notNull(),
    trigger: text("trigger", { enum: ["test", "manual", "scheduler"] }).notNull(),
    status: text("status", { enum: ["running", "ok", "failed"] }).notNull().default("running"),
    requestedFrom: date("requested_from"),
    requestedTo: date("requested_to"),
    observationsReceived: integer("observations_received").notNull().default(0),
    ratesInserted: integer("rates_inserted").notNull().default(0),
    ratesUpdated: integer("rates_updated").notNull().default(0),
    manualOverridesPreserved: integer("manual_overrides_preserved").notNull().default(0),
    errorMessage: text("error_message"),
    /** Random per-claim fencing token; rate application and completion/failure
     *  stamps must match the active running claim (see migration 0057). */
    leaseToken: uuid("lease_token"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
  },
  (t) => [index("fx_provider_runs_org_started").on(t.orgId, t.startedAt), index("fx_provider_runs_config_started").on(t.providerConfigId, t.startedAt)],
);
