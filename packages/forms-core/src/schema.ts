import { z } from 'zod'
import { isResponseValueField } from './field-types'

// Runtime-validated form schema for the OpenBooks field set. These zod validators are the source
// of truth at runtime — keep them in lockstep with `schema/src/forms.ts`
// (which stores this shape as `form_template_versions.schema` jsonb).

// --- Conditional-visibility rules -------------------------------------------

export type LogicRule =
  | { op: 'and' | 'or'; rules: LogicRule[] }
  | { op: 'not'; rule: LogicRule }
  | { op: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte'; field: string; value: unknown }
  | { op: 'in' | 'notIn'; field: string; value: unknown[] }
  | { op: 'isSet' | 'isNotSet'; field: string }

export const logicRuleSchema: z.ZodType<LogicRule> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.object({ op: z.enum(['and', 'or']), rules: z.array(logicRuleSchema).max(100) }),
    z.object({ op: z.literal('not'), rule: logicRuleSchema }),
    z.object({
      op: z.enum(['eq', 'ne', 'gt', 'lt', 'gte', 'lte']),
      field: z.string().max(128),
      value: z.unknown(),
    }),
    z.object({
      op: z.enum(['in', 'notIn']),
      field: z.string().max(128),
      value: z.array(z.unknown()).max(100),
    }),
    z.object({ op: z.enum(['isSet', 'isNotSet']), field: z.string().max(128) }),
  ]),
)

// --- Formula expression tree -------------------------------------------------
//
// Stored on FormField.formula as a small JSON expression. Evaluated by
// `evaluateFormulaTree()` in `./evaluator.ts` — the only formula runtime;
// designer-built formula fields always persist a typed tree. There is no
// string-formula path and no eval().
export type FormulaExpression =
  | { kind: 'literal'; value: number | string }
  | { kind: 'field_ref'; fieldKey: string }
  | { kind: 'sum'; of: FormulaExpression[] }
  | { kind: 'product'; of: FormulaExpression[] }
  | { kind: 'subtract'; left: FormulaExpression; right: FormulaExpression }
  | { kind: 'divide'; left: FormulaExpression; right: FormulaExpression }
  | { kind: 'min'; of: FormulaExpression[] }
  | { kind: 'max'; of: FormulaExpression[] }
  // Scientific math. `power` = base^exponent; `root` = of^(1/degree) with sign
  // preserved for odd roots; `round` rounds to `places` decimals (default 0).
  // All guard against NaN/∞ → 0.
  | { kind: 'power'; base: FormulaExpression; exponent: FormulaExpression }
  | { kind: 'root'; of: FormulaExpression; degree: FormulaExpression }
  | { kind: 'abs'; of: FormulaExpression }
  | { kind: 'round'; of: FormulaExpression; places?: number }
  | { kind: 'floor'; of: FormulaExpression }
  | { kind: 'ceil'; of: FormulaExpression }
  // sum / count / avg / min / max a field across all rows of a repeating
  // section ("rollups").
  | { kind: 'sum_section'; sectionKey: string; rowFieldKey: string }
  | { kind: 'count_section'; sectionKey: string }
  | { kind: 'avg_section'; sectionKey: string; rowFieldKey: string }
  | { kind: 'min_section'; sectionKey: string; rowFieldKey: string }
  | { kind: 'max_section'; sectionKey: string; rowFieldKey: string }
  | { kind: 'concat'; of: FormulaExpression[]; separator?: string }
  | { kind: 'if'; condition: LogicRule; then: FormulaExpression; else: FormulaExpression }

export const formulaExpressionSchema: z.ZodType<FormulaExpression> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('literal'),
      value: z.union([z.number(), z.string().max(10_000)]),
    }),
    z.object({ kind: z.literal('field_ref'), fieldKey: z.string().max(128) }),
    z.object({ kind: z.literal('sum'), of: z.array(formulaExpressionSchema).max(100) }),
    z.object({ kind: z.literal('product'), of: z.array(formulaExpressionSchema).max(100) }),
    z.object({
      kind: z.literal('subtract'),
      left: formulaExpressionSchema,
      right: formulaExpressionSchema,
    }),
    z.object({
      kind: z.literal('divide'),
      left: formulaExpressionSchema,
      right: formulaExpressionSchema,
    }),
    z.object({ kind: z.literal('min'), of: z.array(formulaExpressionSchema).max(100) }),
    z.object({ kind: z.literal('max'), of: z.array(formulaExpressionSchema).max(100) }),
    z.object({
      kind: z.literal('power'),
      base: formulaExpressionSchema,
      exponent: formulaExpressionSchema,
    }),
    z.object({
      kind: z.literal('root'),
      of: formulaExpressionSchema,
      degree: formulaExpressionSchema,
    }),
    z.object({ kind: z.literal('abs'), of: formulaExpressionSchema }),
    z.object({
      kind: z.literal('round'),
      of: formulaExpressionSchema,
      places: z.number().int().min(0).max(12).optional(),
    }),
    z.object({ kind: z.literal('floor'), of: formulaExpressionSchema }),
    z.object({ kind: z.literal('ceil'), of: formulaExpressionSchema }),
    z.object({
      kind: z.literal('sum_section'),
      sectionKey: z.string().max(128),
      rowFieldKey: z.string().max(128),
    }),
    z.object({ kind: z.literal('count_section'), sectionKey: z.string().max(128) }),
    z.object({
      kind: z.literal('avg_section'),
      sectionKey: z.string().max(128),
      rowFieldKey: z.string().max(128),
    }),
    z.object({
      kind: z.literal('min_section'),
      sectionKey: z.string().max(128),
      rowFieldKey: z.string().max(128),
    }),
    z.object({
      kind: z.literal('max_section'),
      sectionKey: z.string().max(128),
      rowFieldKey: z.string().max(128),
    }),
    z.object({
      kind: z.literal('concat'),
      of: z.array(formulaExpressionSchema).max(100),
      separator: z.string().max(1_000).optional(),
    }),
    z.object({
      kind: z.literal('if'),
      condition: logicRuleSchema,
      then: formulaExpressionSchema,
      else: formulaExpressionSchema,
    }),
  ]),
)

// --- Default-value expression -----------------------------------------------
//
// Applied on first render of a field (filler) when the response value is empty.
// Resolved against the request context (user / now) by `resolveDefaultValue()`
// in `./evaluator.ts`.
export type DefaultValueExpression =
  | { kind: 'literal'; value: unknown }
  | { kind: 'today' }
  | { kind: 'now' }
  | { kind: 'current_user_name' }
  | { kind: 'expression'; expr: FormulaExpression }

export const defaultValueExpressionSchema: z.ZodType<DefaultValueExpression> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('literal'), value: z.unknown() }),
    z.object({ kind: z.literal('today') }),
    z.object({ kind: z.literal('now') }),
    z.object({ kind: z.literal('current_user_name') }),
    z.object({ kind: z.literal('expression'), expr: formulaExpressionSchema }),
  ]),
)

// --- Field types --------------------------------------------------------------

export const fieldTypeSchema = z.enum([
  // standard
  'text',
  'long_text',
  'number',
  'currency', // number rendered/validated as money (right-aligned, 2dp)
  'percentage', // number rendered as a percent
  'date',
  'datetime',
  // choice
  'select',
  'multi_select',
  'radio',
  // scoring
  'rating',
  // identity — v1 stores a typed-name attestation string (canvas deferred)
  'signature',
  // media — v1 stores file METADATA only ({ name, size, type }); no upload yet
  'file',
  // computed
  'formula',
  // openbooks-native pickers (options served by /api/forms/options)
  'gl_account', // GL account picker → stores accounts.id
  'party', // vendor / customer / employee picker → stores parties.id
])

export type FieldType = z.infer<typeof fieldTypeSchema>

export const PARTY_PICKER_KINDS = ['any', 'customer', 'vendor', 'employee'] as const
export type PartyPickerKind = (typeof PARTY_PICKER_KINDS)[number]

export const fieldValidationSchema = z
  .object({
    // Optional `required` on the validation block mirrors FormField.required.
    // The filler treats `field.required || field.validation?.required` as the
    // effective check.
    required: z.boolean().optional(),
    min: z.number().min(-1_000_000_000).max(1_000_000_000).optional(),
    max: z.number().min(-1_000_000_000).max(1_000_000_000).optional(),
    minLength: z.number().int().nonnegative().max(100_000).optional(),
    maxLength: z.number().int().nonnegative().max(100_000).optional(),
    pattern: z.string().max(256).optional(),
    message: z.string().max(2_000).optional(),
    options: z
      .array(z.object({ value: z.string().max(500), label: z.string().max(500) }))
      .max(100)
      .optional(),
  })
  .partial()

export type FieldValidation = z.infer<typeof fieldValidationSchema>
export type ChoiceOption = { value: string; label: string }

export const formFieldSchema = z.object({
  id: z.string().min(1),
  type: fieldTypeSchema,
  label: z.string().min(1).max(500),
  helpText: z.string().max(2_000).optional(),
  required: z.boolean().optional(),
  showIf: logicRuleSchema.optional(),
  validation: fieldValidationSchema.optional(),
  // Freeform per-type config bag (number min/max/step/unit, rating max,
  // party partyKind, formula format, …). Cross-checked by the invariants below.
  config: z.record(z.string(), z.unknown()).optional(),
  // Typed JSON formula tree. Formula fields are computed and read-only in the
  // filler; this tree is their sole persisted expression format.
  formula: formulaExpressionSchema.optional(),
  // Default value applied on first render when the response value is empty.
  defaultValue: defaultValueExpressionSchema.optional(),
})

export type FormField = z.infer<typeof formFieldSchema>

export const formSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().max(500).optional(),
  description: z.string().max(2_000).optional(),
  showIf: logicRuleSchema.optional(),
  // Repeating sections store an ARRAY of row value maps under the SECTION id
  // in the response payload: data[sectionId] = [{ fieldId: value, … }, …].
  repeating: z.boolean().optional(),
  // Bounds on a repeating section. `minRows` blocks submission until
  // satisfied; `maxRows` disables the "Add row" button.
  minRows: z.number().int().nonnegative().max(500).optional(),
  maxRows: z.number().int().positive().max(500).optional(),
  fields: z.array(formFieldSchema).max(200),
})

export type FormSection = z.infer<typeof formSectionSchema>

const formSchemaV1Base = z.object({
  schemaVersion: z.literal(1),
  title: z.string().min(1).max(500),
  description: z.string().max(2_000).optional(),
  sections: z.array(formSectionSchema).min(1).max(100),
})

export type FormSchemaV1 = z.infer<typeof formSchemaV1Base>

// --- Cross-field invariants ---------------------------------------------------

export type SchemaIssue = {
  path: Array<string | number>
  message: string
}

const MAX_NUMERIC_FIELD_CONFIG = 1_000_000_000
const MAX_VALIDATION_PATTERN_LENGTH = 256
const MAX_FORM_IDENTIFIER_LENGTH = 128
const FORM_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/
const RESERVED_FORM_IDENTIFIERS = new Set(Object.getOwnPropertyNames(Object.prototype))

export const CHOICE_FIELD_TYPES = new Set<FieldType>(['select', 'multi_select', 'radio'])
const NUMERIC_VALIDATION_FIELD_TYPES = new Set<FieldType>([
  'number',
  'currency',
  'percentage',
  'rating',
])
const TEXT_VALIDATION_FIELD_TYPES = new Set<FieldType>(['text', 'long_text', 'date', 'datetime'])

export function textValidationHardLimit(type: FieldType): number | null {
  switch (type) {
    case 'long_text':
      return 100_000
    case 'date':
    case 'datetime':
      return 50
    case 'text':
      return 10_000
    default:
      return null
  }
}

/**
 * Return why a designer-authored regular expression is unsafe, or null when
 * it is safe to execute against a bounded response string.
 *
 * JavaScript RegExp has no execution timeout. Quantified groups, lookarounds,
 * and backreferences can introduce catastrophic backtracking, so form
 * patterns deliberately support a conservative regular subset: an anchored
 * expression made from literals, character classes, and exact `{n}`
 * repetition. Variable repetition and alternation are excluded because even
 * individually simple overlapping branches can create polynomial or
 * exponential ReDoS. This still covers practical fixed-format masks (account
 * codes, postal codes) without making submission validation a DoS primitive.
 */
export function validationPatternError(pattern: string): string | null {
  if (pattern.length === 0) return null
  if (pattern.length > MAX_VALIDATION_PATTERN_LENGTH) {
    return `must be no longer than ${MAX_VALIDATION_PATTERN_LENGTH} characters`
  }
  try {
    new RegExp(pattern)
  } catch {
    return 'is not a valid regular expression'
  }

  let trailingBackslashes = 0
  for (let index = pattern.length - 2; index >= 0 && pattern[index] === '\\'; index -= 1) {
    trailingBackslashes += 1
  }
  if (!pattern.startsWith('^') || !pattern.endsWith('$') || trailingBackslashes % 2 === 1) {
    return 'must be anchored with ^ and $'
  }

  if (/\\(?:[1-9]|k<)/.test(pattern)) return 'must not contain backreferences'
  if (/\(\?(?:[=!]|<[=!])/.test(pattern)) return 'must not contain lookaround assertions'

  let escaped = false
  let inCharacterClass = false
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '[') {
      inCharacterClass = true
      continue
    }
    if (char === ']' && inCharacterClass) {
      inCharacterClass = false
      continue
    }
    if (inCharacterClass) continue
    if (char === '|') return 'must not contain alternation'
    if (char === '*' || char === '+') return 'must not contain variable repetition'
    if (char === '?') {
      if (pattern[index - 1] === '(' && pattern[index + 1] === ':') continue
      return 'must not contain variable repetition'
    }
    if (char === '{') {
      if (pattern[index - 1] === ')') return 'must not quantify groups'
      const close = pattern.indexOf('}', index + 1)
      const count = close === -1 ? '' : pattern.slice(index + 1, close)
      if (!/^\d{1,4}$/.test(count) || Number(count) > 1_000) {
        return 'may only use exact {n} repetition up to 1000'
      }
      index = close
    }
  }

  return null
}

function pathLabel(path: Array<string | number>): string {
  return path
    .map((part, index) =>
      typeof part === 'number' ? `[${part}]` : `${index === 0 ? '' : '.'}${part}`,
    )
    .join('')
}

function identifierIssue(value: string): string | null {
  if (value.length > MAX_FORM_IDENTIFIER_LENGTH) {
    return `must be no longer than ${MAX_FORM_IDENTIFIER_LENGTH} characters`
  }
  if (!FORM_IDENTIFIER_PATTERN.test(value)) {
    return 'may contain only letters, numbers, underscores, and hyphens'
  }
  if (RESERVED_FORM_IDENTIFIERS.has(value)) return `uses reserved key "${value}"`
  return null
}

/**
 * Collect cross-field invariants a single nested zod node cannot express.
 * Powers both canonical parsing (`parseFormSchema`) and designer lint output
 * (`lintFormSchema`) so the two boundaries cannot drift.
 */
export function lintFormSchema(schema: FormSchemaV1): SchemaIssue[] {
  const issues: SchemaIssue[] = []

  function recordDuplicate(
    seen: Map<string, Array<string | number>>,
    value: string,
    path: Array<string | number>,
    label: string,
  ) {
    const firstPath = seen.get(value)
    if (firstPath) {
      issues.push({
        path,
        message: `Duplicate ${label} "${value}"; first declared at ${pathLabel(firstPath)}`,
      })
    } else {
      seen.set(value, path)
    }
  }

  const sectionIds = new Map<string, Array<string | number>>()
  const repeatingSectionIds = new Map<string, Array<string | number>>()
  schema.sections.forEach((section, sectionIndex) => {
    if (section.repeating && !repeatingSectionIds.has(section.id)) {
      repeatingSectionIds.set(section.id, ['sections', sectionIndex, 'id'])
    }
  })

  const fieldIds = new Map<string, Array<string | number>>()
  schema.sections.forEach((section, sectionIndex) => {
    const sectionIdPath: Array<string | number> = ['sections', sectionIndex, 'id']
    recordDuplicate(sectionIds, section.id, sectionIdPath, 'section id')
    const invalidSectionId = identifierIssue(section.id)
    if (invalidSectionId) {
      issues.push({ path: sectionIdPath, message: `Section id ${invalidSectionId}` })
    }
    if (
      section.repeating &&
      section.minRows !== undefined &&
      section.maxRows !== undefined &&
      section.minRows > section.maxRows
    ) {
      issues.push({
        path: ['sections', sectionIndex, 'maxRows'],
        message: `Repeating section maxRows (${section.maxRows}) must be greater than or equal to minRows (${section.minRows})`,
      })
    }

    section.fields.forEach((field, fieldIndex) => {
      const fieldBasePath: Array<string | number> = ['sections', sectionIndex, 'fields', fieldIndex]
      const fieldIdPath: Array<string | number> = [...fieldBasePath, 'id']
      recordDuplicate(fieldIds, field.id, fieldIdPath, 'field id')
      const invalidFieldId = identifierIssue(field.id)
      if (invalidFieldId) {
        issues.push({ path: fieldIdPath, message: `Field id ${invalidFieldId}` })
      }
      const repeatingSectionPath = !section.repeating
        ? repeatingSectionIds.get(field.id)
        : undefined
      if (repeatingSectionPath) {
        issues.push({
          path: fieldIdPath,
          message: `Top-level field id "${field.id}" collides with repeating section response key declared at ${pathLabel(repeatingSectionPath)}`,
        })
      }

      const validation = field.validation
      if (validation) {
        if (
          validation.min !== undefined &&
          validation.max !== undefined &&
          validation.min > validation.max
        ) {
          issues.push({
            path: [...fieldBasePath, 'validation', 'max'],
            message: `Validation max (${validation.max}) must be greater than or equal to min (${validation.min})`,
          })
        }
        if (
          validation.minLength !== undefined &&
          validation.maxLength !== undefined &&
          validation.minLength > validation.maxLength
        ) {
          issues.push({
            path: [...fieldBasePath, 'validation', 'maxLength'],
            message: `Validation maxLength (${validation.maxLength}) must be greater than or equal to minLength (${validation.minLength})`,
          })
        }
        if (
          !NUMERIC_VALIDATION_FIELD_TYPES.has(field.type) &&
          (validation.min !== undefined || validation.max !== undefined)
        ) {
          issues.push({
            path: [...fieldBasePath, 'validation'],
            message: `${field.type} fields cannot define numeric min or max validation`,
          })
        }
        if (
          !TEXT_VALIDATION_FIELD_TYPES.has(field.type) &&
          (validation.minLength !== undefined ||
            validation.maxLength !== undefined ||
            validation.pattern !== undefined)
        ) {
          issues.push({
            path: [...fieldBasePath, 'validation'],
            message: `${field.type} fields cannot define text-length or pattern validation`,
          })
        }
        if (!CHOICE_FIELD_TYPES.has(field.type) && validation.options !== undefined) {
          issues.push({
            path: [...fieldBasePath, 'validation', 'options'],
            message: `${field.type} fields cannot define choice options`,
          })
        }
        const hardTextLimit = textValidationHardLimit(field.type)
        if (hardTextLimit !== null) {
          for (const key of ['minLength', 'maxLength'] as const) {
            const v = validation[key]
            if (v !== undefined && v > hardTextLimit) {
              issues.push({
                path: [...fieldBasePath, 'validation', key],
                message: `${field.type} ${key} cannot exceed its ${hardTextLimit}-character response limit`,
              })
            }
          }
        }
        if (validation.pattern) {
          const patternError = validationPatternError(validation.pattern)
          if (patternError) {
            issues.push({
              path: [...fieldBasePath, 'validation', 'pattern'],
              message: `Validation pattern ${patternError}`,
            })
          }
        }
      }

      if (!isResponseValueField(field.type)) {
        if (field.required || field.validation?.required) {
          issues.push({
            path: [...fieldBasePath, 'required'],
            message: `${field.type} does not store a response value and cannot be required`,
          })
        }
        if (field.defaultValue !== undefined) {
          issues.push({
            path: [...fieldBasePath, 'defaultValue'],
            message: `${field.type} does not store a response value and cannot define a default value`,
          })
        }
      }

      if (CHOICE_FIELD_TYPES.has(field.type)) {
        const options = field.validation?.options
        if (!options || options.length === 0) {
          issues.push({
            path: [...fieldBasePath, 'validation', 'options'],
            message: `${field.type} fields require at least one choice option`,
          })
        } else {
          const optionValues = new Map<string, number>()
          options.forEach((option, optionIndex) => {
            if (!option.value.trim() || option.value.length > 500) {
              issues.push({
                path: [...fieldBasePath, 'validation', 'options', optionIndex, 'value'],
                message: 'Choice option values must contain 1 to 500 characters',
              })
            }
            const first = optionValues.get(option.value)
            if (first !== undefined) {
              issues.push({
                path: [...fieldBasePath, 'validation', 'options', optionIndex, 'value'],
                message: `Duplicate choice option value "${option.value}"; first declared at validation.options[${first}].value`,
              })
            } else {
              optionValues.set(option.value, optionIndex)
            }
          })
        }
      }

      if (field.type === 'number' || field.type === 'currency' || field.type === 'percentage') {
        const config = field.config ?? {}
        for (const key of ['min', 'max', 'step'] as const) {
          const value = config[key]
          if (
            value !== undefined &&
            (typeof value !== 'number' ||
              !Number.isFinite(value) ||
              Math.abs(value) > MAX_NUMERIC_FIELD_CONFIG)
          ) {
            issues.push({
              path: [...fieldBasePath, 'config', key],
              message: `${field.type} ${key} must be a finite number between -${MAX_NUMERIC_FIELD_CONFIG} and ${MAX_NUMERIC_FIELD_CONFIG}`,
            })
          }
        }
        if (typeof config.step === 'number' && config.step <= 0) {
          issues.push({
            path: [...fieldBasePath, 'config', 'step'],
            message: `${field.type} step must be greater than zero`,
          })
        }
        if (
          typeof config.min === 'number' &&
          typeof config.max === 'number' &&
          config.min >= config.max
        ) {
          issues.push({
            path: [...fieldBasePath, 'config', 'max'],
            message: `${field.type} max (${config.max}) must be greater than min (${config.min})`,
          })
        }
        if (
          config.unit !== undefined &&
          (typeof config.unit !== 'string' || config.unit.length > 50)
        ) {
          issues.push({
            path: [...fieldBasePath, 'config', 'unit'],
            message: `${field.type} unit must be text no longer than 50 characters`,
          })
        }
      }

      if (field.type === 'rating') {
        const configuredMax = field.config?.max
        if (
          configuredMax !== undefined &&
          (typeof configuredMax !== 'number' ||
            !Number.isInteger(configuredMax) ||
            configuredMax < 1 ||
            configuredMax > 10)
        ) {
          issues.push({
            path: [...fieldBasePath, 'config', 'max'],
            message: 'Rating max must be an integer from 1 to 10',
          })
        }
        const max =
          typeof configuredMax === 'number' && Number.isInteger(configuredMax) ? configuredMax : 5
        for (const key of ['min', 'max'] as const) {
          const value = field.validation?.[key]
          if (value === undefined) continue
          if (!Number.isInteger(value)) {
            issues.push({
              path: [...fieldBasePath, 'validation', key],
              message: `Rating validation ${key} must be a whole number`,
            })
          } else if (value < 1 || value > max) {
            issues.push({
              path: [...fieldBasePath, 'validation', key],
              message: `Rating validation ${key} must be between 1 and the ${max}-point scale`,
            })
          }
        }
      }

      if (
        field.type === 'signature' &&
        field.config?.statement !== undefined &&
        (typeof field.config.statement !== 'string' || field.config.statement.length > 2_000)
      ) {
        issues.push({
          path: [...fieldBasePath, 'config', 'statement'],
          message: 'Signature statement must be text no longer than 2,000 characters',
        })
      }

      if (field.type === 'party') {
        const partyKind = field.config?.partyKind
        if (
          partyKind !== undefined &&
          !(PARTY_PICKER_KINDS as readonly string[]).includes(partyKind as string)
        ) {
          issues.push({
            path: [...fieldBasePath, 'config', 'partyKind'],
            message: `Party picker kind must be one of ${PARTY_PICKER_KINDS.join(', ')}`,
          })
        }
      }

      if (field.type === 'formula') {
        if (!field.formula) {
          issues.push({
            path: [...fieldBasePath, 'formula'],
            message: 'Formula fields require a formula expression',
          })
        }
        const format = field.config?.format
        if (
          format !== undefined &&
          !['number', 'currency', 'percentage', 'text'].includes(format as string)
        ) {
          issues.push({
            path: [...fieldBasePath, 'config', 'format'],
            message: 'Formula format must be number, currency, percentage, or text',
          })
        }
      } else if (field.formula !== undefined) {
        issues.push({
          path: [...fieldBasePath, 'formula'],
          message: 'Only formula fields may define a formula expression',
        })
      }
    })
  })

  // --- Reference validation (showIf + formula) -------------------------------
  //
  // Evaluation contexts: a top-level field sees all top-level value fields; a
  // field inside a repeating section additionally sees its sibling row fields.
  // Formula rollup operators (`sum_section` etc.) may reference any repeating
  // section + its row fields from anywhere.
  const topLevelValueIds = new Set<string>()
  for (const section of schema.sections) {
    if (section.repeating) continue
    for (const field of section.fields) {
      if (isResponseValueField(field.type) || field.type === 'formula') {
        topLevelValueIds.add(field.id)
      }
    }
  }
  const repeatingRowFields = new Map<string, Set<string>>()
  for (const section of schema.sections) {
    if (!section.repeating) continue
    const rowFields = new Set<string>()
    for (const field of section.fields) {
      if (isResponseValueField(field.type) || field.type === 'formula') rowFields.add(field.id)
    }
    repeatingRowFields.set(section.id, rowFields)
  }

  const allowedFieldsForSection = (section: FormSection): Set<string> => {
    const allowed = new Set(topLevelValueIds)
    if (section.repeating) {
      for (const id of repeatingRowFields.get(section.id) ?? []) allowed.add(id)
    }
    return allowed
  }

  const validateRuleReferences = (
    rule: LogicRule,
    allowed: ReadonlySet<string>,
    path: Array<string | number>,
    ownerFieldId: string | undefined,
    contextLabel: string,
  ) => {
    const stack: Array<{ rule: LogicRule; depth: number }> = [{ rule, depth: 1 }]
    let nodeCount = 0
    while (stack.length > 0) {
      const current = stack.pop()!
      nodeCount += 1
      if (nodeCount > 500) {
        issues.push({ path, message: `${contextLabel} supports no more than 500 rule nodes` })
        return
      }
      if (current.depth > 32) {
        issues.push({ path, message: `${contextLabel} may not be nested more than 32 levels` })
        continue
      }
      if ('rules' in current.rule) {
        for (const child of current.rule.rules) {
          stack.push({ rule: child, depth: current.depth + 1 })
        }
        continue
      }
      if ('rule' in current.rule) {
        stack.push({ rule: current.rule.rule, depth: current.depth + 1 })
        continue
      }
      const referencedId = current.rule.field
      if (!fieldIds.has(referencedId)) {
        issues.push({ path, message: `${contextLabel} references unknown field "${referencedId}"` })
      } else if (!allowed.has(referencedId)) {
        issues.push({
          path,
          message: `${contextLabel} references field "${referencedId}" outside its evaluation context`,
        })
      } else if (referencedId === ownerFieldId) {
        issues.push({ path, message: `${contextLabel} cannot reference its own field` })
      }
    }
  }

  const validateFormulaReferences = (
    formula: FormulaExpression,
    allowed: ReadonlySet<string>,
    path: Array<string | number>,
    ownerFieldId: string,
  ) => {
    const stack: Array<{ expr: FormulaExpression; depth: number }> = [
      { expr: formula, depth: 1 },
    ]
    let nodeCount = 0
    while (stack.length > 0) {
      const current = stack.pop()!
      nodeCount += 1
      if (nodeCount > 500) {
        issues.push({ path, message: 'Formula supports no more than 500 nodes' })
        return
      }
      if (current.depth > 32) {
        issues.push({ path, message: 'Formula may not be nested more than 32 levels' })
        continue
      }
      const expr = current.expr
      const nextDepth = current.depth + 1
      switch (expr.kind) {
        case 'literal':
          break
        case 'field_ref': {
          if (!fieldIds.has(expr.fieldKey)) {
            issues.push({
              path,
              message: `Formula references unknown field "${expr.fieldKey}"`,
            })
          } else if (!allowed.has(expr.fieldKey)) {
            issues.push({
              path,
              message: `Formula references field "${expr.fieldKey}" outside its evaluation context`,
            })
          } else if (expr.fieldKey === ownerFieldId) {
            issues.push({ path, message: 'Formula cannot reference its own field' })
          }
          break
        }
        case 'sum':
        case 'product':
        case 'min':
        case 'max':
        case 'concat':
          for (const child of expr.of) stack.push({ expr: child, depth: nextDepth })
          break
        case 'subtract':
        case 'divide':
          stack.push({ expr: expr.left, depth: nextDepth })
          stack.push({ expr: expr.right, depth: nextDepth })
          break
        case 'power':
          stack.push({ expr: expr.base, depth: nextDepth })
          stack.push({ expr: expr.exponent, depth: nextDepth })
          break
        case 'root':
          stack.push({ expr: expr.of, depth: nextDepth })
          stack.push({ expr: expr.degree, depth: nextDepth })
          break
        case 'abs':
        case 'round':
        case 'floor':
        case 'ceil':
          stack.push({ expr: expr.of, depth: nextDepth })
          break
        case 'count_section':
        case 'sum_section':
        case 'avg_section':
        case 'min_section':
        case 'max_section': {
          const rowFields = repeatingRowFields.get(expr.sectionKey)
          if (!rowFields) {
            issues.push({
              path,
              message: `Formula rollup references unknown repeating section "${expr.sectionKey}"`,
            })
          } else if (
            expr.kind !== 'count_section' &&
            !rowFields.has(expr.rowFieldKey)
          ) {
            issues.push({
              path,
              message: `Formula rollup references unknown row field "${expr.rowFieldKey}" in section "${expr.sectionKey}"`,
            })
          }
          break
        }
        case 'if':
          validateRuleReferences(expr.condition, allowed, path, ownerFieldId, 'Formula condition')
          stack.push({ expr: expr.then, depth: nextDepth })
          stack.push({ expr: expr.else, depth: nextDepth })
          break
      }
    }
  }

  schema.sections.forEach((section, sectionIndex) => {
    const allowed = allowedFieldsForSection(section)
    if (section.showIf) {
      // Section visibility can only depend on top-level fields.
      validateRuleReferences(
        section.showIf,
        topLevelValueIds,
        ['sections', sectionIndex, 'showIf'],
        undefined,
        'Section showIf',
      )
    }
    section.fields.forEach((field, fieldIndex) => {
      const basePath: Array<string | number> = ['sections', sectionIndex, 'fields', fieldIndex]
      if (field.showIf) {
        validateRuleReferences(field.showIf, allowed, [...basePath, 'showIf'], field.id, 'showIf')
      }
      if (field.formula) {
        validateFormulaReferences(field.formula, allowed, [...basePath, 'formula'], field.id)
      }
      if (field.defaultValue?.kind === 'expression') {
        validateFormulaReferences(
          field.defaultValue.expr,
          allowed,
          [...basePath, 'defaultValue', 'expr'],
          field.id,
        )
      }
    })
  })

  return issues
}

/** Full form schema validator: zod structure + cross-field invariants. */
export const formSchemaV1Schema = formSchemaV1Base.superRefine((schema, ctx) => {
  for (const issue of lintFormSchema(schema)) {
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
  }
})

export type ParseFormSchemaResult =
  | { success: true; data: FormSchemaV1 }
  | { success: false; issues: SchemaIssue[] }

/** Parse + validate an untrusted candidate form schema (e.g. an API body). */
export function parseFormSchema(input: unknown): ParseFormSchemaResult {
  const parsed = formSchemaV1Schema.safeParse(input)
  if (parsed.success) return { success: true, data: parsed.data }
  return {
    success: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.filter(
        (part): part is string | number => typeof part === 'string' || typeof part === 'number',
      ),
      message: issue.message,
    })),
  }
}

/** A minimal valid schema for a freshly created template. */
export function emptyFormSchema(title: string): FormSchemaV1 {
  return {
    schemaVersion: 1,
    title,
    sections: [{ id: 'main', title: 'Details', fields: [] }],
  }
}
