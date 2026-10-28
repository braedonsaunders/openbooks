import "server-only";
import { fromUnits, toUnits } from "@openbooks/engine/money/money";
import {
  adjustStoredValue,
  issueStoredValue,
  loadStoredValueTenderAccount,
  lookupStoredValueByCode,
  setStoredValueStatus,
} from "@openbooks/engine/stored-value/accounts";
import { db } from "@openbooks/engine/platform/db";
import { listStoredValueCustomerCredits } from "@openbooks/engine/stored-value";
import { can } from "../authz";
import { type ApplicationContext } from "./context";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  assertTreasuryGate,
  DATE,
  IDEMPOTENCY_KEY,
  MONEY,
  settleDomainRefusal,
  UUID,
} from "./treasury-tools-common";
import { notFound } from "./errors";
import { z } from "zod";

function settleStoredValue(error: unknown): never {
  settleDomainRefusal(error);
}

async function scopedAccount(context: ApplicationContext, accountId: string) {
  const account = await loadStoredValueTenderAccount(
    context.authz.user.orgId,
    accountId,
    context.authz.allowedSubsidiaryIds,
  );
  if (!account) throw notFound("record");
  return account;
}

export const TREASURY_STORED_VALUE_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_stored_value_account",
    title: "Get Stored Value Account",
    description:
      "Read a stored value account's current balance and lifecycle state before adjusting or closing it. Copy the id from the stored value register; accounts outside your subsidiary scope read as missing.",
    inputSchema: z.object({
      accountId: UUID.describe("Stored value account id from the register."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "stored_value.read"),
    featureKey: "storedValue",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "stored_value.read", "storedValue");
      const account = await scopedAccount(context, input.accountId);
      return {
        ...account,
        balance: fromUnits(account.balanceMinor),
        href: `/stored-value?account=${encodeURIComponent(account.accountId)}`,
      };
    },
  }),
  definition({
    name: "lookup_stored_value_code",
    title: "Look Up Stored Value Code",
    description:
      "Resolve a customer-provided gift card or store credit code to its visible account and live balance before taking it as tender. Unknown codes and out-of-scope accounts read as missing.",
    inputSchema: z.object({
      code: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Gift card or store credit code supplied by the customer."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "stored_value.read"),
    featureKey: "storedValue",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "stored_value.read", "storedValue");
      const result = await lookupStoredValueByCode(
        context.authz.user.orgId,
        input.code,
        context.authz.allowedSubsidiaryIds,
      );
      if (!result) throw notFound("record");
      return {
        ...result,
        balance: fromUnits(BigInt(result.balanceMinor)),
        href: `/stored-value?account=${encodeURIComponent(result.accountId)}`,
      };
    },
  }),
  definition({
    name: "list_customer_stored_value_credits",
    title: "List Customer Stored Value Credits",
    description:
      "List positive store credit balances for a customer within your subsidiary scope. Use a party id from find_parties before attaching credit as tender to a receipt.",
    inputSchema: z.object({ partyId: UUID.describe("Customer party id from find_parties.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "stored_value.read"),
    featureKey: "storedValue",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "stored_value.read", "storedValue");
      const credits = await listStoredValueCustomerCredits(db, {
        orgId: context.authz.user.orgId,
        partyId: input.partyId,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      });
      if (!credits) throw notFound("record");
      return {
        credits: credits.map(({ balanceMinor, ...credit }) => ({
          ...credit,
          balance: fromUnits(BigInt(balanceMinor)),
        })),
      };
    },
  }),
  definition({
    name: "issue_stored_value",
    title: "Issue Stored Value",
    description:
      "Issue a gift card or store credit with an exact starting balance and balanced journal entry. Choose a program from setup records and read the new account at /stored-value; the plaintext code is returned only by the native issue result.",
    inputSchema: z.object({
      programId: UUID.describe("Active stored value program id from setup records."),
      amount: MONEY.describe("Exact amount to issue as a decimal string."),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .describe("ISO currency code for the issued value."),
      customerPartyId: UUID.nullable()
        .optional()
        .describe("Customer party id for customer-bound store credit or gift card."),
      subsidiaryId: UUID.nullable()
        .optional()
        .describe("Issuing legal entity id; required for restricted access."),
      expiresOn: DATE.nullable()
        .optional()
        .describe("Optional expiry date under the stored value program."),
      debitAccountId: UUID.describe("Asset or clearing account receiving consideration."),
      postingDate: DATE.optional().describe("Accounting date for the issuance journal."),
      memo: z.string().trim().max(1000).nullable().optional().describe("Optional issuance memo."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "stored_value.manage"),
    featureKey: "storedValue",
    cacheResponse: (value) => ({ ...value, code: null }),
    execute: async (context, input) => {
      await assertTreasuryGate(context, "stored_value.manage", "storedValue");
      try {
        const result = await issueStoredValue({
          orgId: context.authz.user.orgId,
          programId: input.programId,
          amountMinor: toUnits(input.amount),
          currency: input.currency,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          subsidiaryId: input.subsidiaryId ?? null,
          customerPartyId: input.customerPartyId ?? null,
          expiresOn: input.expiresOn ?? null,
          debitAccountId: input.debitAccountId,
          postingDate: input.postingDate ?? null,
          memo: input.memo ?? null,
          idempotencyKey: input.idempotencyKey,
          actorId: context.authz.user.id,
        });
        return {
          ok: true,
          ...result,
          href: `/stored-value?account=${encodeURIComponent(result.accountId)}`,
        };
      } catch (error) {
        settleStoredValue(error);
      }
    },
  }),
  definition({
    name: "adjust_stored_value_balance",
    title: "Adjust Stored Value Balance",
    description:
      "Post an audited, balanced correction to a stored value balance with a reason and offset account. Read the account first to confirm its entity and balance; negative adjustments cannot exceed the remaining balance.",
    inputSchema: z.object({
      accountId: UUID.describe("Stored value account id from get_stored_value_account."),
      delta: MONEY.describe("Exact signed correction amount as a decimal string."),
      reason: z
        .string()
        .trim()
        .min(8)
        .max(1000)
        .describe("Audit reason for the balance correction."),
      offsetAccountId: UUID.describe("Offset account for the balanced correction."),
      postingDate: DATE.optional().describe("Accounting date for the correction journal."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "stored_value.adjust"),
    featureKey: "storedValue",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "stored_value.adjust", "storedValue");
      try {
        const result = await adjustStoredValue({
          orgId: context.authz.user.orgId,
          accountId: input.accountId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          deltaMinor: toUnits(input.delta),
          reason: input.reason,
          offsetAccountId: input.offsetAccountId,
          postingDate: input.postingDate ?? null,
          idempotencyKey: input.idempotencyKey,
          actorId: context.authz.user.id,
        });
        return {
          ok: true,
          entryId: result.entryId,
          journalEntryId: result.journalEntryId,
          balance: fromUnits(result.balanceMinor),
          status: "adjusted",
          href: `/stored-value?account=${encodeURIComponent(input.accountId)}`,
        };
      } catch (error) {
        settleStoredValue(error);
      }
    },
  }),
  definition({
    name: "set_stored_value_account_status",
    title: "Set Stored Value Account Status",
    description:
      "Freeze, unfreeze, or close a stored value account through its audited lifecycle. Read the account first; closure requires a zero balance and records the reason.",
    inputSchema: z.object({
      accountId: UUID.describe("Stored value account id from get_stored_value_account."),
      to: z.enum(["active", "frozen", "closed"]).describe("Target lifecycle state."),
      reason: z
        .string()
        .trim()
        .max(1000)
        .nullable()
        .optional()
        .describe("Reason for the status change."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "stored_value.manage"),
    featureKey: "storedValue",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "stored_value.manage", "storedValue");
      try {
        await setStoredValueStatus({
          orgId: context.authz.user.orgId,
          accountId: input.accountId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          to: input.to,
          reason: input.reason ?? null,
          actorId: context.authz.user.id,
        });
        return {
          ok: true,
          accountId: input.accountId,
          status: input.to,
          href: `/stored-value?account=${encodeURIComponent(input.accountId)}`,
        };
      } catch (error) {
        settleStoredValue(error);
      }
    },
  }),
];
