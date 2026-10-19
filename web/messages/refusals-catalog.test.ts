// source-pin-contract: catalog-backed refusals — every engine refusal entry renders from every locale catalog; subjects derived from the engine registries, never hand-listed
import assert from 'node:assert/strict'
import test from 'node:test'
import { createTranslator } from 'next-intl'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import type { RefusalValue, RefusalValueKind } from '@openbooks/engine/platform/catalog-refusal'
import { EQUITY_REFUSALS, EQUITY_TERMS } from '@openbooks/engine/equity'
import { LOCALE_CODES } from '../i18n/config.ts'
import { renderCatalogRefusal, type CatalogTranslator } from '../lib/refusal-catalog.ts'
import de from './de/index.ts'
import en from './en/index.ts'
import es from './es/index.ts'
import fr from './fr/index.ts'
import ja from './ja/index.ts'
import ptBR from './pt-BR/index.ts'
import zh from './zh/index.ts'

/**
 * Catalog-backed refusals render their message and remedy from
 * `refusals.<module>.<key>` in the reader's catalog. The engine registry is
 * the authority for which entries exist, their figures and their English
 * text; every locale must carry every entry, render it with any figures,
 * and read in its own language.
 */

type Tree = Record<string, unknown>
const CATALOGS: Record<string, Tree> = { en, de, es, fr, ja, 'pt-BR': ptBR, zh }

function leaf(tree: Tree, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Tree)[part] : undefined), tree)
}

function translator(locale: string): CatalogTranslator {
  return createTranslator({ locale, messages: CATALOGS[locale]!, onError: (error) => { throw error } }) as unknown as CatalogTranslator
}

/** A figure of each kind, at a value that exercises plural selection. */
function sample(kind: RefusalValueKind, plural: 'one' | 'other'): RefusalValue {
  switch (kind) {
    case 'shares': return { kind, value: plural === 'one' ? 1n : 12500n }
    case 'count': return { kind, value: plural === 'one' ? 1 : 12 }
    case 'money': return { kind, value: '73815000.5', currency: 'EUR' }
    case 'price': return { kind, value: '3.5', currency: 'EUR' }
    case 'decimal': return { kind, value: '1.25' }
    case 'multiple': return { kind, value: '0.5' }
    case 'percent': return { kind, value: '12.5' }
    case 'date': return { kind, value: '2026-12-31' }
    case 'period': return { kind, label: 'P12 FY2026', startsOn: '2026-12-01', endsOn: '2026-12-31' }
    case 'text': return { kind, value: 'SAFE-0003' }
    case 'list': return { kind, value: ['SAFE-0003', 'QAA2-0004'] }
    case 'choice': return { kind, value: 'unlisted-choice' }
    case 'term': return { kind, key: EQUITY_TERMS.preMoneyBasisReason.key, text: EQUITY_TERMS.preMoneyBasisReason.text }
  }
}

function render(locale: string, key: string, plural: 'one' | 'other', overrides: Record<string, RefusalValue> = {}) {
  const spec = EQUITY_REFUSALS[key as keyof typeof EQUITY_REFUSALS]
  const params: Readonly<Record<string, RefusalValueKind>> = 'params' in spec ? spec.params : {}
  const values = { ...Object.fromEntries(Object.entries(params).map(([name, kind]) => [name, sample(kind, plural)])), ...overrides }
  return renderCatalogRefusal({ code: spec.code, catalogKey: `equity.${key}`, values, message: spec.message, remedy: spec.remedy }, translator(locale), locale)
}

test('every equity refusal has its message and remedy in every shipped locale', () => {
  const missing: string[] = []
  for (const locale of LOCALE_CODES) {
    for (const key of Object.keys(EQUITY_REFUSALS)) {
      for (const part of ['message', 'remedy']) {
        const value = leaf(CATALOGS[locale]!, `refusals.equity.${key}.${part}`)
        if (typeof value !== 'string' || value.trim() === '') missing.push(`${locale}: refusals.equity.${key}.${part}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})

test('the English catalog carries the engine text of every entry, and nothing the engine does not raise', () => {
  const catalog = (leaf(en, 'refusals.equity') ?? {}) as Tree
  const drift: string[] = []
  for (const [key, spec] of Object.entries(EQUITY_REFUSALS)) {
    const entry = catalog[key] as { message?: string; remedy?: string } | undefined
    if (entry?.message !== spec.message) drift.push(`${key}.message: ${JSON.stringify(spec.message)}`)
    if (entry?.remedy !== spec.remedy) drift.push(`${key}.remedy: ${JSON.stringify(spec.remedy)}`)
  }
  for (const key of Object.keys(catalog)) if (key !== 'terms' && !(key in EQUITY_REFUSALS)) drift.push(`${key} is in the catalog but no refusal raises it`)
  assert.deepEqual(drift, [], 'copy the engine text into web/messages/en/refusals.json')
})

test('every term a refusal names resolves in every locale, and reads in English as the engine writes it', () => {
  const offenders: string[] = []
  for (const [name, term] of Object.entries(EQUITY_TERMS)) {
    if (leaf(en, term.key) !== term.text) offenders.push(`${name}: en ${term.key} is ${JSON.stringify(leaf(en, term.key))}, engine says ${JSON.stringify(term.text)}`)
    for (const locale of LOCALE_CODES) {
      const value = leaf(CATALOGS[locale]!, term.key)
      if (typeof value !== 'string' || value.trim() === '') offenders.push(`${locale}: ${term.key} is missing`)
    }
  }
  const terms = (leaf(en, 'refusals.equity.terms') ?? {}) as Tree
  for (const key of Object.keys(terms)) if (!Object.values(EQUITY_TERMS).some((term) => term.key === `refusals.equity.terms.${key}`)) offenders.push(`refusals.equity.terms.${key} is not an engine term`)
  assert.deepEqual(offenders, [])
})

test('every entry renders in every locale with any figures, leaving no argument unfilled', () => {
  const offenders: string[] = []
  for (const locale of LOCALE_CODES) {
    for (const key of Object.keys(EQUITY_REFUSALS)) {
      for (const plural of ['one', 'other'] as const) {
        try {
          const text = render(locale, key, plural)
          if (/[{}]/.test(text.message) || /[{}]/.test(text.remedy)) offenders.push(`${locale}:${key} leaves an argument unfilled`)
        } catch (error) {
          offenders.push(`${locale}:${key} does not render: ${(error as Error).message}`)
        }
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('translated templates keep argument identities and only select on declared figures', () => {
  const offenders: string[] = []
  const visit = (elements: readonly MessageFormatElement[], names: Set<string>) => {
    for (const element of elements) {
      if (element.type === TYPE.literal) continue
      if (element.type === TYPE.argument) names.add(element.value)
      else if (element.type === TYPE.plural || element.type === TYPE.select) {
        names.add(element.value)
        for (const branch of Object.values(element.options)) visit(branch.value, names)
      } else offenders.push('translated refusals use only literals, arguments, plurals and selects')
    }
  }
  for (const locale of LOCALE_CODES) {
    for (const [key, spec] of Object.entries(EQUITY_REFUSALS)) {
      const params: Readonly<Record<string, RefusalValueKind>> = 'params' in spec ? spec.params : {}
      const allowed = new Set(Object.keys(params))
      for (const [name, kind] of Object.entries(params)) if (kind === 'count' || kind === 'shares') allowed.add(`${name}Count`)
      for (const part of ['message', 'remedy'] as const) {
        const template = leaf(CATALOGS[locale]!, `refusals.equity.${key}.${part}`)
        if (typeof template !== 'string') continue
        try {
          const names = new Set<string>()
          visit(parse(template), names)
          for (const name of names) if (!allowed.has(name)) offenders.push(`${locale}:${key}.${part} has unknown argument ${name}`)
        } catch (error) {
          offenders.push(`${locale}:${key}.${part}: ${(error as Error).message}`)
        }
      }
    }
  }
  assert.deepEqual(offenders, [])
})

/** Words that only appear in an English sentence. */
const ENGLISH = /(?<![\p{L}\p{M}\p{N}_])(the|and|is|are|was|has|have|not|through|before|after|enter|choose|record|review|period|shares?|units?|run|which|ends|today|valuation|price)(?![\p{L}\p{M}\p{N}_])/iu

test('English prose detection respects accented letters and still catches English words', () => {
  assert.equal(ENGLISH.test('Une unité est acquise ; les unités sont acquises.'), false)
  assert.equal(ENGLISH.test('Eine Einheit ist unverfallbar.'), false)
  assert.equal(ENGLISH.test('Le the\u0301 est chaud.'), false)
  assert.equal(ENGLISH.test('Only one unit is vested.'), true)
  assert.equal(ENGLISH.test('Enter the quantity.'), true)
})

test('financial terminology distinguishes shares and SAFE instruments from ordinary nouns', () => {
  for (const locale of ['de', 'fr', 'es', 'pt-BR', 'ja', 'zh']) {
    assert.match(render(locale, 'safeUnknown', 'one').message, /SAFE/, locale)
  }
  const conversion = render('fr', 'conversionBelowOneCommon', 'one')
  assert.match(conversion.message, /action ordinaire/)
  assert.match(conversion.remedy, /actions/)
  assert.doesNotMatch(conversion.message + conversion.remedy, /partage/)
  assert.match(render('fr', 'issuanceQuantityNotPositive', 'one').message, /au moins une action/)
})

test('French exercise quantities put the number before the correctly inflected unit', () => {
  assert.match(render('fr', 'exerciseExceedsVested', 'one').remedy, /1 unité(?:[ ;.])/)
  const many = render('fr', 'exerciseExceedsVested', 'other').remedy.normalize('NFKC')
  assert.match(many, /12 500 unités(?:[ ;.])/)
})

test('refusals read in the reader language: no English sentence reaches a German, French or Japanese reader', () => {
  const representative = [
    'runPeriodNotEnded', 'runPeriodClosed', 'compensationRunBackdated', 'interestNothingDueSince', 'periodMissing',
    'exerciseExceedsVested', 'nothingVestedYet', 'preMoneyInconsistentPriceLocked', 'preMoneyBasisTooShort', 'authorizedExceeded',
    'reasonRequired', 'dateInvalid', 'decimalPrecision', 'accountPolicyMissing', 'conversionTermsVoid', 'mfnBackdated',
  ].filter((key) => key in EQUITY_REFUSALS)
  assert.ok(representative.length >= 14, 'the representative refusals exist in the registry')
  const offenders: string[] = []
  for (const locale of ['de', 'fr', 'ja']) {
    for (const key of representative) {
      for (const plural of ['one', 'other'] as const) {
        const { message, remedy } = render(locale, key, plural)
        // Figures (security numbers, period labels) are recorded text, not prose.
        const prose = `${message} ${remedy}`.replace(/SAFE-0003|QAA2-0004|P12 FY2026|SAFE/g, '')
        const english = prose.match(ENGLISH)
        if (english) offenders.push(`${locale}:${key} reads "${english[0]}": ${prose}`)
        if (locale === 'ja' && /[A-Za-z]{4,}/.test(prose.replace(/\b(MFN|Period Close|FY\d+)\b/g, ''))) offenders.push(`${locale}:${key} carries Latin prose: ${prose}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('share counts take the plural form the number needs, in the reader language', () => {
  const one = render('de', 'exerciseExceedsVested', 'one', { event: { kind: 'choice', value: 'exercise' } }).message
  const many = render('de', 'exerciseExceedsVested', 'other', { event: { kind: 'choice', value: 'exercise' } }).message
  assert.match(one, /\b1 Einheit\b/)
  assert.match(many, /12\.500 Einheiten/)
  assert.match(render('en', 'exerciseExceedsVested', 'one').message, /\b1 unit is\b/)
})
