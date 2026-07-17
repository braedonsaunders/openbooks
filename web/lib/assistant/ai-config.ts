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
import {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  getContinuousClosePolicies,
  nextContinuousCloseRunAt,
  type AgentCadence,
  type ContinuousCloseAgentKey,
  type ContinuousClosePolicy,
} from "@openbooks/engine/src/continuous-close.ts";
import { fromUnits, toUnits } from "@openbooks/engine/src/money.ts";

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
  agents: ContinuousClosePolicy[];
};

export type AgentSettingsInput = {
  agentKey: ContinuousCloseAgentKey;
  enabled: boolean;
  automaticRuns: boolean;
  cadence: AgentCadence;
  materialityThreshold: string;
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
  agents: AgentSettingsInput[];
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
  const [{ ai }, agents] = await Promise.all([readAi(orgId), getContinuousClosePolicies(orgId)]);
  return {
    enabled: ai.enabled !== false,
    provider: normProvider(ai.provider),
    modelFast: ai.modelFast ?? "",
    modelSmart: ai.modelSmart ?? "",
    baseUrl: ai.baseUrl ?? "",
    hasKey: Boolean(ai.keyEncrypted),
    agents,
  };
}

export function normalizeAgentSettingsInput(raw: unknown): AgentSettingsInput[] {
  const rows = Array.isArray(raw) ? raw : [];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const value of rows) {
    if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      if (typeof row.agentKey === "string") byKey.set(row.agentKey, row);
    }
  }
  return CONTINUOUS_CLOSE_AGENT_KEYS.map((agentKey) => {
    const row = byKey.get(agentKey) ?? {};
    const rawThreshold = String(row.materialityThreshold ?? "1000").trim();
    let threshold: string;
    try {
      const units = toUnits(rawThreshold);
      if (units < 0n) throw new Error("negative");
      threshold = fromUnits(units);
    } catch {
      throw new Error(`invalid materiality threshold for ${agentKey}`);
    }
    return {
      agentKey,
      enabled: row.enabled === true,
      automaticRuns: row.automaticRuns === true,
      cadence: row.cadence === "weekly" ? "weekly" : "daily",
      materialityThreshold: threshold,
    };
  });
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
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify({
        area: "ai",
        enabled: input.enabled,
        provider: input.provider,
        modelFast: input.modelFast || null,
        modelSmart: input.modelSmart || null,
        baseUrl: baseUrl || null,
        keyReplaced: Boolean(input.apiKey),
      })}::jsonb, ${userId})
    `);

    for (const agent of input.agents) {
      const prior = (await tx.execute(sql`
        select id, enabled, automatic_runs, cadence, next_run_at
          from ai_agent_policies
         where org_id = ${orgId} and agent_key = ${agent.agentKey}
         for update
      `)) as unknown as { rows: { id: string; enabled: boolean; automatic_runs: boolean; cadence: AgentCadence; next_run_at: Date | null }[] };
      const previous = prior.rows[0];
      const schedulable = input.enabled && agent.enabled && agent.automaticRuns;
      const scheduleChanged = !previous || !previous.enabled || !previous.automatic_runs || previous.cadence !== agent.cadence;
      const nextRunAt = schedulable
        ? scheduleChanged || !previous?.next_run_at
          ? nextContinuousCloseRunAt(agent.cadence)
          : previous.next_run_at
        : null;
      const saved = (await tx.execute(sql`
        insert into ai_agent_policies (
          org_id, agent_key, enabled, automatic_runs, cadence, materiality_threshold,
          next_run_at, created_by, updated_by
        ) values (
          ${orgId}, ${agent.agentKey}, ${agent.enabled}, ${agent.automaticRuns},
          ${agent.cadence}, ${agent.materialityThreshold}, ${nextRunAt}, ${userId}, ${userId}
        )
        on conflict (org_id, agent_key) do update set
          enabled = excluded.enabled,
          automatic_runs = excluded.automatic_runs,
          cadence = excluded.cadence,
          materiality_threshold = excluded.materiality_threshold,
          next_run_at = excluded.next_run_at,
          updated_at = now(),
          updated_by = excluded.updated_by
        returning id
      `)) as unknown as { rows: { id: string }[] };
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'ai_agent_policies', ${saved.rows[0]!.id}, 'update', ${JSON.stringify({
          agentKey: agent.agentKey,
          enabled: agent.enabled,
          automaticRuns: agent.automaticRuns,
          cadence: agent.cadence,
          materialityThreshold: agent.materialityThreshold,
        })}::jsonb, ${userId})
      `);
    }
  });
}

/** Clear the stored API key for this org. */
export async function clearOrgAiKey(orgId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ai}',
               (coalesce(settings->'ai', '{}'::jsonb) - 'keyEncrypted')),
             updated_at = now(), updated_by = ${userId}
       where id = ${orgId}
    `);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'orgs', ${orgId}, 'update', '{"area":"ai","keyRemoved":true}'::jsonb, ${userId})
    `);
  });
}
