'use client'

import type { ScanField, ScanResolution } from '@openbooks/engine/src/inventory/item-identifiers.ts'

export type ScanAttempt =
  | { ok: true; value: string; label: string; unit: string | null }
  | { ok: false; message: string; candidates: string[] }

export type ScanRequest = { field: ScanField; customerId?: string; itemId?: string }

/** A disabled feature produces no picker resolver, so the shared control has
 * no keyboard-wedge or camera affordance to render. */
export function optionalScanResolver(
  enabled: boolean,
  request: (value: string) => ScanRequest,
): ((value: string) => Promise<ScanAttempt>) | undefined {
  return enabled ? (value) => resolveScanValue({ ...request(value), value }) : undefined
}

/** Browser-side glue for the shared picker. Refusal bodies are inspected only
 * after the HTTP status has been checked, preserving the server's remedy. */
export async function resolveScanValue(input: {
  field: ScanField
  value: string
  customerId?: string
  itemId?: string
}): Promise<ScanAttempt> {
  let response: Response
  try {
    response = await fetch('/api/scan/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  } catch {
    return { ok: false, message: 'scan_network_error', candidates: [] }
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; candidates?: ScanResolution[] }
    return {
      ok: false,
      message: body.error ?? 'scan_network_error',
      candidates: (body.candidates ?? []).map((candidate) => candidate.label),
    }
  }
  const body = await response.json() as { resolution: ScanResolution }
  return {
    ok: true,
    value: body.resolution.id,
    label: body.resolution.label,
    unit: body.resolution.unit,
  }
}
