import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { fileBankDetailsChange } from "@openbooks/engine/src/hrm/self-service/bank-changes.ts";
import { normalizeCountryCode } from "../../../../../lib/countries";
import { meErrorResponse } from "../_lib";
import { fileBankChangeBody } from "../bodies";

/**
 * File a direct-deposit change for one's own party and submit it in one
 * user action. The engine binds one of the actor's own employments,
 * validates and seals the account number in memory, and files a
 * bank_change request (approval-gated where a flow is configured,
 * directly applied where none is). The plaintext number travels here
 * over TLS and never persists past the file call — storage, audit, and
 * notifications carry the sealed text and the last four at most.
 */
export const POST = defineRoute({
  permission: "hrm.self.request",
  feature: "hrm",
  body: fileBankChangeBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    if (body.bank.country !== undefined && body.bank.country !== null && !normalizeCountryCode(body.bank.country)) {
      return NextResponse.json({ error: "country must be a valid ISO country code" }, { status: 400 });
    }
    if (
      body.bank.currency !== undefined &&
      body.bank.currency !== null &&
      !/^[A-Za-z]{3}$/.test(body.bank.currency.trim())
    ) {
      return NextResponse.json({ error: "currency must be a 3-letter code" }, { status: 400 });
    }
    try {
      const filed = await fileBankDetailsChange({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        employmentId: body.employmentId,
        bank: {
          bankName: body.bank.bankName,
          accountNumber: body.bank.accountNumber,
          ...(body.bank.country === undefined ? {} : { country: normalizeCountryCode(body.bank.country) ?? body.bank.country }),
          ...(body.bank.currency === undefined
            ? {}
            : { currency: body.bank.currency === null ? null : body.bank.currency.trim().toUpperCase() }),
          ...(body.bank.routing === undefined ? {} : { routing: body.bank.routing }),
        },
        reason: body.reason,
      });
      return NextResponse.json(
        { request: filed.request, applied: filed.applied, notified: filed.notified },
        { status: 201 },
      );
    } catch (e) {
      return meErrorResponse(e);
    }
  },
});
