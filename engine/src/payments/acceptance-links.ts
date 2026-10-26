/** Hosted payment-link lifecycle for posted invoices: create, list, and
 *  void links, and resolve a presented token to its link context. */
import { cmp } from "../money/money.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { businessToday, isIsoCalendarDate } from "../platform/business-date.ts";
import { db, withBypassContext, withOrg, withOrgContext } from "../platform/db.ts";
import { sealSecret, unsealSecret } from "../platform/secrets.ts";
import {
  assertAcceptanceUuid,
  resolveSurcharge,
  validateAcceptanceBankAccount,
  validateProviderConfigReferences,
  validateSurchargeIncomeAccount,
} from "./acceptance-surcharge.ts";
import {
  type AcceptanceProvider,
  type LinkWithContext,
  PaymentAcceptanceError,
  type PaymentLinkView,
  type ProviderConfigRow,
} from "./acceptance-types.ts";
import { paymentLinkTokenHash } from "./payment-link-seal.ts";
import { loadPaymentProviderConfig } from "./payment-link-session-expiry.ts";
import { sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

export async function listPaymentLinks(
  orgId: string,
  documentId: string,
  /** REQUIRED, no default: null is the explicit unrestricted sentinel. */
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<PaymentLinkView[]> {
  // The document is locked and the scope rechecked inside the same unit as
  // the token reads: an unlocked route precheck can authorize invoice A
  // while a concurrent A→B rehome lands before the sealed tokens
  // are unsealed.
  const r = await withOrg(orgId, async () => {
    const owned = await db.execute<{ subsidiaryId: string | null }>(
      sql`
      select subsidiary_id as "subsidiaryId" from documents
       where id = ${documentId} and org_id = ${orgId}
       for update
    `,
      "objects",
    );
    if (!owned[0] || !subsidiaryScopeAllows(allowedSubsidiaryIds, owned[0].subsidiaryId)) {
      throw new ScopeNotFoundError();
    }
    return db.execute<
      Omit<PaymentLinkView, "tokenState"> & { token_sealed: string | null; token: string | null }
    >(sql`
      select id, token, token_sealed, document_id as "documentId", provider, amount, surcharge_amount as "surchargeAmount",
             currency, status, expires_on::text as "expiresOn", memo,
             paid_payment_document_id as "paidPaymentDocumentId", created_at as "createdAt"
        from payment_links
       where org_id = ${orgId} and document_id = ${documentId}
       order by created_at desc
    `);
  });
  // token_sealed is authoritative (written since at-rest sealing); the raw
  // token column survives only until bootstrap's seal-and-null step and
  // covers links created between migration and that step.
  return r.rows.map(({ token_sealed, token, ...view }) => {
    // A tampered token degrades only its own row. The v2 unseal throws
    // (fail closed) where the old one returned null, so the throw is caught
    // here and flows into the logged `unsealable` refusal below — the row
    // still lists, but never with a collectible URL.
    let plain: string | null = token_sealed ? null : token;
    if (token_sealed) {
      try {
        plain = unsealSecret(token_sealed, { orgId, purpose: "payment.link.token" });
      } catch {
        plain = null;
      }
    }
    if (plain == null) {
      // Never emit an empty-token URL as if it were collectible: the link
      // is broken until reissued (void it and create a new link), and the
      // failure is logged with the link identity — never the secret.
      console.error(
        `[payments] payment link ${view.id} (document ${view.documentId}) token cannot be unsealed — ` +
          `void the link and create a new one`,
      );
      return { ...view, token: "", tokenState: "unsealable" as const };
    }
    return { ...view, token: plain, tokenState: "ok" as const };
  });
}

export async function createPaymentLink(
  orgId: string,
  actorId: string,
  input: {
    documentId: string;
    provider: AcceptanceProvider;
    bankAccountId?: string | null;
    expiresOn?: string | null;
    memo?: string | null;
  },
  /** REQUIRED, no default: null is the explicit unrestricted sentinel. */
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<PaymentLinkView> {
  assertAcceptanceUuid(input.documentId, "document");
  if (
    input.provider !== "stripe" &&
    input.provider !== "adyen" &&
    input.provider !== "gocardless"
  ) {
    throw new PaymentAcceptanceError("unknown payment provider");
  }
  if (input.bankAccountId !== undefined && input.bankAccountId !== null) {
    assertAcceptanceUuid(input.bankAccountId, "bank account");
  }
  // A shape-valid non-day such as February 30 would otherwise reach the
  // expires_on DATE column and surface as a raw storage throw (HTTP 500 at
  // the route, which only maps PaymentAcceptanceError to 422).
  if (
    input.expiresOn !== undefined &&
    input.expiresOn !== null &&
    !isIsoCalendarDate(input.expiresOn)
  ) {
    throw new PaymentAcceptanceError("expiresOn must be a real calendar date (YYYY-MM-DD)");
  }
  return await withOrg(orgId, async () => {
    // Locked before anything else: the scope verdict and every validation
    // below see the latest committed subsidiary, and a concurrent rehome
    // blocks until the link commits instead of slipping between a route
    // precheck and this mint.
    const docs = await db.execute<{
      id: string;
      kind: string;
      status: string;
      party_id: string | null;
      subsidiary_id: string | null;
      currency: string;
      document_number: string;
      open_balance: string;
    }>(
      sql`
      select id, kind, status, party_id, subsidiary_id, currency, document_number, open_balance
        from documents where id = ${input.documentId} and org_id = ${orgId}
        for update
    `,
      "objects",
    );
    const doc = docs[0];
    if (!doc || !subsidiaryScopeAllows(allowedSubsidiaryIds, doc.subsidiary_id))
      throw new ScopeNotFoundError();
    if (doc.kind !== "customer_invoice")
      throw new PaymentAcceptanceError("payment links attach to customer invoices");
    if (doc.kind !== "customer_invoice")
      throw new PaymentAcceptanceError("payment links attach to customer invoices");
    if (doc.status !== "posted") throw new PaymentAcceptanceError("invoice is not posted");
    if (!doc.party_id) throw new PaymentAcceptanceError("invoice has no customer");
    if (cmp(doc.open_balance, "0") <= 0)
      throw new PaymentAcceptanceError("invoice has no open balance");

    const config = await loadPaymentProviderConfig<ProviderConfigRow>(orgId, input.provider);
    if (!config?.is_enabled || !config.acceptance_enabled) {
      throw new PaymentAcceptanceError(`${input.provider} payment acceptance is not configured`);
    }
    await validateProviderConfigReferences(orgId, config);
    const bankAccountId = input.bankAccountId ?? config.default_bank_account_id;
    if (!bankAccountId)
      throw new PaymentAcceptanceError("no receipt bank account configured for this provider");
    await validateAcceptanceBankAccount(orgId, bankAccountId);

    const surcharge = await resolveSurcharge(orgId, {
      provider: input.provider,
      amount: doc.open_balance,
      currency: doc.currency,
      onDate: await businessToday(orgId),
      configuredRuleId: config.surcharge_rule_id,
    });

    const token = randomBytes(24).toString("base64url");
    // The bearer token never lands in plaintext: the public lookup resolves
    // through the sha256 token_hash, and the display path unseals
    // token_sealed (the panel rebuilds /pay/{token} from listPaymentLinks).
    // A database read alone must not yield a payable link — every other
    // token type in the product is hashed or sealed at rest.
    const tokenHash = paymentLinkTokenHash(token);
    const id = await db.execute<{ id: string }>(
      sql`
      insert into payment_links
        (org_id, token_hash, token_sealed, document_id, party_id, subsidiary_id, provider, bank_account_id,
         amount, surcharge_amount, currency, status, expires_on, memo, created_by, updated_by)
      values (${orgId}, ${tokenHash}, ${sealSecret(token, { orgId, purpose: "payment.link.token" })}, ${doc.id}, ${doc.party_id}, ${doc.subsidiary_id}, ${input.provider}, ${bankAccountId},
              ${doc.open_balance}, ${surcharge.amount}, ${doc.currency}, 'active', ${input.expiresOn ?? null},
              ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id
    `,
      "objects",
    );
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'payment_links', ${id[0]!.id}, 'insert',
              ${JSON.stringify({
                after: {
                  documentId: doc.id,
                  documentNumber: doc.document_number,
                  provider: input.provider,
                  amount: doc.open_balance,
                  surcharge: surcharge.amount,
                  surchargeRuleId: surcharge.ruleId,
                  feeIncomeAccountId: surcharge.feeIncomeAccountId,
                },
              })}::jsonb,
              ${actorId})
    `);
    const links = await listPaymentLinks(orgId, doc.id, allowedSubsidiaryIds);
    return links.find((l) => l.id === id[0]!.id)!;
  });
}

export async function voidPaymentLink(
  orgId: string,
  actorId: string,
  linkId: string,
  /** REQUIRED, no default: null is the explicit unrestricted sentinel. */
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<void> {
  await withOrg(orgId, async () => {
    // Lock the link, then its invoice, and recheck the invoice's scope under
    // both locks: the route's unlocked precheck on the stored link entity
    // can authorize link L while a concurrent rehome moves L's invoice to
    // another entity before this void commits.
    const link = (
      await db.execute<{ document_id: string }>(
        sql`
      select document_id from payment_links
       where org_id = ${orgId} and id = ${linkId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!link) throw new ScopeNotFoundError();
    const owned = (
      await db.execute<{ subsidiaryId: string | null }>(
        sql`
      select subsidiary_id as "subsidiaryId" from documents
       where id = ${link.document_id} and org_id = ${orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!owned || !subsidiaryScopeAllows(allowedSubsidiaryIds, owned.subsidiaryId)) {
      throw new ScopeNotFoundError();
    }
    const r = await db.execute<{ id: string }>(
      sql`
      update payment_links set status = 'void', updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${linkId} and status = 'active'
       returning id
    `,
      "objects",
    );
    if (!r[0]) throw new PaymentAcceptanceError("payment link not found or not active");
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'payment_links', ${linkId}, 'void', ${JSON.stringify({ before: { status: "active" }, after: { status: "void" } })}::jsonb, ${actorId})
    `);
  });
}

/**
 * Surcharge amounts are frozen on payment_links, while the fee-income
 * destination historically lived only in the rule that produced the quote.
 * New links also record that destination in their creation audit evidence so
 * checkout can keep posting a quoted fee even after the rule is edited or
 * retired. Older links fall back to the live rule lookup at checkout.
 */
export async function loadQuotedSurchargeFeeIncomeAccount(
  orgId: string,
  linkId: string,
): Promise<string | null> {
  const result = await db.execute<{ changes: Record<string, unknown> | null }>(
    sql`
    select changes
      from audit_log
     where org_id = ${orgId}
       and table_name = 'payment_links'
       and row_id = ${linkId}
       and action = 'insert'
     order by at desc, id desc
     limit 1
  `,
    "objects",
  );
  const changes = result[0]?.changes;
  const after =
    changes && typeof changes === "object" && !Array.isArray(changes)
      ? (changes.after as Record<string, unknown> | undefined)
      : undefined;
  const accountId = typeof after?.feeIncomeAccountId === "string" ? after.feeIncomeAccountId : null;
  if (accountId !== null) await validateSurchargeIncomeAccount(orgId, accountId);
  return accountId;
}

/** Registry default is off — absence must not enable hosted checkout. Resolved
 * through the canonical switchboard: the previous inline ::boolean cast threw
 * 22P02 on a non-boolean stored value. */
export async function onlinePaymentsFeatureEnabled(orgId: string): Promise<boolean> {
  return withOrgContext(orgId, () => orgFeatureEnabled(orgId, "onlinePayments"));
}

export async function paymentLinkOrgId(token: string): Promise<string | null> {
  return (await loadLinkByToken(token))?.orgId ?? null;
}

export async function loadLinkByToken(token: string): Promise<LinkWithContext | null> {
  // Token lookup must span orgs (public surface); all subsequent work is
  // org-scoped via withOrg once the token resolves. The lookup resolves by
  // the sha256 hash — the raw bearer token is never stored, so a database
  // read alone cannot mint a payable URL.
  const tokenHash = paymentLinkTokenHash(token);
  // bypass: connector-token — a public payment link's token hash is resolved before its organization is known.
  const r = await withBypassContext(async () =>
    db.execute<LinkWithContext>(
      sql`
      select id, org_id as "orgId", ${token} as token, document_id as "documentId", party_id as "partyId",
             subsidiary_id as "subsidiaryId", provider, bank_account_id as "bankAccountId",
             amount, surcharge_amount as "surchargeAmount",
             currency, status, expires_on::text as "expiresOn"
        from payment_links where token_hash = ${tokenHash} limit 1
    `,
      "objects",
    ),
  );
  return r[0] ?? null;
}
