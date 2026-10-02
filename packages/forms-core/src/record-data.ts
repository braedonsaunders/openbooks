import { evaluateFormulaTree, FormulaEvaluationError } from './evaluator'
import type { FormSection, FormField, FieldType } from './schema'
import type { FieldValueMap, RowMap } from './evaluator'

export function splitRecordData(
  sections: FormSection[],
  data: FieldValueMap,
): { values: FieldValueMap; rows: RowMap } {
  const repeatingIds = new Set(sections.filter((s) => s.repeating).map((s) => s.id))
  const values: FieldValueMap = {}
  const rows: RowMap = {}
  for (const [k, v] of Object.entries(data)) {
    if (repeatingIds.has(k)) rows[k] = Array.isArray(v) ? (v as FieldValueMap[]) : []
    else values[k] = v
  }
  return { values, rows }
}

/** Merge header values and repeating rows back into the stored `data` shape. */
export function mergeRecordData(values: FieldValueMap, rows: RowMap): FieldValueMap {
  return { ...values, ...rows }
}

export function withComputedFormulas(sections: FormSection[], data: FieldValueMap): FieldValueMap {
  const { values, rows } = splitRecordData(sections, data)

  // Resolve references lazily through proxies instead of evaluating each
  // field against the original input snapshot. This makes chained formulas
  // independent of declaration order and lets rollups see final row values.
  // A resolving guard keeps malformed cyclic definitions bounded; the schema
  // linter rejects self-references, while a cycle reaching this runtime
  // resolves its recursive edge to null rather than recursing forever.
  const headerFormulas = new Map<string, FormField>()
  const rowFormulas = new Map<string, Map<string, FormField>>()
  for (const section of sections) {
    const formulas = new Map(
      section.fields.filter((field) => field.type === 'formula').map((field) => [field.id, field]),
    )
    if (section.repeating) rowFormulas.set(section.id, formulas)
    else for (const [fieldId, field] of formulas) headerFormulas.set(fieldId, field)
  }

  const headerMemo = new Map<string, number | string | null>()
  const rowMemo = new Map<string, number | string | null>()
  const resolving = new Set<string>()

  const headerValues = new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === 'string' && headerFormulas.has(property)) {
        return resolveHeaderField(property)
      }
      return Reflect.get(target, property, receiver)
    },
  })

  const rowValueProxies = new Map<string, FieldValueMap[]>()
  const formulaRows: RowMap = {}
  const rowValues = (sectionId: string, rowIndex: number): FieldValueMap => {
    const sectionRows = rowValueProxies.get(sectionId)
    if (sectionRows?.[rowIndex]) return sectionRows[rowIndex]!

    const rawRow = rows[sectionId]?.[rowIndex]
    const row: FieldValueMap =
      rawRow && typeof rawRow === 'object' && !Array.isArray(rawRow) ? rawRow : {}
    const formulas = rowFormulas.get(sectionId) ?? new Map<string, FormField>()
    const proxy = new Proxy(row, {
      get(target, property, receiver) {
        if (typeof property === 'string' && formulas.has(property)) {
          return resolveRowField(sectionId, rowIndex, property)
        }
        if (
          typeof property === 'string' &&
          Object.prototype.hasOwnProperty.call(target, property)
        ) {
          return Reflect.get(target, property, receiver)
        }
        if (typeof property === 'string' && headerFormulas.has(property)) {
          return resolveHeaderField(property)
        }
        if (typeof property === 'string') return headerValues[property]
        return Reflect.get(target, property, receiver)
      },
    })
    if (sectionRows) sectionRows[rowIndex] = proxy
    else {
      const proxies: FieldValueMap[] = []
      proxies[rowIndex] = proxy
      rowValueProxies.set(sectionId, proxies)
    }
    return proxy
  }

  for (const section of sections) {
    if (!section.repeating) continue
    const sectionRows = rows[section.id] ?? []
    formulaRows[section.id] = sectionRows.map((_row, rowIndex) => rowValues(section.id, rowIndex))
  }

  // A formula that cannot evaluate (divide-by-zero, garbage operand)
  // persists as null — a visibly blank field — never as a silent 0 that
  // reads like a real amount. The named refusal stays available to previews
  // through evaluateFormulaTree itself.
  function evaluateToBlank(
    expr: Parameters<typeof evaluateFormulaTree>[0],
    ctx: Parameters<typeof evaluateFormulaTree>[1],
  ): number | string | null {
    try {
      return evaluateFormulaTree(expr, ctx)
    } catch (error) {
      if (error instanceof FormulaEvaluationError) return null
      throw error
    }
  }

  function resolveHeaderField(fieldId: string): unknown {
    const formula = headerFormulas.get(fieldId)
    if (!formula) return values[fieldId]
    if (headerMemo.has(fieldId)) return headerMemo.get(fieldId)
    const key = `header:${fieldId}`
    if (resolving.has(key)) return null
    resolving.add(key)
    const result = formula.formula
      ? evaluateToBlank(formula.formula, { values: headerValues, rows: formulaRows })
      : null
    resolving.delete(key)
    headerMemo.set(fieldId, result)
    return result
  }

  function resolveRowField(sectionId: string, rowIndex: number, fieldId: string): unknown {
    const formula = rowFormulas.get(sectionId)?.get(fieldId)
    const rawRow = rows[sectionId]?.[rowIndex]
    if (!formula) {
      return rawRow && typeof rawRow === 'object' && !Array.isArray(rawRow)
        ? rawRow[fieldId]
        : undefined
    }
    const key = `row:${sectionId}:${rowIndex}:${fieldId}`
    if (rowMemo.has(key)) return rowMemo.get(key)
    if (resolving.has(key)) return null
    resolving.add(key)
    const result = formula.formula
      ? evaluateToBlank(formula.formula, {
          values: rowValues(sectionId, rowIndex),
          rows: formulaRows,
        })
      : null
    resolving.delete(key)
    rowMemo.set(key, result)
    return result
  }

  const outRows: RowMap = { ...rows }
  for (const section of sections) {
    if (!section.repeating) continue
    const sectionRows = rows[section.id] ?? []
    const formulas = rowFormulas.get(section.id)
    if (!formulas?.size) {
      outRows[section.id] = sectionRows
      continue
    }
    outRows[section.id] = sectionRows.map((row, rowIndex) => {
      const next = { ...row }
      for (const fieldId of formulas.keys())
        next[fieldId] = resolveRowField(section.id, rowIndex, fieldId)
      return next
    })
  }

  const outValues: FieldValueMap = { ...values }
  for (const fieldId of headerFormulas.keys()) outValues[fieldId] = resolveHeaderField(fieldId)
  return mergeRecordData(outValues, outRows)
}

/** Field types supported by the shared record editor; file evidence uses File Cabinet. */
export const RECORD_FIELD_TYPES: readonly FieldType[] = [
  'text',
  'long_text',
  'number',
  'currency',
  'percentage',
  'select',
  'multi_select',
  'radio',
  'date',
  'datetime',
  'rating',
  'formula',
  'gl_account',
  'party',
] as const
