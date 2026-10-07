import { defineRoute } from "@/lib/api/route";
import { readTransactionPolicy, writeTransactionPolicy, transactionPolicyParams, transactionPolicyBody } from "../../../benefit-transaction-rules/handlers";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "hrm.benefits.read", feature: "hrm", params: transactionPolicyParams,
  handler: readTransactionPolicy,
});

export const PATCH = defineRoute({
  permission: "hrm.benefits.manage", feature: "hrm", params: transactionPolicyParams, body: transactionPolicyBody,
  handler: writeTransactionPolicy,
});
