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
  normalizeContinuousCloseAnalysisSettings,
  normalizeContinuousCloseDetectors,
  type AgentCadence,
  type ContinuousCloseAnalysisSettings,
  type ContinuousCloseAgentKey,
  type ContinuousCloseDetectorPolicy,
  type ContinuousClosePolicy,
} from "@openbooks/engine/src/continuous-close.ts";
import { serializeContinuousCloseDetectors } from "@openbooks/engine/src/continuous-close-config.ts";
import { fromUnits, toUnits } from "@openbooks/engine/src/money.ts";
import {
  normalizeStoredDocumentCapture,
  type DocumentCaptureSettings,
  type StoredDocumentCapture,
} from "@openbooks/engine/src/ap-capture-config.ts";
import { DEFAULT_INVOICE_MODEL, validateAzureDocumentEndpoint } from "@openbooks/engine/src/ap-capture.ts";

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
  documentCapture?: StoredDocumentCapture;
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
  documentCapture: DocumentCaptureSettings;
};

export type DocumentCaptureSettingsInput = Omit<DocumentCaptureSettings, "hasKey"> & {
  apiKey?: string;
};

export type AgentSettingsInput = {
  agentKey: ContinuousCloseAgentKey;
  enabled: boolean;
  automaticRuns: boolean;
  cadence: AgentCadence;
  materialityThreshold: string;
  detectors: ContinuousCloseDetectorPolicy[];
  analysis: ContinuousCloseAnalysisSettings;
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
  documentCapture: DocumentCaptureSettingsInput;
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
    documentCapture: normalizeStoredDocumentCapture(ai.documentCapture),
  };
}

function normalizeDocumentCaptureInput(
  input: DocumentCaptureSettingsInput,
  previous: StoredDocumentCapture | undefined,
): StoredDocumentCapture {
  const endpoint = input.endpoint.trim();
  if (endpoint) validateAzureDocumentEndpoint(endpoint);
  const model = input.model.trim() || DEFAULT_INVOICE_MODEL;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._~-]{1,63}$/.test(model)) throw new Error("invalid document capture model id");
  const threshold = String(input.confidenceThreshold).trim();
  if (!/^0(?:\.\d{1,4})?$|^1(?:\.0{1,4})?$/.test(threshold)) {
    throw new Error("document capture confidence must be between 0 and 1");
  }
  const [whole, fraction = ""] = threshold.split(".");
  const next: StoredDocumentCapture = {
    enabled: input.enabled,
    provider: "azure_document_intelligence",
    endpoint,
    model,
    confidenceThreshold: `${whole}.${fraction.padEnd(4, "0")}`,
    autoCreatePoMatchedDrafts: input.autoCreatePoMatchedDrafts,
    keyEncrypted: previous?.keyEncrypted,
  };
  if (input.apiKey?.trim()) next.keyEncrypted = sealSecret(input.apiKey.trim());
  if (input.enabled && (!endpoint || !next.keyEncrypted)) {
    throw new Error("document capture requires an endpoint and API key");
  }
  return next;
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
  return CONTINUOUS_CLOSE_AGENT_KEYS.map((agentKey) => normalizeAgentSettingInput(agentKey, byKey.get(agentKey) ?? {}));
}

export function normalizeAgentSettingInput(
  agentKey: ContinuousCloseAgentKey,
  raw: unknown,
): AgentSettingsInput {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
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
    detectors: normalizeContinuousCloseDetectors(agentKey, row.detectors),
    analysis: normalizeContinuousCloseAnalysisSettings(row.analysis),
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
      documentCapture: normalizeDocumentCaptureInput(input.documentCapture, prev.documentCapture),
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
        documentCapture: {
          enabled: input.documentCapture.enabled,
          provider: input.documentCapture.provider,
          endpoint: input.documentCapture.endpoint,
          model: input.documentCapture.model,
          confidenceThreshold: input.documentCapture.confidenceThreshold,
          autoCreatePoMatchedDrafts: input.documentCapture.autoCreatePoMatchedDrafts,
          keyReplaced: Boolean(input.documentCapture.apiKey),
        },
      })}::jsonb, ${userId})
    `);

    for (const agent of input.agents) await persistAgentPolicy(tx, orgId, userId, input.enabled, agent);
  });
}

async function persistAgentPolicy(
  tx: any,
  orgId: string,
  userId: string,
  globalEnabled: boolean,
  agent: AgentSettingsInput,
): Promise<void> {
  const prior = (await tx.execute(sql`
    select id, enabled, automatic_runs, cadence, next_run_at
      from ai_agent_policies
     where org_id = ${orgId} and agent_key = ${agent.agentKey}
     for update
  `)) as unknown as { rows: { id: string; enabled: boolean; automatic_runs: boolean; cadence: AgentCadence; next_run_at: Date | null }[] };
  const previous = prior.rows[0];
  const schedulable = globalEnabled && agent.enabled && agent.automaticRuns;
  const scheduleChanged = !previous || !previous.enabled || !previous.automatic_runs || previous.cadence !== agent.cadence;
  const nextRunAt = schedulable
    ? scheduleChanged || !previous?.next_run_at
      ? nextContinuousCloseRunAt(agent.cadence)
      : previous.next_run_at
    : null;
  const detectorSettings = serializeContinuousCloseDetectors(agent.detectors);
  const saved = (await tx.execute(sql`
    insert into ai_agent_policies (
      org_id, agent_key, enabled, automatic_runs, cadence, materiality_threshold,
      detector_settings, analysis_settings, next_run_at, created_by, updated_by
    ) values (
      ${orgId}, ${agent.agentKey}, ${agent.enabled}, ${agent.automaticRuns},
      ${agent.cadence}, ${agent.materialityThreshold}, ${JSON.stringify(detectorSettings)}::jsonb,
      ${JSON.stringify(agent.analysis)}::jsonb, ${nextRunAt}, ${userId}, ${userId}
    )
    on conflict (org_id, agent_key) do update set
      enabled = excluded.enabled,
      automatic_runs = excluded.automatic_runs,
      cadence = excluded.cadence,
      materiality_threshold = excluded.materiality_threshold,
      detector_settings = excluded.detector_settings,
      analysis_settings = excluded.analysis_settings,
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
      detectors: detectorSettings,
      analysis: agent.analysis,
    })}::jsonb, ${userId})
  `);
}

/** Save one agent drawer without mutating provider/model/key settings. */
export async function saveOrgAiAgentSettings(
  orgId: string,
  userId: string,
  raw: unknown,
): Promise<ContinuousClosePolicy> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid agent settings");
  const agentKey = (raw as { agentKey?: unknown }).agentKey;
  if (!CONTINUOUS_CLOSE_AGENT_KEYS.includes(agentKey as ContinuousCloseAgentKey)) throw new Error("invalid agent");
  const agent = normalizeAgentSettingInput(agentKey as ContinuousCloseAgentKey, raw);
  await db.transaction(async (tx) => {
    const org = (await tx.execute(sql`
      select coalesce((settings->'ai'->>'enabled')::boolean, true) as enabled
        from orgs where id = ${orgId} for update
    `)) as unknown as { rows: { enabled: boolean }[] };
    await persistAgentPolicy(tx, orgId, userId, org.rows[0]?.enabled !== false, agent);
  });
  return (await getContinuousClosePolicies(orgId)).find((policy) => policy.agentKey === agent.agentKey)!;
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

/** Clear only the document extraction credential; the LLM provider key is independent. */
export async function clearOrgDocumentCaptureKey(orgId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update orgs
         set settings = jsonb_set(
               coalesce(settings, '{}'::jsonb),
               '{ai,documentCapture}',
               jsonb_set(
                 coalesce(settings->'ai'->'documentCapture', '{}'::jsonb) - 'keyEncrypted',
                 '{enabled}', 'false'::jsonb, true
               ),
               true
             ),
             updated_at = now(), updated_by = ${userId}
       where id = ${orgId}
    `);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'orgs', ${orgId}, 'update',
              '{"area":"ai.documentCapture","keyRemoved":true}'::jsonb, ${userId})
    `);
  });
}
