import { sql } from "drizzle-orm";
import { db, type SqlExecutor, withBypassContext, withOrg } from "../platform/db.ts";
import { unsealJson } from "../platform/secrets.ts";

export async function loadPaymentProviderConfig<T extends Record<string, unknown>>(
  orgId: string,
  provider: string,
  runner: SqlExecutor = db,
): Promise<T | null> {
  const result = await runner.execute<T>(sql`
    select id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id,
           publishable_key, settings, surcharge_rule_id, secrets
      from psp_provider_configs
     where org_id = ${orgId} and provider = ${provider}
     limit 1
  `);
  return (result.rows[0] as T | undefined) ?? null;
}

type StripeSessionConfig = {
  secrets: string | null;
  settings: Record<string, unknown>;
};

async function loadStripeSessionConfig(orgId: string): Promise<StripeSessionConfig | null> {
  return withBypassContext(() => loadPaymentProviderConfig<StripeSessionConfig>(orgId, "stripe"));
}

function stripeApiBase(settings: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(settings, "apiBase")) return "https://api.stripe.com";
  if (typeof settings.apiBase !== "string" || settings.apiBase.trim() === "") return null;
  try {
    const endpoint = new URL(settings.apiBase.trim());
    if (
      endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" ||
      endpoint.port !== "" || endpoint.search !== "" || endpoint.hash !== "" ||
      endpoint.hostname.toLowerCase() !== "api.stripe.com" || endpoint.pathname.replace(/\/+$/, "") !== ""
    ) return null;
    return `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Expire Stripe sessions after a posted payment changes an invoice balance.
 * Provider failures are audited and never roll back the posted payment. */
export async function expireStalePaymentLinkSessions(
  orgId: string,
  invoiceIds: readonly string[],
): Promise<void> {
  if (invoiceIds.length === 0) return;
  const attempts = await withBypassContext(() => db.execute<{
    id: string;
    externalRef: string;
    invoiceId: string;
  }>(sql`
    select attempt.id, attempt.external_ref as "externalRef",
           link.document_id as "invoiceId"
      from payment_attempts attempt
      join payment_links link on link.id = attempt.link_id and link.org_id = attempt.org_id
      join documents invoice on invoice.id = link.document_id and invoice.org_id = link.org_id
     where attempt.org_id = ${orgId} and attempt.provider = 'stripe'
       and link.document_id in ${invoiceIds}
       and attempt.status = 'initiated' and link.amount is not null
       and link.amount > invoice.open_balance
  `));
  if (attempts.rows.length === 0) return;

  const config = await loadStripeSessionConfig(orgId);
  const apiBase = config ? stripeApiBase(config.settings ?? {}) : null;
  const apiKey = config?.secrets ? unsealJson<{ apiKey?: string }>(config.secrets)?.apiKey : undefined;
  if (!config) return;
  for (const attempt of attempts.rows) {
    let expired = false;
    try {
      if (!apiBase) throw new Error("stripe API endpoint is not allowlisted");
      if (apiKey) {
        const response = await fetch(`${apiBase}/v1/checkout/sessions/${encodeURIComponent(attempt.externalRef)}/expire`, {
          method: "POST",
          redirect: "error",
          headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
        });
        expired = response.status < 400;
      }
    } catch {
      expired = false;
    }
    await withOrg(orgId, async () => {
      const evidence = {
        reason: "invoice_balance_changed",
        outcome: expired ? "provider_session_expired" : "provider_session_expiry_failed",
        invoiceId: attempt.invoiceId,
      };
      const updated = await db.execute<{ id: string }>(sql`
        update payment_attempts
           set status = ${expired ? "cancelled" : "initiated"},
               event_payload = coalesce(event_payload, '{}'::jsonb) || ${JSON.stringify({ sessionInvalidation: evidence })}::jsonb,
               updated_at = now()
         where id = ${attempt.id} and org_id = ${orgId} and status = 'initiated'
         returning id
      `);
      if (!updated.rows[0]) return;
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'payment_attempts', ${attempt.id}, 'update',
                ${JSON.stringify({ after: { sessionInvalidation: evidence } })}::jsonb, null)
      `);
    });
  }
}
