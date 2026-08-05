import type { FieldType } from './schema'

// Field-type registry for the OpenBooks field set, including data-bound pickers
// (gl_account, party). The designer palette, config panels, filler renderer,
// and response validator all key off this metadata.

export type FieldOptionsSource = 'gl_accounts' | 'parties'

export type FieldTypeMeta = {
  type: FieldType
  category: 'standard' | 'choice' | 'scoring' | 'identity' | 'media' | 'computed' | 'openbooks'
  label: string
  description: string
  // Runtime value shape stored in form_responses.data[fieldId]
  valueKind:
    | 'string'
    | 'number'
    | 'string_array'
    | 'file_meta_array'
    | 'entity_ref'
    | 'none'
  /**
   * For data-bound pickers: which options endpoint feeds the picker.
   * `/api/forms/options?source=<optionsSource>` returns `{ value, label, hint }`
   * rows — accounts (active, non-summary) or parties (filterable by role kind
   * via `field.config.partyKind`).
   */
  optionsSource?: FieldOptionsSource
}

export const FIELD_TYPES: Record<FieldType, FieldTypeMeta> = {
  // standard
  text: {
    type: 'text',
    category: 'standard',
    label: 'Short text',
    description: 'Single-line text input',
    valueKind: 'string',
  },
  long_text: {
    type: 'long_text',
    category: 'standard',
    label: 'Long text',
    description: 'Multi-line text area',
    valueKind: 'string',
  },
  number: {
    type: 'number',
    category: 'standard',
    label: 'Number',
    description: 'Numeric input with optional units',
    valueKind: 'number',
  },
  currency: {
    type: 'currency',
    category: 'standard',
    label: 'Currency',
    description: 'Money amount — right-aligned, two decimals',
    valueKind: 'number',
  },
  percentage: {
    type: 'percentage',
    category: 'standard',
    label: 'Percentage',
    description: 'Percent value (e.g. 13 for 13%)',
    valueKind: 'number',
  },
  date: {
    type: 'date',
    category: 'standard',
    label: 'Date',
    description: 'Date picker',
    valueKind: 'string',
  },
  datetime: {
    type: 'datetime',
    category: 'standard',
    label: 'Date & time',
    description: 'Date + time picker',
    valueKind: 'string',
  },

  // choice
  select: {
    type: 'select',
    category: 'choice',
    label: 'Dropdown',
    description: 'Single-select dropdown',
    valueKind: 'string',
  },
  multi_select: {
    type: 'multi_select',
    category: 'choice',
    label: 'Multi-select',
    description: 'Pick several options',
    valueKind: 'string_array',
  },
  radio: {
    type: 'radio',
    category: 'choice',
    label: 'Single choice',
    description: 'Pick one option (radio buttons)',
    valueKind: 'string',
  },

  // scoring
  rating: {
    type: 'rating',
    category: 'scoring',
    label: 'Rating',
    description: 'Numeric scale (e.g. 1–5)',
    valueKind: 'number',
  },

  // identity
  signature: {
    type: 'signature',
    category: 'identity',
    label: 'Signature',
    description: 'Typed-name attestation (drawn signature later)',
    valueKind: 'string',
  },

  // media
  file: {
    type: 'file',
    category: 'media',
    label: 'File',
    description: 'File reference — stores name/size/type metadata',
    valueKind: 'file_meta_array',
  },

  // computed
  formula: {
    type: 'formula',
    category: 'computed',
    label: 'Formula',
    description: 'Computed from other fields',
    valueKind: 'none',
  },

  // openbooks-native
  gl_account: {
    type: 'gl_account',
    category: 'openbooks',
    label: 'GL account',
    description: 'Pick an account from the chart of accounts',
    valueKind: 'entity_ref',
    optionsSource: 'gl_accounts',
  },
  party: {
    type: 'party',
    category: 'openbooks',
    label: 'Party',
    description: 'Pick a vendor, customer, or employee',
    valueKind: 'entity_ref',
    optionsSource: 'parties',
  },
}

/** Whether responses persist a caller-supplied value for this field type. */
export function isResponseValueField(type: FieldType): boolean {
  return FIELD_TYPES[type].valueKind !== 'none'
}

/** File metadata stored for `file` fields in v1 (no binary upload yet). */
export type FileMeta = { name: string; size: number; type: string }
