import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  resolveFeedSyncOverlapDays,
  syncBankFeedNow,
} from "@openbooks/engine/banking/bank-feed-providers";
import { can } from "../authz";
import {
  BankMatchRuleManagementError,
  createBankMatchRule,
  deleteBankMatchRule,
  updateBankMatchRule,
} from "../banking-rule-management";
import {
  BankingError,
  BANK_STATEMENT_PARSER_VERSION,
  autoMatch,
  confirmOpeningBalance,
  correctStatementLine,
  createGlClearingGroup,
  deleteStatementImport,
  excludePossibleDuplicates,
  excludeStatementLine,
  clearPossibleDuplicateFlag,
  importStatement,
  revalidateReconciliationSignOff,
  restoreStatementLine,
  unmatchGlClearingGroup,
  unmatchStatementImport,
  withdrawReconciliationSignOff,
} from "@openbooks/engine/banking/banking";
import { ControlAccountsIncompleteError } from "@openbooks/engine/records/control-accounts";
import { PostingError } from "@openbooks/engine/journal/contracts";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { applyRuleToLine, applyRulesToAccount, previewRules } from "../banking-rules";
import { validateCriteria, validateOutcome } from "../banking-rules-validate";
import { bankRulePriority } from "../banking-rule-priority";
import { recordPaymentAndMatch, SettlementMatchRefusal } from "../banking-match-candidates";
import { type ApplicationContext } from "./context";
import { ApplicationError, forbidden, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  assertTreasuryGate,
  DATE,
  IDEMPOTENCY_KEY,
  MONEY,
  settleDomainRefusal,
  UUID,
} from "./treasury-tools-common";
import { assertSubsidiaryAccess } from "./context";
import {
  BankFeedConnectionError,
  deleteBankFeedConnection,
  persistBankFeedConnection,
  testBankFeedConnectionForActor,
  updateBankFeedConnection,
} from "../bank-feed-connections";
import { reconcilableBankMembership } from "../banking-accounts";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { invalidInput } from "./errors";

function bankingContext(context: ApplicationContext) {
  return {
    orgId: context.authz.user.orgId,
    userId: context.authz.user.id,
    allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
  };
}

function settleBankingError(error: unknown): never {
  if (error instanceof ScopeNotFoundError) throw notFound("record");
  if (error instanceof SettlementMatchRefusal)
    settleDomainRefusal(error, error.status === 409 ? 409 : 422);
  if (
    error instanceof BankingError ||
    error instanceof PostingError ||
    error instanceof ControlAccountsIncompleteError
  ) {
    settleDomainRefusal(error, 422);
  }
  if (error && typeof error === "object" && "status" in error) settleDomainRefusal(error);
  throw error;
}

const statementLineInput = z.object({
  postedOn: DATE.describe("Bank transaction date."),
  amount: MONEY.describe("Signed bank amount as an exact decimal string."),
  description: z.string().nullable().optional().describe("Bank-provided transaction description."),
  counterpartyRef: z
    .string()
    .nullable()
    .optional()
    .describe("Bank-provided counterparty reference."),
  bankTransactionId: z
    .string()
    .nullable()
    .optional()
    .describe("Stable source transaction id when supplied by the bank."),
});

const expectedOpen = z
  .record(z.string(), MONEY)
  .describe("Expected exact open balance for each selected document line.");

export const TREASURY_BANKING_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_bank_feed_connections",
    title: "List Bank Feed Connections",
    description:
      "List configured bank feed connections, linked accounts, sync status, and credential-presence flags. Use returned ids for sync or connection maintenance; provider secrets are never returned.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "bankFeeds",
    execute: async (context) => {
      await assertTreasuryGate(context, "admin.setup.manage", "bankFeeds");
      const connections = await db.execute<Record<string, unknown>>(
        sql`
        select c.id, c.name, c.provider, c.account_id as "accountId", c.status,
               c.external_account_id as "externalAccountId", c.sync_cadence as "syncCadence",
               c.sync_overlap_days as "syncOverlapDays", c.next_sync_at as "nextSyncAt",
               c.last_sync_at as "lastSyncAt", c.last_attempt_at as "lastAttemptAt",
               c.last_result as "lastResult", c.last_error as "lastError", c.is_active as "isActive",
               (c.credentials is not null) as "hasCredentials", a.number as "accountNumber", a.name as "accountName"
          from bank_feed_connections c join accounts a on a.id=c.account_id and a.org_id=c.org_id
         where c.org_id=${context.authz.user.orgId} ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, context.authz.allowedSubsidiaryIds)}
         order by c.created_at desc
      `,
        "objects",
      );
      return { connections, href: "/admin/setup/bank-feeds" };
    },
  }),
  definition({
    name: "create_bank_feed_connection",
    title: "Create Bank Feed Connection",
    description:
      "Connect a reconcilable bank account to a manual, SFTP, Plaid, GoCardless, or TrueLayer statement feed. Use list_bank_accounts to choose an account; provider credentials are sealed before storage and only credential presence is returned.",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(200).describe("Operator-readable feed connection name."),
      provider: z
        .enum(["manual", "sftp", "plaid", "gocardless", "truelayer"])
        .describe("Statement feed source."),
      accountId: UUID.describe("Reconcilable bank account id from list_bank_accounts."),
      externalAccountId: z
        .string()
        .nullable()
        .optional()
        .describe("Provider's account identifier; required for Plaid."),
      syncCadence: z
        .enum(["manual", "hourly", "daily"])
        .optional()
        .describe("Automatic sync cadence for API providers."),
      syncOverlapDays: z
        .number()
        .int()
        .min(0)
        .max(90)
        .nullable()
        .optional()
        .describe("Days of overlap when syncing provider statement history."),
      credentials: z
        .record(z.string(), z.string())
        .nullable()
        .optional()
        .describe("Provider credentials to seal for API feed connection."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "bankFeeds",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "admin.setup.manage", "bankFeeds");
      const provider = input.provider;
      const externalAccountId = input.externalAccountId?.trim() || null;
      if (provider === "plaid" && !externalAccountId)
        throw invalidInput("Plaid account id is required");
      if (input.syncOverlapDays !== undefined && input.syncOverlapDays !== null) {
        try {
          resolveFeedSyncOverlapDays(input.syncOverlapDays);
        } catch {
          throw invalidInput("syncOverlapDays must be a whole number of days from 0 to 90");
        }
      }
      const account = (
        await db.execute<{ subsidiaryId: string | null }>(
          sql`
        select subsidiary_id as "subsidiaryId" from accounts where id=${input.accountId} and org_id=${context.authz.user.orgId} and ${reconcilableBankMembership()}
      `,
          "objects",
        )
      )[0];
      if (!account) throw invalidInput("not a reconcilable account");
      assertSubsidiaryAccess(context, account.subsidiaryId);
      const id = await persistBankFeedConnection(
        context.authz,
        {
          name: input.name,
          provider,
          accountId: input.accountId,
          externalAccountId,
          syncCadence: input.syncCadence ?? "daily",
          syncOverlapDays: input.syncOverlapDays ?? null,
          credentials: input.credentials ?? null,
        },
        context.requestId,
      );
      return {
        ok: true,
        id,
        status: provider === "manual" || provider === "sftp" ? "connected" : "pending",
        href: "/admin/setup/bank-feeds",
      };
    },
  }),
  definition({
    name: "sync_bank_feed_now",
    title: "Sync Bank Feed Now",
    description:
      "Fetch the latest statement activity from a connected bank feed and import its source evidence. Use list_bank_feed_connections to verify the provider and linked account; this contacts the provider and requires the linked account to be in your subsidiary scope.",
    inputSchema: z.object({
      connectionId: UUID.describe("Bank feed connection id from list_bank_feed_connections."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "bankFeeds",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "admin.setup.manage", "bankFeeds");
      const scoped = (
        await db.execute<{ subsidiaryId: string | null }>(
          sql`
        select a.subsidiary_id as "subsidiaryId" from bank_feed_connections c join accounts a on a.org_id=c.org_id and a.id=c.account_id
         where c.org_id=${context.authz.user.orgId} and c.id=${input.connectionId}
      `,
          "objects",
        )
      )[0];
      if (!scoped) throw notFound("record");
      assertSubsidiaryAccess(context, scoped.subsidiaryId);
      try {
        const result = await runOutsideTenantTransaction(context, () =>
          syncBankFeedNow(input.connectionId, {
            orgId: context.authz.user.orgId,
            userId: context.authz.user.id,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
        );
        return {
          ok: !result.error,
          connectionId: input.connectionId,
          ...result,
          status: result.error ? "error" : "synced",
          href: "/admin/setup/bank-feeds",
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "test_bank_feed_connection",
    title: "Test Bank Feed Connection",
    description:
      "Test a configured bank feed connection and persist its health status with secret-free audit evidence. Use list_bank_feed_connections to review the connection first; the provider is contacted and stale credential rotations are refused.",
    inputSchema: z.object({
      connectionId: UUID.describe("Bank feed connection id from list_bank_feed_connections."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "bankFeeds",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "admin.setup.manage", "bankFeeds");
      try {
        const result = await runOutsideTenantTransaction(context, () =>
          testBankFeedConnectionForActor(context.authz, input.connectionId, context.requestId),
        );
        return {
          ok: result.ok,
          connectionId: input.connectionId,
          ...result,
          status: result.ok ? "connected" : "error",
          href: "/admin/setup/bank-feeds",
        };
      } catch (error) {
        if (error instanceof BankFeedConnectionError)
          settleDomainRefusal({ message: error.message, status: error.status });
        throw error;
      }
    },
  }),
  definition({
    name: "update_bank_feed_connection",
    title: "Update Bank Feed Connection",
    description:
      "Change a visible bank feed connection's account label, provider binding, sync schedule, activity state, or credentials. Use list_bank_feed_connections to inspect the current setup; new provider credentials are sealed and status returns to pending.",
    inputSchema: z
      .object({
        connectionId: UUID.describe("Bank feed connection id from list_bank_feed_connections."),
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Updated operator-readable name."),
        externalAccountId: z
          .string()
          .nullable()
          .optional()
          .describe("Provider account binding, or null to clear it."),
        syncCadence: z
          .enum(["manual", "hourly", "daily"])
          .optional()
          .describe("Automatic sync cadence."),
        syncOverlapDays: z
          .number()
          .int()
          .min(0)
          .max(90)
          .nullable()
          .optional()
          .describe("Days of source overlap for provider sync."),
        isActive: z.boolean().optional().describe("Whether scheduled sync is active."),
        credentials: z
          .record(z.string(), z.string())
          .nullable()
          .optional()
          .describe("Replacement provider credentials; never returned by reads."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (value) =>
          Object.keys(value).some((key) => key !== "connectionId" && key !== "idempotencyKey"),
        { message: "At least one field must be provided." },
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "bankFeeds",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "admin.setup.manage", "bankFeeds");
      const { connectionId, idempotencyKey: _idempotencyKey, ...changes } = input;
      try {
        await updateBankFeedConnection(context.authz, connectionId, changes, context.requestId);
        return { ok: true, connectionId, status: "updated", href: "/admin/setup/bank-feeds" };
      } catch (error) {
        if (error instanceof BankFeedConnectionError)
          settleDomainRefusal({ message: error.message, status: error.status });
        throw error;
      }
    },
  }),
  definition({
    name: "delete_bank_feed_connection",
    title: "Delete Bank Feed Connection",
    description:
      "Delete a bank feed connection and retain its secret-free before-image in the audit log. Use list_bank_feed_connections to check the linked account and sync history; connections outside your subsidiary scope read as missing.",
    inputSchema: z.object({
      connectionId: UUID.describe("Bank feed connection id from list_bank_feed_connections."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "bankFeeds",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "admin.setup.manage", "bankFeeds");
      try {
        await deleteBankFeedConnection(context.authz, input.connectionId, context.requestId);
        return {
          ok: true,
          connectionId: input.connectionId,
          status: "deleted",
          href: "/admin/setup/bank-feeds",
        };
      } catch (error) {
        if (error instanceof BankFeedConnectionError)
          settleDomainRefusal({ message: error.message, status: error.status });
        throw error;
      }
    },
  }),
  definition({
    name: "preview_bank_match_rules",
    title: "Preview Bank Match Rules",
    description:
      "Dry-run active bank rules or a draft rule against recent statement lines without changing the ledger. Use list_bank_accounts for an account id and review matched, suggested, and refused rows before applying rules.",
    inputSchema: z.object({
      accountId: UUID.describe("Reconcilable bank account id from list_bank_accounts."),
      criteria: z
        .object({
          version: z.literal(2).describe("Rule criteria schema version."),
          match: z.json().describe("Boolean match condition tree."),
          accountScope: z
            .array(UUID)
            .max(1000)
            .optional()
            .describe("Optional account ids covered by the draft rule."),
        })
        .strict()
        .optional()
        .describe("Draft criteria to preview, or omit to preview active rules."),
      outcome: z
        .json()
        .optional()
        .describe("Draft rule outcome; defaults to excluding a matching line when omitted."),
      ruleId: UUID.optional().describe("Existing rule id for preview priority when editing."),
      priority: z.number().int().optional().describe("Draft rule order priority."),
      windowDays: z
        .number()
        .int()
        .min(1)
        .max(730)
        .optional()
        .describe("Lookback window; defaults to 90 days."),
      onlyUnmatched: z
        .boolean()
        .optional()
        .describe("Only include currently unmatched statement lines."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum recent lines to inspect; defaults to 25."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      let draftRule: NonNullable<Parameters<typeof previewRules>[2]>["draftRule"];
      if (input.criteria !== undefined || input.outcome !== undefined) {
        const criteria = validateCriteria(input.criteria);
        if (!criteria.ok) throw new ApplicationError("invalid_input", criteria.error, 400);
        const outcome = validateOutcome(input.outcome ?? { action: "exclude" });
        if (!outcome.ok) throw new ApplicationError("invalid_input", outcome.error, 400);
        draftRule = {
          criteria: criteria.value,
          outcome: outcome.value,
          priority: bankRulePriority(input.priority),
          id: input.ruleId,
        };
      }
      try {
        return await previewRules(context.authz.user.orgId, input.accountId, {
          draftRule,
          windowDays: input.windowDays ?? 90,
          onlyUnmatched: input.onlyUnmatched ?? false,
          limit: input.limit ?? 25,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "list_bank_match_rules",
    title: "List Bank Match Rules",
    description:
      "Read organization-wide bank reconciliation rules and their priorities before previewing or applying them. Use /banking/rules for the rule workflow; access is limited to unrestricted banking operators.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "banking.reconcile") && authz.allowedSubsidiaryIds === null,
    featureKey: "banking",
    execute: async (context) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
      const rules = await db.execute<Record<string, unknown>>(
        sql`select id, name, criteria, outcome, priority, is_active as "isActive", created_at as "createdAt", updated_at as "updatedAt" from bank_match_rules where org_id=${context.authz.user.orgId} order by priority asc, created_at asc`,
        "objects",
      );
      return { rules, href: "/banking/rules" };
    },
  }),
  definition({
    name: "create_bank_match_rule",
    title: "Create Bank Match Rule",
    description:
      "Create an audited automatic match or categorization rule after reviewing the existing rule order. Rules are organization-wide, so this requires unrestricted banking access; use preview_bank_match_rules before applying a rule set.",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(200).describe("Operator-readable rule name."),
      criteria: z
        .object({
          version: z.literal(2).describe("Rule criteria schema version."),
          match: z.json().describe("Validated boolean condition tree."),
          accountScope: z
            .array(UUID)
            .max(1000)
            .optional()
            .describe("Optional bank accounts to which the rule applies."),
        })
        .strict()
        .describe("Bank transaction matching conditions."),
      outcome: z.json().describe("Validated exclude, categorize, or split categorization result."),
      priority: z
        .number()
        .int()
        .optional()
        .describe("Rule evaluation priority; smaller values run first."),
      isActive: z.boolean().optional().describe("Whether this rule is enabled."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile") && authz.allowedSubsidiaryIds === null,
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
      try {
        const result = await createBankMatchRule(
          context.authz.user.orgId,
          context.authz.user.id,
          input,
        );
        return {
          ok: true,
          ...result,
          status: "created",
          href: `/banking/rules?rule=${encodeURIComponent(result.id)}`,
        };
      } catch (error) {
        if (error instanceof BankMatchRuleManagementError)
          settleDomainRefusal({ message: error.message, status: error.status });
        throw error;
      }
    },
  }),
  definition({
    name: "update_bank_match_rule",
    title: "Update Bank Match Rule",
    description:
      "Replace an existing bank rule's conditions, outcome, priority, or active state. Read list_bank_match_rules to review its current behavior first; the update is organization-wide and requires unrestricted banking access.",
    inputSchema: z.object({
      ruleId: UUID.describe("Bank matching rule id from list_bank_match_rules."),
      name: z.string().trim().min(1).max(200).describe("Operator-readable rule name."),
      criteria: z
        .object({
          version: z.literal(2).describe("Rule criteria schema version."),
          match: z.json().describe("Validated boolean condition tree."),
          accountScope: z
            .array(UUID)
            .max(1000)
            .optional()
            .describe("Optional bank accounts to which the rule applies."),
        })
        .strict()
        .describe("Bank transaction matching conditions."),
      outcome: z.json().describe("Validated exclude, categorize, or split categorization result."),
      priority: z
        .number()
        .int()
        .optional()
        .describe("Rule evaluation priority; smaller values run first."),
      isActive: z.boolean().optional().describe("Whether this rule is enabled."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile") && authz.allowedSubsidiaryIds === null,
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
      try {
        const { ruleId, ...body } = input;
        await updateBankMatchRule(context.authz.user.orgId, context.authz.user.id, ruleId, body);
        return {
          ok: true,
          ruleId,
          status: "updated",
          href: `/banking/rules?rule=${encodeURIComponent(ruleId)}`,
        };
      } catch (error) {
        if (error instanceof BankMatchRuleManagementError)
          settleDomainRefusal({ message: error.message, status: error.status });
        throw error;
      }
    },
  }),
  definition({
    name: "delete_bank_match_rule",
    title: "Delete Bank Match Rule",
    description:
      "Remove an organization-wide reconciliation rule and retain its before-image in the audit log. Review list_bank_match_rules and any pending suggestions first; unrestricted banking access is required.",
    inputSchema: z.object({
      ruleId: UUID.describe("Bank matching rule id from list_bank_match_rules."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile") && authz.allowedSubsidiaryIds === null,
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
      try {
        await deleteBankMatchRule(context.authz.user.orgId, context.authz.user.id, input.ruleId);
        return { ok: true, ruleId: input.ruleId, status: "deleted", href: "/banking/rules" };
      } catch (error) {
        if (error instanceof BankMatchRuleManagementError)
          settleDomainRefusal({ message: error.message, status: error.status });
        throw error;
      }
    },
  }),
  definition({
    name: "import_bank_statement",
    title: "Import Bank Statement",
    description:
      "Persist reviewed statement transactions for a reconcilable bank account with source evidence and duplicate checks. Use list_bank_accounts to find the account; parse the source file into dated signed lines before importing, then read the account's statement list to verify the result.",
    inputSchema: z.object({
      accountId: UUID.describe("Reconcilable bank account id from list_bank_accounts."),
      source: z
        .enum(["ofx", "csv", "camt053", "bai2", "mt940"])
        .describe("Original statement format."),
      sourceText: z
        .string()
        .min(1)
        .max(10_000_000)
        .describe("Original file contents retained as immutable source evidence."),
      filename: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe("Original upload filename, when available."),
      contentType: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe("Original file media type, when available."),
      lines: z
        .array(statementLineInput)
        .max(5000)
        .describe("Parsed transaction rows; balances and non-transaction rows are not included."),
      statementDate: DATE.nullable()
        .optional()
        .describe("Statement closing date from its source, when provided."),
      openingBalance: MONEY.nullable()
        .optional()
        .describe("Explicit opening balance from the source, when provided."),
      closingBalance: MONEY.nullable()
        .optional()
        .describe("Explicit closing balance from the source, when provided."),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .nullable()
        .optional()
        .describe("Statement currency code, when the source identifies it."),
      includePossibleDuplicates: z
        .boolean()
        .optional()
        .describe("true imports flagged possible duplicates for review; false leaves them out."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        const result = await importStatement(
          {
            accountId: input.accountId,
            source: input.source,
            lines: input.lines,
            statementDate: input.statementDate ?? null,
            openingBalance: input.openingBalance ?? null,
            closingBalance: input.closingBalance ?? null,
            currency: input.currency ?? null,
            sourceEvidence: {
              content: input.sourceText,
              filename: input.filename ?? null,
              contentType: input.contentType ?? null,
              parserVersion: BANK_STATEMENT_PARSER_VERSION,
            },
            includePossibleDuplicates: input.includePossibleDuplicates ?? false,
            dryRun: false,
          },
          bankingContext(context),
        );
        return {
          ok: true,
          statementId: result.statementId,
          imported: result.imported,
          duplicates: result.duplicates,
          possibleDuplicates: result.possibleDuplicates,
          skipped: result.skipped,
          status: "imported",
          href: "/banking/imports",
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "apply_bank_match_rules",
    title: "Apply Bank Match Rules",
    description:
      "Run active reconciliation rules against an account's unmatched bank lines, applying safe automatic matches or categorization and returning suggestions or refusals. Use list_bank_accounts to identify the account and read the bank reconciliation afterward to review the changed lines.",
    inputSchema: z.object({
      accountId: UUID.describe("Bank account id from list_bank_accounts."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        const result = await applyRulesToAccount(
          context.authz.user.orgId,
          context.authz.user.id,
          input.accountId,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, ...result, href: `/banking/${input.accountId}` };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "apply_bank_match_rule_to_line",
    title: "Apply Bank Match Rule To Line",
    description:
      "Accept one reconciliation rule for one unmatched statement line, creating its governed match or categorization. Use the bank-rule preview and reconciliation reads to obtain the line, rule, and optional session ids before accepting the proposal.",
    inputSchema: z.object({
      statementLineId: UUID.describe("Unmatched bank statement line id."),
      ruleId: UUID.describe("Active rule id from banking rules."),
      reconciliationId: UUID.optional().describe(
        "Open reconciliation session id, if the rule requires one.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        await applyRuleToLine(
          context.authz.user.orgId,
          context.authz.user.id,
          {
            statementLineId: input.statementLineId,
            ruleId: input.ruleId,
            reconciliationId: input.reconciliationId,
          },
          context.authz.allowedSubsidiaryIds,
        );
        return {
          ok: true,
          statementLineId: input.statementLineId,
          status: "matched",
          href: "/banking/match",
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "record_payment_and_match_bank_line",
    title: "Record Payment And Match Bank Line",
    description:
      "Create and post the customer receipt or vendor payment represented by one bank line, apply it to the selected open items, and match the line in one governed workflow. Use bank-line candidate reads and list_open_items to obtain ids and exact expected balances; permission for the payment side is checked by the native payment service.",
    inputSchema: z.object({
      statementLineId: UUID.describe("Unmatched statement line id."),
      reconciliationId: UUID.describe("Open reconciliation session id."),
      openLineIds: z
        .array(UUID)
        .min(1)
        .max(20)
        .describe("Open receivable or payable journal-line ids to settle."),
      expectedOpen,
      applied: z
        .record(z.string(), MONEY)
        .nullable()
        .optional()
        .describe("Exact amounts applied per open line; omit to settle each in full."),
      writeOff: z
        .object({
          reason: z
            .string()
            .trim()
            .min(1)
            .max(500)
            .describe("Reason for writing off the short-paid remainder."),
          discountAccountId: UUID.nullable()
            .optional()
            .describe("Discount/write-off account id, when required."),
        })
        .nullable()
        .optional()
        .describe("Optional governed short-payment write-off."),
      exchangeRate: z
        .object({
          rate: z.string().min(1).max(40).describe("Exact evidenced exchange rate."),
          source: z.string().min(1).max(120).describe("Rate source."),
          reason: z.string().min(1).max(500).describe("Why this rate was used."),
        })
        .nullable()
        .optional()
        .describe(
          "Required evidenced rate when the statement currency differs from the payment currency.",
        ),
      settlementRates: z
        .record(
          z.string(),
          z.union([
            z.object({ fxRateId: UUID.describe("Saved FX-rate evidence id.") }),
            z.object({
              rate: z.string().min(1).max(40).describe("Exact exchange rate."),
              source: z.string().min(1).max(120).describe("Rate source."),
              reason: z.string().min(1).max(500).describe("Why this rate was used."),
            }),
          ]),
        )
        .nullable()
        .optional()
        .describe("Settlement rate evidence for each open item in another currency."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) =>
      can(authz, "banking.reconcile") && (can(authz, "ap.pay") || can(authz, "ar.pay")),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      if (!can(context.authz, "ap.pay") && !can(context.authz, "ar.pay"))
        throw forbidden("payment");
      try {
        const result = await recordPaymentAndMatch(
          context.authz.user.orgId,
          context.authz.user.id,
          {
            statementLineId: input.statementLineId,
            reconciliationId: input.reconciliationId,
            openLineIds: input.openLineIds,
            expectedOpen: input.expectedOpen,
            applied: input.applied ?? null,
            writeOff: input.writeOff ?? null,
            exchangeRate: input.exchangeRate ?? null,
            settlementRates: input.settlementRates ?? null,
          },
          context.authz.allowedSubsidiaryIds,
        );
        return {
          ok: true,
          ...result,
          status: "matched",
          href: `/banking/reconciliations?session=${encodeURIComponent(input.reconciliationId)}`,
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "auto_match_reconciliation",
    title: "Auto Match Reconciliation",
    description:
      "Match high-confidence exact bank-line and posted-journal candidates in an open reconciliation, with each journal line used at most once. Use get_reconciliation to review the session before matching and afterward to inspect the totals.",
    inputSchema: z.object({
      reconciliationId: UUID.describe("Open reconciliation session id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        const result = await autoMatch(input.reconciliationId, bankingContext(context));
        return {
          ok: true,
          ...result,
          href: `/banking/reconciliations?session=${encodeURIComponent(input.reconciliationId)}`,
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "confirm_reconciliation_opening_balance",
    title: "Confirm Reconciliation Opening Balance",
    description:
      "Confirm the opening book position of an account's first reconciliation when the statement has no opening-balance evidence. Use get_reconciliation to review its position and provide a reason for the exact opening amount.",
    inputSchema: z.object({
      reconciliationId: UUID.describe("First reconciliation session id."),
      openingBalance: MONEY,
      reason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .describe("Reason the opening position is being confirmed."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        const totals = await confirmOpeningBalance(
          input.reconciliationId,
          { openingBalance: input.openingBalance, reason: input.reason },
          bankingContext(context),
        );
        return {
          ok: true,
          reconciliationId: input.reconciliationId,
          totals,
          href: `/banking/reconciliations?session=${encodeURIComponent(input.reconciliationId)}`,
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "withdraw_reconciliation_sign_off",
    title: "Withdraw Reconciliation Sign Off",
    description:
      "Withdraw the newest reconciliation sign-off so a correction can be made in the reopened period. Use the reconciliation history to verify that this is the latest sign-off and provide the required reason.",
    inputSchema: z.object({
      reconciliationId: UUID.describe("Signed-off reconciliation id."),
      reason: z.string().trim().min(10).max(500).describe("Why the sign-off must be withdrawn."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        const result = await withdrawReconciliationSignOff(
          input.reconciliationId,
          input.reason,
          bankingContext(context),
        );
        return {
          ok: true,
          reconciliationId: input.reconciliationId,
          ...result,
          href: `/banking/reconciliations?session=${encodeURIComponent(input.reconciliationId)}`,
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "revalidate_reconciliation_sign_off",
    title: "Revalidate Reconciliation Sign Off",
    description:
      "Record a reviewed revalidation certificate for a signed-off reconciliation whose underlying evidence has changed, using the current preview digest as a concurrency fence. Use the revalidation preview to get the digest and provide the review reason.",
    inputSchema: z.object({
      reconciliationId: UUID.describe("Signed-off reconciliation id."),
      expectedDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe("Current digest returned by the revalidation preview."),
      reason: z.string().trim().min(10).max(500).describe("Review evidence for the revalidation."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.review_sign_off") || can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      if (
        !can(context.authz, "banking.review_sign_off") &&
        !can(context.authz, "banking.reconcile")
      )
        throw forbidden("banking.review_sign_off");
      if (!(await import("../features")).isFeatureEnabled(context.authz.user.orgId, "banking"))
        throw notFound("banking");
      try {
        const result = await revalidateReconciliationSignOff(
          input.reconciliationId,
          { expectedDigest: input.expectedDigest, reason: input.reason },
          bankingContext(context),
        );
        return {
          ok: true,
          reconciliationId: input.reconciliationId,
          ...result,
          href: `/banking/reconciliations?session=${encodeURIComponent(input.reconciliationId)}`,
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "create_gl_clearing_group",
    title: "Create GL Clearing Group",
    description:
      "Clear posted GL-only offsetting journal lines that have no bank counterpart by grouping them into one exactly zero-sum set. Use get_reconciliation to find eligible lines; nonzero totals or lines outside the cutoff refuse.",
    inputSchema: z.object({
      reconciliationId: UUID.describe("Open reconciliation session id."),
      journalLineIds: z
        .array(UUID)
        .min(1)
        .max(100)
        .describe("Posted lines on the reconciled account that sum exactly to zero."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        const totals = await createGlClearingGroup(
          { reconciliationId: input.reconciliationId, journalLineIds: input.journalLineIds },
          bankingContext(context),
        );
        return {
          ok: true,
          reconciliationId: input.reconciliationId,
          totals,
          href: `/banking/reconciliations?session=${encodeURIComponent(input.reconciliationId)}`,
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "unmatch_gl_clearing_group",
    title: "Unmatch GL Clearing Group",
    description:
      "Remove one GL-only clearing group so its posted journal lines return to the unreconciled queue. Use the reconciliation detail to identify the group's id; groups containing a bank statement line must be unmatched by that statement line.",
    inputSchema: z.object({
      reconciliationId: UUID.describe("Open reconciliation session id."),
      groupId: UUID.describe("GL-only clearing group id from reconciliation detail."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        const totals = await unmatchGlClearingGroup(
          { reconciliationId: input.reconciliationId, groupId: input.groupId },
          bankingContext(context),
        );
        return {
          ok: true,
          reconciliationId: input.reconciliationId,
          groupId: input.groupId,
          totals,
          href: `/banking/reconciliations?session=${encodeURIComponent(input.reconciliationId)}`,
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "unmatch_bank_statement_import",
    title: "Unmatch Bank Statement Import",
    description:
      "Unmatch every match group touching one imported statement's lines so the statement can be deleted. Signed-off history refuses; use the statement list to find the statement id and then read its account to verify released lines.",
    inputSchema: z.object({
      statementId: UUID.describe("Imported statement id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        const result = await unmatchStatementImport(input.statementId, bankingContext(context));
        return { ok: true, statementId: input.statementId, ...result, href: "/banking/imports" };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "delete_bank_statement_import",
    title: "Delete Bank Statement Import",
    description:
      "Delete an imported statement and its lines after any match groups have been removed; the import's historical audit evidence is retained. Use the statement list to find its id and check for linked matches first.",
    inputSchema: z.object({
      statementId: UUID.describe("Imported bank statement id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        const result = await deleteStatementImport(input.statementId, bankingContext(context));
        return {
          ok: true,
          statementId: input.statementId,
          ...result,
          status: "deleted",
          href: "/banking/imports",
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "exclude_bank_statement_line",
    title: "Exclude Bank Statement Line",
    description:
      "Exclude one unmatched imported line from reconciliation with a reason; the source statement and line remain available for audit. Use the unmatched bank-line read to obtain the line id and review why it should not be matched.",
    inputSchema: z.object({
      statementLineId: UUID.describe("Unmatched statement line id."),
      reason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .describe("Why this bank line is excluded from reconciliation."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        await excludeStatementLine(input.statementLineId, input.reason, bankingContext(context));
        return {
          ok: true,
          statementLineId: input.statementLineId,
          status: "excluded",
          href: "/banking/match",
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "restore_bank_statement_line",
    title: "Restore Bank Statement Line",
    description:
      "Restore a previously excluded statement line to the unmatched bank-line queue. Use the account reconciliation read to find the line id and verify it is eligible to return.",
    inputSchema: z.object({
      statementLineId: UUID.describe("Excluded statement line id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        await restoreStatementLine(input.statementLineId, bankingContext(context));
        return {
          ok: true,
          statementLineId: input.statementLineId,
          status: "unmatched",
          href: "/banking/match",
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "clear_bank_line_duplicate_flag",
    title: "Clear Bank Line Duplicate Flag",
    description:
      "Clear the possible-duplicate flag after reviewing the imported bank line. Use the statement-line read to confirm it is a legitimate transaction rather than a duplicate import.",
    inputSchema: z.object({
      statementLineId: UUID.describe("Statement line flagged as a possible duplicate."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        await clearPossibleDuplicateFlag(input.statementLineId, bankingContext(context));
        return {
          ok: true,
          statementLineId: input.statementLineId,
          status: "reviewed",
          href: "/banking/match",
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "exclude_bank_line_duplicates",
    title: "Exclude Bank Line Duplicates",
    description:
      "Bulk exclude all flagged unmatched duplicates on one bank account with a required reason. Use list_bank_accounts and the duplicate review queue to confirm the account before applying the decision.",
    inputSchema: z.object({
      accountId: UUID.describe("Bank account id owning the duplicate lines."),
      reason: z.string().trim().min(5).max(500).describe("Why all flagged lines are duplicates."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        const result = await excludePossibleDuplicates(
          input.accountId,
          input.reason,
          bankingContext(context),
        );
        return {
          ok: true,
          accountId: input.accountId,
          excluded: result.excluded,
          href: `/banking/${input.accountId}`,
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
  definition({
    name: "correct_bank_statement_line",
    title: "Correct Bank Statement Line",
    description:
      "Correct the date, signed amount, or description of an unmatched bank statement line while preserving the original import evidence and recording the correction. Use the statement-line read and provide only fields that need correction.",
    inputSchema: z
      .object({
        statementLineId: UUID.describe("Unmatched statement line id."),
        amount: MONEY.optional().describe("Correct exact signed amount."),
        postedOn: DATE.optional().describe("Correct transaction date."),
        description: z
          .string()
          .nullable()
          .optional()
          .describe("Correct bank description; null clears it."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (value) =>
          value.amount !== undefined ||
          value.postedOn !== undefined ||
          value.description !== undefined,
        "provide at least one field to correct",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "banking.reconcile"),
    featureKey: "banking",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "banking.reconcile", "banking");
      try {
        await correctStatementLine(
          input.statementLineId,
          {
            ...(input.amount !== undefined ? { amount: input.amount } : {}),
            ...(input.postedOn !== undefined ? { postedOn: input.postedOn } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
          },
          bankingContext(context),
        );
        return {
          ok: true,
          statementLineId: input.statementLineId,
          status: "corrected",
          href: "/banking/match",
        };
      } catch (error) {
        settleBankingError(error);
      }
    },
  }),
];
