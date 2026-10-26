/** Public payment page projection and hosted checkout-session creation
 *  for a presented payment-link token. */
import { add, cmp } from "../money/money.ts";
import { businessToday } from "../platform/business-date.ts";
import { db, withOrg } from "../platform/db.ts";
import { ACCEPTANCE_ADAPTERS } from "./acceptance-adapters.ts";
import {
  loadLinkByToken,
  loadQuotedSurchargeFeeIncomeAccount,
  onlinePaymentsFeatureEnabled,
} from "./acceptance-links.ts";
import {
  configSecrets,
  resolveSurcharge,
  validateAcceptanceBankAccount,
  validateProviderConfigReferences,
} from "./acceptance-surcharge.ts";
import {
  type AcceptanceProvider,
  type FetchFn,
  type LinkWithContext,
  PaymentAcceptanceError,
  type ProviderConfigRow,
  type PublicPaymentPage,
} from "./acceptance-types.ts";
import { loadPaymentProviderConfig } from "./payment-link-session-expiry.ts";
import { sql } from "drizzle-orm";

/** Load the public, token-scoped view of a payment link (fee as quoted). */
export async function publicPaymentPage(token: string): Promise<PublicPaymentPage | null> {
  const link = await loadLinkByToken(token);
  if (!link) return null;
  if (!(await onlinePaymentsFeatureEnabled(link.orgId))) return null;
  if (link.status !== "active") return null;
  return await withOrg(link.orgId, async () => {
    if (link.expiresOn && link.expiresOn < (await businessToday(link.orgId))) {
      await db.execute(
        sql`update payment_links set status = 'expired', updated_at = now() where id = ${link.id} and org_id = ${link.orgId} and status = 'active'`,
      );
      return null;
    }
    const ctx = await db.execute<{
      orgName: string;
      documentNumber: string;
      partyName: string;
      openBalance: string;
    }>(
      sql`
      select o.name as "orgName", d.document_number as "documentNumber", p.display_name as "partyName",
             d.open_balance as "openBalance"
        from orgs o, documents d, parties p
       where o.id = ${link.orgId} and d.id = ${link.documentId} and d.org_id = ${link.orgId}
         and p.id = ${link.partyId} and p.org_id = ${link.orgId}
    `,
      "objects",
    );
    const row = ctx[0];
    if (!row) return null;
    const config = await loadPaymentProviderConfig<ProviderConfigRow>(link.orgId, link.provider);
    if (
      cmp(row.openBalance, "0") > 0 &&
      link.amount !== null &&
      cmp(link.amount, row.openBalance) !== 0
    ) {
      return {
        orgName: row.orgName,
        documentNumber: row.documentNumber,
        partyName: row.partyName,
        currency: link.currency,
        status: "outdated",
        provider: link.provider,
        publishableKey: config?.publishable_key ?? null,
      };
    }
    // The fee the customer was quoted is frozen on the link at creation;
    // surcharge rules changing (or expiring) afterwards must not move what
    // the pay page shows, or checkout would charge a different total than
    // displayed. Live resolution only covers rows with no stored value.
    const surchargeAmount =
      link.surchargeAmount ??
      (
        await resolveSurcharge(link.orgId, {
          provider: link.provider,
          amount: link.amount ?? row.openBalance,
          currency: link.currency,
          onDate: await businessToday(link.orgId),
          configuredRuleId: config?.surcharge_rule_id ?? null,
        })
      ).amount;
    const invoiceAmount = link.amount ?? row.openBalance;
    return {
      orgName: row.orgName,
      documentNumber: row.documentNumber,
      partyName: row.partyName,
      invoiceAmount,
      surchargeAmount,
      totalAmount: add(invoiceAmount, surchargeAmount),
      currency: link.currency,
      status: cmp(row.openBalance, "0") <= 0 ? "paid" : "active",
      provider: link.provider,
      publishableKey: config?.publishable_key ?? null,
    };
  });
}

/**
 * The transaction advisory lock that serializes hosted-checkout creation for
 * one payment link. The provider side effect is external and un-undoable, so
 * the initiated-attempt reuse probe is only a control if two concurrent
 * requests cannot pass it simultaneously.
 */
export function checkoutSessionLockKey(orgId: string, linkId: string): string {
  return `payment-acceptance-checkout:${orgId}:${linkId}`;
}

/**
 * Create (or reuse an open) provider checkout session for a link.
 *
 * IDEMPOTENT per link under concurrency: a transaction-scoped advisory lock
 * serializes requests before anything is read or written, so a double-submitted
 * /pay/{token} produces exactly one provider checkout call and one initiated
 * attempt — the loser re-probes inside the lock and reuses the winner's live
 * session. The lock rides the org transaction, so a failed provider call rolls
 * everything back and releases it: no claim survives to block a genuine retry.
 */
export async function createCheckoutSession(
  token: string,
  returnUrl: string,
  fetchFn?: FetchFn,
): Promise<{ redirectUrl: string }> {
  const initialLink = await loadLinkByToken(token);
  if (!initialLink) throw new PaymentAcceptanceError("payment link not found");
  if (!(await onlinePaymentsFeatureEnabled(initialLink.orgId))) {
    throw new PaymentAcceptanceError("Online Payments is disabled");
  }
  if (initialLink.status !== "active")
    throw new PaymentAcceptanceError(`payment link is ${initialLink.status}`);
  // Expiry is enforced here, not just on the pay page: the page flips an
  // expired link on view, but a direct session POST would otherwise mint
  // provider checkouts against a dead quote indefinitely. The flip commits
  // in its own transaction because the refusal below must not roll it back.
  if (initialLink.expiresOn && initialLink.expiresOn < (await businessToday(initialLink.orgId))) {
    await withOrg(initialLink.orgId, async () => {
      await db.execute(sql`
        update payment_links set status = 'expired', updated_at = now()
         where id = ${initialLink.id} and org_id = ${initialLink.orgId} and status = 'active'
      `);
    });
    throw new PaymentAcceptanceError("payment link is expired");
  }
  return await withOrg(initialLink.orgId, async () => {
    // Serialize creators for this link BEFORE any read or write below.
    await db.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${checkoutSessionLockKey(initialLink.orgId, initialLink.id)}, 0))
    `);

    // The initial token lookup only routes the request. Admin actions use the
    // payment-link row lock, so reload after the per-link lock and recheck
    // lifecycle state before any provider side effect can occur.
    const lockedLink = (
      await db.execute<{
        documentId: string;
        provider: AcceptanceProvider;
        bankAccountId: string;
        amount: string | null;
        surchargeAmount: string | null;
        currency: string;
        status: string;
        expiresOn: string | null;
      }>(
        sql`
      select document_id as "documentId", provider, bank_account_id as "bankAccountId",
             amount, surcharge_amount as "surchargeAmount", currency, status,
             expires_on::text as "expiresOn"
        from payment_links where id = ${initialLink.id} and org_id = ${initialLink.orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!lockedLink) throw new PaymentAcceptanceError("payment link not found");
    if (lockedLink.status !== "active")
      throw new PaymentAcceptanceError(`payment link is ${lockedLink.status}`);
    if (lockedLink.expiresOn && lockedLink.expiresOn < (await businessToday(initialLink.orgId))) {
      throw new PaymentAcceptanceError("payment link is expired");
    }
    const link: LinkWithContext = { ...initialLink, ...lockedLink };

    const doc = await db.execute<{ document_number: string; open_balance: string }>(
      sql`
      select document_number, open_balance from documents where id = ${link.documentId} and org_id = ${link.orgId}
       for update
    `,
      "objects",
    );
    if (!doc[0]) throw new PaymentAcceptanceError("invoice not found");
    const openBalance = doc[0].open_balance;
    if (cmp(openBalance, "0") <= 0) throw new PaymentAcceptanceError("invoice is already paid");
    if (link.amount !== null && cmp(link.amount, openBalance) !== 0) {
      throw new PaymentAcceptanceError("payment link is out of date; request a new link");
    }
    const invoiceAmount = link.amount ?? openBalance;

    const config = await loadPaymentProviderConfig<ProviderConfigRow>(link.orgId, link.provider);
    if (!config?.is_enabled || !config.acceptance_enabled)
      throw new PaymentAcceptanceError("provider is not configured");
    // A link with a frozen surcharge is independent of the provider's current
    // surcharge-rule reference. Do not reject a valid quoted checkout merely
    // because that rule was later edited, expired, or retired; legacy links
    // with no stored amount still require the live reference validation.
    await validateProviderConfigReferences(link.orgId, config, {
      validateSurchargeRule: link.surchargeAmount === null,
    });
    await validateAcceptanceBankAccount(link.orgId, link.bankAccountId);
    // The amount shown to the customer is the quote captured on the link.
    // Never let a changed rule or balance replace that amount. New links also
    // carry the quoted fee account in their creation audit evidence; only
    // legacy links (which have no such evidence) need a live surcharge lookup.
    let surcharge: { amount: string; feeIncomeAccountId: string | null };
    if (link.surchargeAmount !== null) {
      const quotedFeeAccount = await loadQuotedSurchargeFeeIncomeAccount(link.orgId, link.id);
      if (quotedFeeAccount !== null) {
        surcharge = { amount: link.surchargeAmount, feeIncomeAccountId: quotedFeeAccount };
      } else if (cmp(link.surchargeAmount, "0") === 0) {
        surcharge = { amount: link.surchargeAmount, feeIncomeAccountId: null };
      } else {
        const resolvedSurcharge = await resolveSurcharge(link.orgId, {
          provider: link.provider,
          amount: invoiceAmount,
          currency: link.currency,
          onDate: await businessToday(link.orgId),
          configuredRuleId: config.surcharge_rule_id,
        });
        surcharge = {
          amount: link.surchargeAmount,
          feeIncomeAccountId: resolvedSurcharge.feeIncomeAccountId,
        };
      }
    } else {
      const resolvedSurcharge = await resolveSurcharge(link.orgId, {
        provider: link.provider,
        amount: invoiceAmount,
        currency: link.currency,
        onDate: await businessToday(link.orgId),
        configuredRuleId: config.surcharge_rule_id,
      });
      surcharge = {
        amount: resolvedSurcharge.amount,
        feeIncomeAccountId: resolvedSurcharge.feeIncomeAccountId,
      };
    }
    if (cmp(surcharge.amount, "0") > 0 && surcharge.feeIncomeAccountId === null) {
      throw new PaymentAcceptanceError("quoted surcharge has no fee income account");
    }

    // Reuse a live initiated attempt (same provider object) when amounts match.
    const existing = await db.execute<{
      id: string;
      external_ref: string;
      event_payload: {
        redirectUrl?: string;
        invoiceAmount?: string;
        surchargeAmount?: string;
      } | null;
    }>(
      sql`
      select id, external_ref, event_payload from payment_attempts
       where org_id = ${link.orgId} and link_id = ${link.id} and provider = ${link.provider} and status = 'initiated'
       order by created_at desc limit 1
    `,
      "objects",
    );
    const open = existing[0];
    if (
      open?.event_payload?.redirectUrl &&
      open.event_payload.invoiceAmount === invoiceAmount &&
      open.event_payload.surchargeAmount === surcharge.amount
    ) {
      return { redirectUrl: open.event_payload.redirectUrl };
    }

    const adapter = ACCEPTANCE_ADAPTERS[link.provider];
    const session = await adapter.createCheckout(
      configSecrets(config, link.orgId),
      {
        linkToken: link.token,
        description: `Invoice ${doc[0].document_number}`,
        invoiceAmount,
        surchargeAmount: surcharge.amount,
        currency: link.currency,
        returnUrl,
      },
      fetchFn,
    );
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into payment_attempts
        (org_id, link_id, provider, external_ref, status, amount, surcharge_amount, event_payload, created_by, updated_by)
      values (${link.orgId}, ${link.id}, ${link.provider}, ${session.externalRef}, 'initiated',
              ${invoiceAmount}, ${surcharge.amount},
              ${JSON.stringify({ redirectUrl: session.redirectUrl, invoiceAmount, surchargeAmount: surcharge.amount, feeIncomeAccountId: surcharge.feeIncomeAccountId })}::jsonb,
              null, null)
      -- A repeated provider reference is accepted only for the same link and quoted amounts below.
      on conflict (org_id, provider, external_ref) do nothing
      returning id`,
      "objects",
    );
    if (inserted.length === 0) {
      const existing = (
        await db.execute<{ link_id: string | null; amount: string; surcharge_amount: string }>(
          sql`
        select link_id, amount::text, surcharge_amount::text from payment_attempts
         where org_id = ${link.orgId} and provider = ${link.provider} and external_ref = ${session.externalRef}`,
          "objects",
        )
      )[0];
      if (
        !existing ||
        existing.link_id !== link.id ||
        cmp(existing.amount, invoiceAmount) !== 0 ||
        cmp(existing.surcharge_amount, surcharge.amount) !== 0
      ) {
        throw new PaymentAcceptanceError(
          "The provider checkout reference conflicts with another payment or quote; review the provider checkout configuration before requesting a new session.",
        );
      }
    }
    return { redirectUrl: session.redirectUrl };
  });
}
