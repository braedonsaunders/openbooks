'use client'

import { readApiErrorMessage } from '../api-error'

/**
 * Browser calls the Setup builders make. Row writes go through the shared
 * Setup API (/api/admin/setup/[entity]) so every builder edit meets the
 * same validation, feature fence and audit as any other Setup write.
 * Every refusal resolves to the server's message (or the caller's fallback
 * when the body names nothing) — never swallowed, never a raw status.
 */

export type BuilderResult<T = Record<string, unknown>> = { ok: true; body: T } | { ok: false; error: string; code?: string }

/** Localized copy for the typed conflict codes the Setup writer answers with. */
export interface BuilderErrorCopy {
  fallback: string
  duplicate: string
  inUse: string
  stale: string
  network: string
}

async function send<T>(url: string, init: RequestInit, copy: BuilderErrorCopy): Promise<BuilderResult<T>> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    return { ok: false, error: copy.network }
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as T
    return { ok: true, body }
  }
  const probe = res.clone()
  const code = await probe
    .json()
    .then((body: unknown) => (body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined))
    .catch(() => undefined)
  if (code === 'duplicate') return { ok: false, error: copy.duplicate, code }
  if (code === 'in-use') return { ok: false, error: copy.inUse, code }
  if (code === 'stale') return { ok: false, error: copy.stale, code }
  return { ok: false, error: await readApiErrorMessage(res, copy.fallback), code: typeof code === 'string' ? code : undefined }
}

const JSON_HEADERS = { 'content-type': 'application/json' }

export function createSetupRow(entity: string, body: Record<string, unknown>, copy: BuilderErrorCopy) {
  return send<{ id?: string }>(`/api/admin/setup/${entity}`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  }, copy)
}

export function updateSetupRow(entity: string, id: string, body: Record<string, unknown>, copy: BuilderErrorCopy) {
  return send(`/api/admin/setup/${entity}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...body, id }),
  }, copy)
}

export function deleteSetupRow(entity: string, id: string, copy: BuilderErrorCopy) {
  return send(`/api/admin/setup/${entity}?id=${encodeURIComponent(id)}`, { method: 'DELETE' }, copy)
}

export function putJson(url: string, body: unknown, copy: BuilderErrorCopy) {
  return send(url, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) }, copy)
}

export function postJson(url: string, body: unknown, copy: BuilderErrorCopy) {
  return send(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, copy)
}
