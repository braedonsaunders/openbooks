const GOVERNMENT_FORMAT_BY_CHANNEL: Record<string, string> = {
  print_pdf: 'paper',
  file_upload: 'certified_file',
  efile_api: 'api',
  portal_manual: 'portal_entry',
}

/** A filing method determines the only compatible government format. Keeping
 * this derivation at the API boundary prevents contradictory return settings. */
export function governmentFormatForSubmissionChannel(channel: unknown): string | undefined {
  return GOVERNMENT_FORMAT_BY_CHANNEL[String(channel ?? '')]
}

export function normalizeTaxReturnFormInput(
  entityKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey !== 'tax-return-forms') return body
  const { governmentFormat: _ignored, ...normalized } = body
  const governmentFormat = governmentFormatForSubmissionChannel(body.submissionChannel)
  return governmentFormat ? { ...normalized, governmentFormat } : normalized
}
