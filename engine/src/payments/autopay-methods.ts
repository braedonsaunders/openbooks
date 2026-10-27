import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import { paymentLinkTokenHash } from "./payment-link-seal.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import {
  ACCEPTANCE_ADAPTERS,
  configSecrets,
  defaultFetch,
  type AcceptanceProvider,
  type FetchFn,
  type ProviderConfigRow,
  type WebhookEvent,
} from "./acceptance.ts";
import { loadPaymentProviderConfig } from "./payment-link-session-expiry.ts";
import { AutopayError, requireAutopayFeature, auditAutopay } from "./autopay-policy.ts";
import { readCompletedSetup } from "./autopay-setup-readback.ts";

/** Stored payment methods: customer setup links, provider setup completion, default and fallback ordering, removal, and card-updater events. */

export interface StoredPaymentMethod {
  id: string;
  partyId: string;
  provider: AcceptanceProvider;
  providerCustomerId: string | null;
  providerMethodId: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  mandateReference: string | null;
  isDefault: boolean;
  /** Backup chain position: lower charges earlier once the default declines. */
  fallbackPriority: number;
  /** Row creation time (ISO): the tie-break inside equal priorities. */
  createdAt: string;
  status: string;
}

async function rowToMethod(row: Record<string, unknown>): Promise<StoredPaymentMethod> {
  return {
    id: String(row.id),
    partyId: String(row.party_id),
    provider: row.provider as AcceptanceProvider,
    providerCustomerId: (row.provider_customer_id as string | null) ?? null,
    providerMethodId: (row.provider_method_id as string | null) ?? null,
    brand: (row.brand as string | null) ?? null,
    last4: (row.last4 as string | null) ?? null,
    expMonth: (row.exp_month as number | null) ?? null,
    expYear: (row.exp_year as number | null) ?? null,
    mandateReference: (row.mandate_reference as string | null) ?? null,
    isDefault: row.is_default === true,
    fallbackPriority: typeof row.fallback_priority === "number" ? row.fallback_priority : 0,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ""),
    status: String(row.status),
  };
}

/** Stored methods on file for a customer, default first. */
export async function listPaymentMethods(
  orgId: string,
  partyId: string,
): Promise<StoredPaymentMethod[]> {
  const rows = await db.execute(
    sql`
    select * from customer_payment_methods
     where org_id = ${orgId} and party_id = ${partyId} and status <> 'removed'
     order by is_default desc, created_at desc
  `,
    "objects",
  );
  return Promise.all(rows.map(rowToMethod));
}

/**
 * Start a hosted setup session for a customer ("Send setup link"). Opens a
 * pending method row holding the provider setup id, then mints the provider
 * session against it — completion (return-URL verification or the setup
 * webhook) replaces the setup id with the real method token.
 */
export async function startMethodSetup(
  orgId: string,
  input: {
    partyId: string;
    provider: AcceptanceProvider;
    currency: string;
    returnUrl: string;
    setupToken: string;
    actorId?: string | null;
  },
  fetchFn?: FetchFn,
): Promise<{ methodId: string; setupToken: string; redirectUrl: string }> {
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const party = (
      await db.execute<{ id: string }>(
        sql`
      select id from parties where id = ${input.partyId} and org_id = ${orgId} limit 1
    `,
        "objects",
      )
    )[0];
    if (!party) throw new AutopayError("customer not found; pick a customer from Customers first");
    const config = await loadPaymentProviderConfig<ProviderConfigRow>(orgId, input.provider);
    if (!config || !config.is_enabled || !config.acceptance_enabled) {
      throw new AutopayError(
        `${input.provider} is not enabled for online payments; enable it in provider settings first`,
      );
    }
    const defaultMethod = (
      await db.execute<{ provider_customer_id: string | null }>(
        sql`
      select provider_customer_id from customer_payment_methods
       where org_id = ${orgId} and party_id = ${input.partyId} and status = 'active' and provider_customer_id is not null
       order by is_default desc limit 1
    `,
        "objects",
      )
    )[0];
    // The setup token is the customer's Bearer [REDACTED] the hosted setup page: same
    // token handling as payment links (random token, sha256 in storage). The
    // caller mints it so the return URL can carry it to the return page.
    const setupToken = input.setupToken;
    if (!/^[0-9a-f]{32,128}$/i.test(setupToken)) {
      throw new AutopayError("setup token is malformed; generate a fresh setup link");
    }
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into customer_payment_methods (org_id, party_id, provider, status, token_hash, created_by, updated_by)
      values (${orgId}, ${input.partyId}, ${input.provider}, 'pending',
              ${paymentLinkTokenHash(setupToken)}, ${input.actorId ?? null}, ${input.actorId ?? null})
      returning id
    `,
      "objects",
    );
    const methodId = inserted[0]?.id;
    if (!methodId) throw new AutopayError("payment method could not be started; try again");
    const adapter = ACCEPTANCE_ADAPTERS[input.provider];
    let session;
    try {
      session = await adapter.createSetupSession(
        configSecrets(config as Parameters<typeof configSecrets>[0], orgId),
        {
          linkToken: methodId,
          description: "Autopay payment method",
          currency: input.currency,
          returnUrl: input.returnUrl,
          providerCustomerId: defaultMethod?.provider_customer_id ?? null,
        },
        fetchFn,
      );
    } catch (error) {
      // The provider refused before any customer action: drop the pending
      // row so a dead setup can never complete later.
      await db.execute(sql`
        delete from customer_payment_methods where id = ${methodId} and org_id = ${orgId} and status = 'pending'
      `);
      throw error;
    }
    const claimed = await db.execute<{ id: string }>(
      sql`
      update customer_payment_methods
         set provider_method_id = ${session.externalRef},
             provider_customer_id = coalesce(provider_customer_id, ${session.providerCustomerId ?? null}),
             setup_redirect_url = ${session.redirectUrl},
             updated_at = now(), updated_by = ${input.actorId ?? null}
       where id = ${methodId} and org_id = ${orgId} and status = 'pending'
       returning id
    `,
      "objects",
    );
    if (!claimed[0])
      throw new AutopayError("payment method setup was superseded; start a new setup link");
    await auditAutopay(
      orgId,
      "customer_payment_methods",
      methodId,
      {
        event: "setup_started",
        after: { provider: input.provider, setupRef: session.externalRef },
        reason: "Operator sent a setup link; the method activates when the provider confirms it.",
      },
      input.actorId ?? null,
    );
    return { methodId, setupToken, redirectUrl: session.redirectUrl };
  });
}

/** Resolve a hosted setup token to its org (public page + return handler). */
export async function setupTokenOrgId(setupToken: string): Promise<string | null> {
  if (!setupToken || setupToken.length < 16) return null;
  // bypass: connector-token — the setup link's token hash resolves its organization; no session exists to scope the read.
  return withBypassContext(async () => {
    const row = (
      await db.execute<{ org_id: string }>(
        sql`
      select org_id from customer_payment_methods
       where token_hash = ${paymentLinkTokenHash(setupToken)} limit 1
    `,
        "objects",
      )
    )[0];
    return row?.org_id ?? null;
  });
}

export interface PublicSetupPage {
  orgId: string;
  orgName: string;
  partyName: string;
  provider: AcceptanceProvider;
  status: string;
  brand: string | null;
  last4: string | null;
}

/**
 * Public hosted setup page data: what the customer is saving, and for whom.
 * Refuses when the gate is off or the link is unknown — an unknown token is
 * a 404, never a hint about which tokens exist.
 */
export async function publicSetupPage(setupToken: string): Promise<PublicSetupPage> {
  if (!setupToken || setupToken.length < 16)
    throw new AutopayError("this setup link is not valid; ask for a new one");
  // bypass: connector-token — the setup link's token hash resolves its organization; no session exists to scope the read.
  return withBypassContext(async () => {
    const row = (
      await db.execute<{
        org_id: string;
        org_name: string;
        party_name: string;
        provider: AcceptanceProvider;
        status: string;
        brand: string | null;
        last4: string | null;
      }>(
        sql`
      select m.org_id, o.name as "org_name", p.display_name as "party_name",
             m.provider, m.status, m.brand, m.last4
        from customer_payment_methods m
        join orgs o on o.id = m.org_id
        join parties p on p.id = m.party_id and p.org_id = m.org_id
       where m.token_hash = ${paymentLinkTokenHash(setupToken)} limit 1
    `,
        "objects",
      )
    )[0];
    if (!row) throw new AutopayError("this setup link is not valid; ask for a new one");
    if (!(await orgFeatureEnabled(row.org_id, "autopay"))) {
      throw new AutopayError(
        "automatic payments are not available right now; contact us for another way to pay",
      );
    }
    return {
      orgId: row.org_id,
      orgName: row.org_name,
      partyName: row.party_name,
      provider: row.provider,
      status: row.status,
      brand: row.brand,
      last4: row.last4,
    };
  });
}

/** The stored provider URL the customer continues to (minted at setup start). */
export async function setupContinueUrl(setupToken: string): Promise<string> {
  const page = await publicSetupPage(setupToken);
  if (page.status !== "pending") {
    throw new AutopayError(
      page.status === "active"
        ? "this method is already saved; there is nothing left to do"
        : "this setup link was withdrawn; ask for a new one",
    );
  }
  // bypass: connector-token — the setup link's token hash resolves its organization; no session exists to scope the read.
  const url = await withBypassContext(async () => {
    return (
      (
        await db.execute<{ setup_redirect_url: string | null }>(
          sql`
      select setup_redirect_url from customer_payment_methods
       where token_hash = ${paymentLinkTokenHash(setupToken)} limit 1
    `,
          "objects",
        )
      )[0]?.setup_redirect_url ?? null
    );
  });
  if (!url) throw new AutopayError("this setup link expired before use; ask for a new one");
  return url;
}

/** Complete a setup from the hosted return page (token-authenticated). */
export async function completeSetupByToken(
  setupToken: string,
  fetchFn?: FetchFn,
): Promise<StoredPaymentMethod> {
  const page = await publicSetupPage(setupToken);
  // bypass: connector-token — the setup link's token hash resolves its organization; no session exists to scope the read.
  const methodId = await withBypassContext(async () => {
    return (
      (
        await db.execute<{ id: string }>(
          sql`
      select id from customer_payment_methods
       where token_hash = ${paymentLinkTokenHash(setupToken)} limit 1
    `,
          "objects",
        )
      )[0]?.id ?? null
    );
  });
  if (!methodId) throw new AutopayError("this setup link is not valid; ask for a new one");
  return completeMethodSetup(page.orgId, methodId, null, fetchFn);
}

/**
 * Complete a pending setup: verify with the provider, then flip the row
 * active with the real method token. Called from the hosted return page and
 * from the setup webhook — whichever confirms first wins, the other reuses
 * the active row. Refusals name the customer-facing remedy.
 */
export async function completeMethodSetup(
  orgId: string,
  methodId: string,
  actorId: string | null = null,
  fetchFn?: FetchFn,
  setupEvent?: WebhookEvent,
): Promise<StoredPaymentMethod> {
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const locked = (
      await db.execute(
        sql`
      select * from customer_payment_methods
       where id = ${methodId} and org_id = ${orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!locked) throw new AutopayError("payment method not found");
    if (locked.status === "active") return rowToMethod(locked);
    if (locked.status !== "pending")
      throw new AutopayError("this payment method was removed; send a new setup link instead");
    const provider = locked.provider as AcceptanceProvider;
    const config = await loadPaymentProviderConfig<ProviderConfigRow>(orgId, provider);
    if (!config?.is_enabled || !config.acceptance_enabled) {
      throw new AutopayError(`${provider} is not enabled; enable it in provider settings first`);
    }
    const secrets = configSecrets(config, orgId);
    if (!secrets.apiKey)
      throw new AutopayError(
        `${provider} has no API key configured; add it in provider settings first`,
      );
    const httpFetch = fetchFn ?? defaultFetch;
    const detail = await readCompletedSetup(
      provider,
      String(locked.provider_method_id ?? ""),
      secrets,
      httpFetch,
      setupEvent,
    );
    const updated = await db.execute(
      sql`
      update customer_payment_methods
         set provider_customer_id = coalesce(${detail.providerCustomerId}, provider_customer_id),
             provider_method_id = ${detail.providerMethodId},
             brand = ${detail.brand}, last4 = ${detail.last4},
             exp_month = ${detail.expMonth}, exp_year = ${detail.expYear},
             mandate_reference = coalesce(${detail.mandateReference}, mandate_reference),
             status = 'active', updated_at = now(), updated_by = ${actorId}
       where id = ${methodId} and org_id = ${orgId} and status = 'pending'
       returning *
    `,
      "objects",
    );
    if (!updated[0])
      throw new AutopayError("payment method setup was superseded; start a new setup link");
    await auditAutopay(
      orgId,
      "customer_payment_methods",
      methodId,
      {
        event: "setup_completed",
        after: { brand: detail.brand, last4: detail.last4 ? `•••• ${detail.last4}` : null },
        reason: "Provider confirmed the stored method.",
      },
      actorId,
    );
    return rowToMethod(updated[0]);
  });
}

/** Make one active method the customer's default charge target. */
export async function setDefaultMethod(
  orgId: string,
  methodId: string,
  actorId: string | null = null,
): Promise<void> {
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const locked = (
      await db.execute<{ party_id: string; status: string }>(
        sql`
      select party_id, status from customer_payment_methods
       where id = ${methodId} and org_id = ${orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!locked) throw new AutopayError("payment method not found");
    if (locked.status !== "active")
      throw new AutopayError("only an active method can be the default; finish its setup first");
    await db.execute(sql`
      update customer_payment_methods set is_default = false, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and party_id = ${locked.party_id} and is_default and id <> ${methodId}
    `);
    const flipped = await db.execute<{ id: string }>(
      sql`
      update customer_payment_methods set is_default = true, updated_at = now(), updated_by = ${actorId}
       where id = ${methodId} and org_id = ${orgId} and status = 'active'
       returning id
    `,
      "objects",
    );
    if (!flipped[0])
      throw new AutopayError("payment method is no longer active; finish its setup first");
    await auditAutopay(
      orgId,
      "customer_payment_methods",
      methodId,
      {
        event: "default_changed",
        reason: "Operator chose the default autopay method.",
      },
      actorId,
    );
  });
}

/**
 * Remove a stored method: detach at the provider, then flip the row. A
 * provider-side miss (already detached) still removes locally — removal is
 * idempotent — but any other provider failure refuses with the provider's
 * message so a method is never shown as removed while still chargeable.
 */
export async function removeMethod(
  orgId: string,
  methodId: string,
  actorId: string | null = null,
  fetchFn?: FetchFn,
): Promise<void> {
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const locked = (
      await db.execute<{
        provider: AcceptanceProvider;
        provider_customer_id: string | null;
        provider_method_id: string | null;
        status: string;
        is_default: boolean;
      }>(
        sql`
      select provider, provider_customer_id, provider_method_id, status, is_default as "is_default"
        from customer_payment_methods
       where id = ${methodId} and org_id = ${orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!locked) throw new AutopayError("payment method not found");
    if (locked.status === "removed") return;
    if (locked.status === "active" && locked.provider_method_id) {
      const config = await loadPaymentProviderConfig<ProviderConfigRow>(orgId, locked.provider);
      if (!config?.is_enabled || !config.acceptance_enabled) {
        throw new AutopayError(
          `${locked.provider} is not enabled; re-enable it in provider settings before removing the method`,
        );
      }
      await ACCEPTANCE_ADAPTERS[locked.provider].detachMethod(
        configSecrets(config, orgId),
        {
          providerCustomerId: locked.provider_customer_id,
          providerMethodId: locked.provider_method_id,
        },
        fetchFn,
      );
    }
    const flipped = await db.execute<{ id: string }>(
      sql`
      update customer_payment_methods
         set status = 'removed', is_default = false, updated_at = now(), updated_by = ${actorId}
       where id = ${methodId} and org_id = ${orgId} and status <> 'removed'
       returning id
    `,
      "objects",
    );
    if (!flipped[0]) throw new AutopayError("payment method was already removed");
    await auditAutopay(
      orgId,
      "customer_payment_methods",
      methodId,
      {
        event: "removed",
        after: { wasDefault: locked.is_default },
        reason: locked.is_default
          ? "Default method removed — link another method or autopay stops collecting for this customer."
          : "Operator removed the stored method.",
      },
      actorId,
    );
  });
}

export interface CardUpdaterDetail {
  providerMethodId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/**
 * Refresh a stored method off a card account updater event: the network
 * reissued or corrected the card, so brand/last4/expiry move without any
 * customer action. Unknown methods stay unknown (the provider retries an
 * informational event harmlessly); an unchanged card still stamps the
 * refresh time as proof the updater sees it. Moving the expiry clears the
 * pre-expiry outreach guard so the new date notifies on its own.
 */
export async function recordCardUpdaterEvent(
  orgId: string,
  provider: AcceptanceProvider,
  detail: CardUpdaterDetail,
): Promise<"card_refreshed" | "card_unchanged" | "unknown_method"> {
  if (detail.expMonth != null && (detail.expMonth < 1 || detail.expMonth > 12)) {
    throw new AutopayError(
      "the card updater reported an impossible expiry month; the event is quarantined until the provider resends it",
    );
  }
  if (detail.expYear != null && (detail.expYear < 2000 || detail.expYear > 2100)) {
    throw new AutopayError(
      "the card updater reported an impossible expiry year; the event is quarantined until the provider resends it",
    );
  }
  return withOrg(orgId, async () => {
    const locked = (
      await db.execute<{
        id: string;
        brand: string | null;
        last4: string | null;
        exp_month: number | null;
        exp_year: number | null;
      }>(
        sql`
      select id, brand, last4, exp_month, exp_year from customer_payment_methods
       where org_id = ${orgId} and provider = ${provider}
         and provider_method_id = ${detail.providerMethodId} and status = 'active'
       for update
    `,
        "objects",
      )
    )[0];
    if (!locked) return "unknown_method";
    const expiryMoved =
      (locked.exp_month ?? null) !== detail.expMonth ||
      (locked.exp_year ?? null) !== detail.expYear;
    const updated = await db.execute<{ id: string }>(
      sql`
      update customer_payment_methods
         set brand = ${detail.brand}, last4 = ${detail.last4},
             exp_month = ${detail.expMonth}, exp_year = ${detail.expYear},
             last_updater_refresh_at = now(),
             expiry_notified_on = case when ${expiryMoved} then null else expiry_notified_on end,
             updated_at = now()
       where id = ${locked.id} and org_id = ${orgId}
       returning id
    `,
      "objects",
    );
    if (!updated[0])
      throw new AutopayError("payment method changed underfoot; refusing to record over it");
    const changed =
      (locked.brand ?? null) !== detail.brand ||
      (locked.last4 ?? null) !== detail.last4 ||
      expiryMoved;
    if (!changed) return "card_unchanged";
    await auditAutopay(
      orgId,
      "customer_payment_methods",
      locked.id,
      {
        event: "card_updater_refresh",
        before: { brand: locked.brand, last4: locked.last4 ? `•••• ${locked.last4}` : null },
        after: { brand: detail.brand, last4: detail.last4 ? `•••• ${detail.last4}` : null },
        reason:
          "The card network refreshed the stored card; the method stays collectible without customer action.",
      },
      null,
    );
    return "card_refreshed";
  });
}

/**
 * Order one stored method in the backup chain: lower priority charges
 * earlier once the default has declined hard. The default method itself
 * needs no order — it always charges first.
 */
export async function setMethodFallbackPriority(
  orgId: string,
  methodId: string,
  priority: number,
  actorId: string | null = null,
): Promise<void> {
  if (!Number.isInteger(priority) || priority < 0 || priority > 999) {
    throw new AutopayError(
      `backup order ${JSON.stringify(priority)} is not a whole number between 0 and 999; fix it on the payment method`,
    );
  }
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const locked = (
      await db.execute<{ status: string; is_default: boolean }>(
        sql`
      select status, is_default from customer_payment_methods
       where id = ${methodId} and org_id = ${orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!locked) throw new AutopayError("payment method not found");
    if (locked.status !== "active")
      throw new AutopayError(
        "only an active method can join the backup chain; finish its setup first",
      );
    const flipped = await db.execute<{ id: string }>(
      sql`
      update customer_payment_methods
         set fallback_priority = ${priority}, updated_at = now(), updated_by = ${actorId}
       where id = ${methodId} and org_id = ${orgId} and status = 'active'
       returning id
    `,
      "objects",
    );
    if (!flipped[0])
      throw new AutopayError("payment method is no longer active; finish its setup first");
    await auditAutopay(
      orgId,
      "customer_payment_methods",
      methodId,
      {
        event: "fallback_order_changed",
        after: { fallbackPriority: priority, wasDefault: locked.is_default },
        reason: locked.is_default
          ? "The default method always charges first; its backup order applies if it ever stops being the default."
          : "Operator ordered this method in the backup chain.",
      },
      actorId,
    );
  });
}

/**
 * Claim a stored-method setup event: resolve the pending row by the client
 * reference (our row id) or by the stored setup id, then complete it. A
 * mandate event naming a mandate nobody started (no pending row) stays
 * unknown — the return-URL verification completes those against the billing
 * request it does know.
 */
export async function recordProviderSetupMethod(
  orgId: string,
  provider: AcceptanceProvider,
  event: WebhookEvent,
): Promise<"setup_stored" | "unknown_setup"> {
  return withOrg(orgId, async () => {
    let methodId: string | null = null;
    // The client reference is our own row id — anything else-shaped is a
    // foreign token and stays unknown rather than throwing a uuid parse.
    if (
      event.linkToken &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.linkToken)
    ) {
      methodId =
        (
          await db.execute<{ id: string }>(
            sql`
        select id from customer_payment_methods
         where id = ${event.linkToken} and org_id = ${orgId}
           and provider = ${provider} and status = 'pending'
         limit 1
      `,
            "objects",
          )
        )[0]?.id ?? null;
    }
    if (!methodId && event.externalRef) {
      methodId =
        (
          await db.execute<{ id: string }>(
            sql`
        select id from customer_payment_methods
         where provider_method_id = ${event.externalRef} and org_id = ${orgId}
           and provider = ${provider} and status = 'pending'
         limit 1
      `,
            "objects",
          )
        )[0]?.id ?? null;
    }
    if (!methodId) return "unknown_setup";
    await completeMethodSetup(orgId, methodId, null, undefined, event);
    return "setup_stored";
  });
}
