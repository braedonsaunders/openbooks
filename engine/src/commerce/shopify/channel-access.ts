import { sql } from "drizzle-orm";
import { z } from "zod";
import { SHOPIFY_API_VERSION } from "../../connectors/shopify.ts";
import { CommerceError } from "../errors.ts";
import { db, withOrgContext } from "../../platform/db.ts";
import { unsealJson } from "../../platform/secrets.ts";

/**
 * Shopify channel access: the shop domain, sealed credentials, and
 * validated settings every Shopify operation starts from. The channel's
 * webhook secret IS the Shopify app secret for Shopify channels — stored
 * at connect time (from the platform app configuration for OAuth, pasted
 * for custom apps) — so the shared inbound verifier signs with the same
 * key Shopify does.
 */

export const shopifySettingsSchema = z
  .object({
    autoImportProducts: z.boolean().default(true),
    syncInventory: z.boolean().default(true),
    pushCatalog: z.boolean().default(false),
    apiVersion: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .default(SHOPIFY_API_VERSION),
    /** Maximum Admin API query cost one import run may spend before stopping. */
    rateLimitBudget: z.number().int().positive().max(100_000).default(10_000),
  })
  .strict();

export type ShopifyChannelSettings = z.infer<typeof shopifySettingsSchema>;

export interface ShopifyChannelAccess {
  channelId: string;
  name: string;
  status: string;
  shop: string;
  currency: string;
  accessToken: string;
  webhookSecret: string;
  settings: ShopifyChannelSettings;
}

function refuse(code: string, message: string, remedy: string, field: string | null = null): never {
  throw new CommerceError(code, message, remedy, { field });
}

interface ChannelSecretRow extends Record<string, unknown> {
  id: string;
  name: string;
  status: string;
  kind: string;
  currency: string;
  external_account: string;
  secrets: string | null;
  webhook_secret: string | null;
  settings: Record<string, unknown>;
}

export async function loadShopifyChannel(orgId: string, channelId: string): Promise<ShopifyChannelAccess> {
  const row = (
    await withOrgContext(orgId, () =>
      db.execute<ChannelSecretRow>(sql`
        select id, name, status, kind, currency, external_account, secrets, webhook_secret, settings
          from sales_channels where org_id = ${orgId} and id = ${channelId}`),
    )
  ).rows[0];
  if (!row || row.kind !== "shopify") {
    refuse(
      "channel_not_found",
      "The Shopify channel does not belong to this organization.",
      "Choose a Shopify channel under Channels, or connect it first.",
      "channelId",
    );
  }
  const settings = shopifySettingsSchema.safeParse(row.settings ?? {});
  if (!settings.success) {
    const first = settings.error.issues[0];
    refuse(
      "channel_settings_invalid",
      `The Shopify channel settings are invalid: ${first?.path.join(".") || "settings"} — ${first?.message ?? "rejected"}.`,
      "Review the channel settings under Channels → Settings and save them again.",
      "settings",
    );
  }
  let accessToken: string | null = null;
  if (row.secrets) {
    try {
      const sealed = unsealJson<{ accessToken?: unknown }>(row.secrets, {
        orgId,
        purpose: "sales_channel.secrets",
      });
      if (typeof sealed.accessToken === "string" && sealed.accessToken !== "") accessToken = sealed.accessToken;
    } catch {
      accessToken = null;
    }
  }
  if (!accessToken) {
    refuse(
      "shopify_token_missing",
      `Channel "${row.name}" holds no Shopify access token.`,
      "Reconnect the channel under Channels → Connect Shopify to store a fresh token.",
      "channelId",
    );
  }
  let webhookSecret: string | null = null;
  if (row.webhook_secret) {
    try {
      const sealed = unsealJson<{ secret?: unknown }>(row.webhook_secret, {
        orgId,
        purpose: "sales_channel.webhook_secret",
      });
      if (typeof sealed.secret === "string" && sealed.secret !== "") webhookSecret = sealed.secret;
    } catch {
      webhookSecret = null;
    }
  }
  if (!webhookSecret) {
    refuse(
      "shopify_webhook_secret_missing",
      `Channel "${row.name}" holds no Shopify app secret for webhook verification.`,
      "Enter the Shopify app secret under Channels → Settings so deliveries verify, then ask Shopify to resend.",
      "channelId",
    );
  }
  return {
    channelId: row.id,
    name: row.name,
    status: row.status,
    shop: row.external_account,
    currency: row.currency,
    accessToken,
    webhookSecret,
    settings: settings.data,
  };
}
