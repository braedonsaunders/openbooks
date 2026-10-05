import { canonicalDecimal, compareDecimal, fixedDecimal } from '../../../lib/exact-decimal'

const WEIGHT_UNITS = new Set(['g', 'kg', 'oz', 'lb'])
const DIMENSION_UNITS = new Set(['cm', 'in'])
const DIMENSION_KEYS = ['length', 'width', 'height'] as const

export interface ItemShippingDimensions {
  length: string | null
  width: string | null
  height: string | null
  unit: 'cm' | 'in'
}

export interface ItemShippingValues {
  weight?: string | null
  weightUnit?: string | null
  dimensions?: ItemShippingDimensions | null
  hsCode?: string | null
  countryOfOrigin?: string | null
}

export type ItemShippingParsed =
  | { ok: true; values: ItemShippingValues }
  | { ok: false; message: string }

/**
 * Shipping attributes of an item, shared by item create and update. Usable
 * values normalize to storage shape (four-decimal measures, uppercased
 * origin); every unusable value refuses by name with its remedy, so the
 * database CHECKs stay a backstop that never fires first. Non-text values
 * are invalid, never silent clears.
 */
export function parseItemShippingFields(body: Record<string, unknown>): ItemShippingParsed {
  const values: ItemShippingValues = {}
  if (body.weight !== undefined) {
    const parsed = decimalOrNull(body.weight, 'Weight')
    if (!parsed.ok) return parsed
    if (parsed.value !== null && compareDecimal(parsed.value, '0') <= 0) {
      return { ok: false, message: 'Weight must be positive — rating refuses a zero weight by name' }
    }
    values.weight = parsed.value
  }
  if (body.weightUnit !== undefined) {
    if (body.weightUnit === null) {
      values.weightUnit = null
    } else if (typeof body.weightUnit !== 'string' || !WEIGHT_UNITS.has(body.weightUnit)) {
      return { ok: false, message: 'Weight unit must be g, kg, oz or lb' }
    } else {
      values.weightUnit = body.weightUnit
    }
  }
  if (body.dimensions !== undefined) {
    if (body.dimensions === null) {
      values.dimensions = null
    } else if (typeof body.dimensions !== 'object' || Array.isArray(body.dimensions)) {
      return { ok: false, message: 'Dimensions must name length, width, height and their unit' }
    } else {
      const source = body.dimensions as Record<string, unknown>
      const unit = source.unit
      if (typeof unit !== 'string' || !DIMENSION_UNITS.has(unit)) {
        return { ok: false, message: 'Dimension unit must be cm or in' }
      }
      const dims: Record<string, string | null> = {}
      for (const key of DIMENSION_KEYS) {
        const raw = source[key]
        if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
          dims[key] = null
          continue
        }
        const parsed = decimalOrNull(raw, key === 'length' ? 'Length' : key === 'width' ? 'Width' : 'Height')
        if (!parsed.ok) return parsed
        if (parsed.value !== null && compareDecimal(parsed.value, '0') <= 0) {
          return { ok: false, message: `${labelOf(key)} must be positive` }
        }
        dims[key] = parsed.value
      }
      values.dimensions = {
        length: dims.length ?? null,
        width: dims.width ?? null,
        height: dims.height ?? null,
        unit: unit as 'cm' | 'in',
      }
    }
  }
  if (body.hsCode !== undefined) {
    if (body.hsCode === null) {
      values.hsCode = null
    } else if (typeof body.hsCode !== 'string') {
      return { ok: false, message: 'HS code must be text, like 8471.30' }
    } else {
      const trimmed = body.hsCode.trim()
      if (trimmed.length > 24) return { ok: false, message: 'HS code is too long — at most 24 characters' }
      values.hsCode = trimmed || null
    }
  }
  if (body.countryOfOrigin !== undefined) {
    if (body.countryOfOrigin === null) {
      values.countryOfOrigin = null
    } else if (typeof body.countryOfOrigin !== 'string' || !/^[A-Za-z]{2}$/.test(body.countryOfOrigin.trim())) {
      return { ok: false, message: 'Country of origin must be the two-letter country code, like US' }
    } else {
      values.countryOfOrigin = body.countryOfOrigin.trim().toUpperCase()
    }
  }
  return { ok: true, values }
}

function labelOf(key: string): string {
  return key === 'length' ? 'Length' : key === 'width' ? 'Width' : 'Height'
}

function decimalOrNull(
  value: unknown,
  label: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, message: `${label} must be a number, like 2.5` }
  }
  const exact = canonicalDecimal(value.trim(), 4)
  if (exact === null) {
    return { ok: false, message: `${label} "${value.trim()}" is not a number — enter it like 2.5` }
  }
  return { ok: true, value: fixedDecimal(exact, 4) }
}
