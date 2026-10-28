import { z } from "zod";
import { defineRoute } from "../../../../../../lib/api/route";
import { authorizePartyBankWrite } from "../party-scope";
import { submitPartyBankAccount } from "@/lib/party-bank-account-actions";

export const runtime = "nodejs";

export const POST = defineRoute({
  authorize: authorizePartyBankWrite,
  feature: {
    none: "Party bank detail submission is governed by party permissions and approval flows.",
  },
  params: z.object({ id: z.string() }),
  handler: (context) => submitPartyBankAccount(context),
});
