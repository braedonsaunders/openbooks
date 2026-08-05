export type TaxReturnLibraryMode = 'install' | 'reset'

export type TaxReturnLibraryPlan = {
  mode: TaxReturnLibraryMode
  requested: string[]
  targets: string[]
  skipped: string[]
}

export type TaxReturnLibraryPlanError = {
  error: 'invalid-request' | 'unknown-pack' | 'pack-not-installed'
  status: 400 | 409 | 422
}

/** Validate and plan a bulk library mutation without allowing installs to reset existing returns. */
export function planTaxReturnLibraryChange(
  input: unknown,
  knownCodes: ReadonlySet<string>,
  installedCodes: ReadonlySet<string>,
): TaxReturnLibraryPlan | TaxReturnLibraryPlanError {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'invalid-request', status: 400 }
  }
  const body = input as { packs?: unknown; mode?: unknown }
  if ((body.mode !== 'install' && body.mode !== 'reset') || !Array.isArray(body.packs)) {
    return { error: 'invalid-request', status: 400 }
  }
  if (body.packs.length === 0 || body.packs.length > 25 || body.packs.some((code) => typeof code !== 'string')) {
    return { error: 'invalid-request', status: 400 }
  }

  const requested = [...new Set(body.packs as string[])]
  if (requested.some((code) => !knownCodes.has(code))) {
    return { error: 'unknown-pack', status: 422 }
  }
  if (body.mode === 'reset' && requested.some((code) => !installedCodes.has(code))) {
    return { error: 'pack-not-installed', status: 409 }
  }

  const targets = body.mode === 'install'
    ? requested.filter((code) => !installedCodes.has(code))
    : requested
  const skipped = body.mode === 'install'
    ? requested.filter((code) => installedCodes.has(code))
    : []
  return { mode: body.mode, requested, targets, skipped }
}
