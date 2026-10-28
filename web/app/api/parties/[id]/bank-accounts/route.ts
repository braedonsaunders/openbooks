import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { authorizePartyBankWrite } from "./party-scope";
import {
  bankAccountCreateBody,
  bankAccountPatchBody,
  bankAccountRetirementBody,
  createPartyBankAccount,
  retirePartyBankAccount,
  updatePartyBankAccount,
} from "@/lib/party-bank-account-actions";

export const runtime = "nodejs";

export const POST = defineRoute({
  authorize: authorizePartyBankWrite,
  feature: { none: "Party bank details are governed by party permissions and approval flows." },
  params: z.object({ id: z.string() }),
  body: bankAccountCreateBody,
  handler: (context) => createPartyBankAccount(context),
});

export const PATCH = defineRoute({
  authorize: authorizePartyBankWrite,
  feature: { none: "Party bank details are governed by party permissions and approval flows." },
  params: z.object({ id: z.string() }),
  body: bankAccountPatchBody,
  handler: (context) => updatePartyBankAccount(context),
});

export const DELETE = defineRoute({
  authorize: authorizePartyBankWrite,
  feature: { none: "Party bank details are governed by party permissions and approval flows." },
  params: z.object({ id: z.string() }),
  body: bankAccountRetirementBody,
  handler: (context) => retirePartyBankAccount(context),
});
