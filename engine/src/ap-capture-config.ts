import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { unsealSecret } from "./secrets.ts";
import { DEFAULT_INVOICE_MODEL, validateAzureDocumentEndpoint } from "./ap-capture.ts";

export type DocumentCaptureSettings = {
  enabled: boolean;
  provider: "azure_document_intelligence";
  endpoint: string;
  model: string;
  confidenceThreshold: string;
  autoCreatePoMatchedDrafts: boolean;
  hasKey: boolean;
};

export type DocumentCaptureRuntimeConfig = Omit<DocumentCaptureSettings, "hasKey"> & {
  apiKey: string;
};

export type StoredDocumentCapture = {
  enabled?: boolean;
  provider?: string;
  endpoint?: string;
  model?: string;
  confidenceThreshold?: string;
  autoCreatePoMatchedDrafts?: boolean;
  keyEncrypted?: string;
};

function normalizeThreshold(value: unknown): string {
  const raw = String(value ?? "0.9000").trim();
  if (!/^0(?:\.\d{1,4})?$|^1(?:\.0{1,4})?$/.test(raw)) return "0.9000";
  const [whole, fraction = ""] = raw.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}`;
}

export function normalizeStoredDocumentCapture(raw: unknown): DocumentCaptureSettings {
  const row = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as StoredDocumentCapture
    : {};
  return {
    enabled: row.enabled === true,
    provider: "azure_document_intelligence",
    endpoint: typeof row.endpoint === "string" ? row.endpoint : "",
    model: typeof row.model === "string" && row.model.trim() ? row.model.trim() : DEFAULT_INVOICE_MODEL,
    confidenceThreshold: normalizeThreshold(row.confidenceThreshold),
    autoCreatePoMatchedDrafts: row.autoCreatePoMatchedDrafts === true,
    hasKey: Boolean(row.keyEncrypted),
  };
}

async function readStored(orgId: string): Promise<{ globalEnabled: boolean; capture: StoredDocumentCapture }> {
  const result = (await db.execute<{ ai: Record<string, unknown> | null }>(sql`
    select settings->'ai' as ai from orgs where id = ${orgId}
  `));
  const ai = result.rows[0]?.ai ?? {};
  const capture = ai.documentCapture;
  return {
    globalEnabled: ai.enabled !== false,
    capture: capture && typeof capture === "object" && !Array.isArray(capture)
      ? capture as StoredDocumentCapture
      : {},
  };
}

export async function getDocumentCaptureTestConfig(
  orgId: string,
  override: { endpoint?: string; model?: string; apiKey?: string },
): Promise<{ endpoint: string; model: string; apiKey: string } | null> {
  const { capture } = await readStored(orgId);
  const settings = normalizeStoredDocumentCapture(capture);
  const endpoint = override.endpoint?.trim() || settings.endpoint;
  const model = override.model?.trim() || settings.model;
  const apiKey = override.apiKey?.trim() || unsealSecret(capture.keyEncrypted) || "";
  if (!endpoint || !apiKey) return null;
  return { endpoint, model, apiKey };
}

export async function getDocumentCaptureSettings(orgId: string): Promise<DocumentCaptureSettings> {
  const { capture } = await readStored(orgId);
  return normalizeStoredDocumentCapture(capture);
}

/** The worker's only config resolver. Disabled/missing/tampered secrets fail closed. */
export async function getDocumentCaptureRuntimeConfig(orgId: string): Promise<DocumentCaptureRuntimeConfig | null> {
  const { globalEnabled, capture } = await readStored(orgId);
  const settings = normalizeStoredDocumentCapture(capture);
  if (!globalEnabled || !settings.enabled) return null;
  if (!settings.endpoint) return null;
  validateAzureDocumentEndpoint(settings.endpoint);
  const apiKey = unsealSecret(capture.keyEncrypted);
  if (!apiKey) return null;
  return { ...settings, apiKey };
}
