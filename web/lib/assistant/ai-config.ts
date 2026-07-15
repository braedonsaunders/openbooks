import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { sealSecret, unsealSecret } from "../secrets";
import {
  isAiProvider,
  validateAiBaseUrl,
  type AiConfig,
  type AiProvider,
} from "./client";

/**
 * AI provider configuration, ported from beaconhs's lib/ai-config.ts and
 * collapsed to openbooks' single-org model: beaconhs resolved platform →
 * tenant policy across two scopes; here the org IS the tenant, so the config
 * lives in `orgs.settings.ai` alone. The API key is encrypted at rest
 * (web/lib/secrets.ts, AES-256-GCM under OPENBOOKS_DATA_KEY). There is no
 * environment fallback — nothing AI-related lives in the environment.
 */

type RawAi = {
  enabled?: boolean;
  provider?: string;
  modelFast?: string;
  modelSmart?: string;
  baseUrl?: string;
  /** enc:v1 sealed API key (see web/lib/secrets.ts). */
  keyEncrypted?: string;
};

function normProvider(p: string | undefined): AiProvider {
  return isAiProvider(p) ? p : "anthropic";
}

/** UI-facing settings (no secret material ever crosses this boundary). */
export type OrgAiSettings = {
  enabled: boolean;
  provider: AiProvider;
  modelFast: string;
  modelSmart: string;
  baseUrl: string;
  hasKey: boolean;
};

/** The mutable, non-secret fields the settings form collects. */
export type AiSettingsInput = {
  enabled: boolean;
  provider: AiProvider;
  modelFast: string;
  modelSmart: string;
  baseUrl: string;
  /** Sealed when provided; omit to keep the existing key. */
  apiKey?: string;
};

async function readAi(orgId: string): Promise<{ ai: RawAi; orgName: string | null }> {
  const r = (await db.execute(sql`
    select settings->'ai' as ai, name from orgs where id = ${orgId}
  `)) as unknown as { rows: { ai: unknown; name: string }[] };
  const raw = r.rows[0]?.ai;
  return {
    ai: (raw && typeof raw === "object" ? raw : {}) as RawAi,
    orgName: r.rows[0]?.name ?? null,
  };
}

export async function getOrgAiSettings(orgId: string): Promise<OrgAiSettings> {
  const { ai } = await readAi(orgId);
  return {
    enabled: ai.enabled !== false,
    provider: normProvider(ai.provider),
    modelFast: ai.modelFast ?? "",
    modelSmart: ai.modelSmart ?? "",
    baseUrl: ai.baseUrl ?? "",
    hasKey: Boolean(ai.keyEncrypted),
  };
}

/**
 * Runtime config (decrypted key) for AI calls — the single resolver every
 * consumer uses. Null when disabled, keyless, or the key fails to unseal.
 * The org name always travels with the resolved config for prompt grounding.
 */
export async function getOrgAiConfig(orgId: string): Promise<AiConfig | null> {
  const { ai, orgName } = await readAi(orgId);
  if (ai.enabled === false) return null;
  const apiKey = unsealSecret(ai.keyEncrypted);
  if (!apiKey) return null;
  return {
    provider: normProvider(ai.provider),
    apiKey,
    modelFast: ai.modelFast || null,
    modelSmart: ai.modelSmart || null,
    baseUrl: ai.baseUrl || null,
    org: orgName ? { name: orgName } : null,
  };
}

/**
 * Merge form input over the previously-stored config, re-sealing the key only
 * when a new one was typed. Throws on an invalid base URL.
 */
export async function saveOrgAiSettings(
  orgId: string,
  userId: string,
  input: AiSettingsInput,
): Promise<void> {
  const baseUrl = validateAiBaseUrl(input.provider, input.baseUrl) ?? "";
  await db.transaction(async (tx) => {
    const r = (await tx.execute(sql`
      select settings->'ai' as ai from orgs where id = ${orgId} for update
    `)) as unknown as { rows: { ai: unknown }[] };
    const raw = r.rows[0]?.ai;
    const prev = (raw && typeof raw === "object" ? raw : {}) as RawAi;
    const next: RawAi = {
      enabled: input.enabled,
      provider: input.provider,
      modelFast: input.modelFast || undefined,
      modelSmart: input.modelSmart || undefined,
      baseUrl: baseUrl || undefined,
      keyEncrypted: prev.keyEncrypted,
    };
    if (input.apiKey && input.apiKey.trim()) {
      next.keyEncrypted = sealSecret(input.apiKey.trim());
    }
    await tx.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ai}', ${JSON.stringify(next)}::jsonb),
             updated_at = now(), updated_by = ${userId}
       where id = ${orgId}
    `);
  });
}

/** Clear the stored API key for this org. */
export async function clearOrgAiKey(orgId: string, userId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ai}',
             (coalesce(settings->'ai', '{}'::jsonb) - 'keyEncrypted')),
           updated_at = now(), updated_by = ${userId}
     where id = ${orgId}
  `);
}
