import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PERIOD_PRESETS, PERIOD_PRESET_GROUP_LABELS } from '@openbooks/reports'
import { DEFAULT_SEGMENT_ALL_KEY, isDefaultSegmentName } from './segment-labels.ts'

/**
 * F-t07-009: the filter bar rendered period presets, preset group headings,
 * breakout nouns and "All X" dimension options in English (or mixed) on
 * fr/es/de/ja/pt-BR/zh. Preset/group labels now come from
 * reports.filterBar.periodPresets.* / periodPresetGroups.*, and default
 * built-in segment names resolve to the fully-translated All-X keys while a
 * tenant-renamed segment keeps its verbatim name.
 */
const LOCALES = ['en', 'es', 'fr', 'de', 'ja', 'pt-BR', 'zh'] as const

type FilterBarCatalog = {
  filterBar?: {
    payPeriods?: unknown
    periodPresets?: Record<string, unknown>
    periodPresetGroups?: Record<string, unknown>
  }
}

function filterBar(locale: string): NonNullable<FilterBarCatalog['filterBar']> {
  const catalog = JSON.parse(
    readFileSync(new URL(`../messages/${locale}/reports.json`, import.meta.url), 'utf8'),
  ) as FilterBarCatalog
  assert.ok(catalog.filterBar, `${locale} is missing the reports.filterBar block`)
  return catalog.filterBar
}

test('every period preset has a translated label in every locale', () => {
  assert.ok(PERIOD_PRESETS.length > 0, 'no period presets were loaded — the import broke')
  const missing: string[] = []
  for (const locale of LOCALES) {
    const presets = filterBar(locale).periodPresets ?? {}
    for (const preset of PERIOD_PRESETS) {
      if (typeof presets[preset.id] !== 'string' || !(presets[preset.id] as string).trim()) {
        missing.push(`${locale}:filterBar.periodPresets.${preset.id}`)
      }
    }
  }
  assert.deepEqual(missing, [], `presets with no label:\n${missing.join('\n')}`)
})

test('every preset group has a translated heading in every locale', () => {
  const missing: string[] = []
  for (const locale of LOCALES) {
    const groups = filterBar(locale).periodPresetGroups ?? {}
    for (const group of Object.keys(PERIOD_PRESET_GROUP_LABELS)) {
      if (typeof groups[group] !== 'string' || !(groups[group] as string).trim()) {
        missing.push(`${locale}:filterBar.periodPresetGroups.${group}`)
      }
    }
  }
  assert.deepEqual(missing, [], `preset groups with no heading:\n${missing.join('\n')}`)
})

test('the pay-periods optgroup label exists in every locale', () => {
  for (const locale of LOCALES) {
    const value = filterBar(locale).payPeriods
    assert.ok(typeof value === 'string' && value.trim(), `${locale} is missing filterBar.payPeriods`)
  }
})

test('default built-in segment names are recognized; renames are not', () => {
  assert.equal(
    isDefaultSegmentName({ key: 'project', name: 'Project', pluralName: 'Projects' }),
    true,
  )
  assert.equal(
    isDefaultSegmentName({ key: 'project', name: 'Projet', pluralName: 'Projets' }),
    false,
  )
  assert.equal(
    isDefaultSegmentName({ key: 'project', name: 'Project', pluralName: 'Projets' }),
    false,
  )
  assert.equal(isDefaultSegmentName({ key: 'region', name: 'Region', pluralName: 'Regions' }), false)
  assert.equal(isDefaultSegmentName(undefined), false)
})

test('every default built-in segment maps to a fully-translated All-X key', () => {
  for (const key of ['department', 'project', 'location', 'class']) {
    const allKey = (DEFAULT_SEGMENT_ALL_KEY as Record<string, string>)[key]
    assert.ok(typeof allKey === 'string' && allKey.length > 0, `no All-X key for ${key}`)
    for (const locale of LOCALES) {
      const catalog = JSON.parse(
        readFileSync(new URL(`../messages/${locale}/reports.json`, import.meta.url), 'utf8'),
      ) as FilterBarCatalog
      const value = (catalog.filterBar as Record<string, unknown> | undefined)?.[allKey]
      assert.ok(
        typeof value === 'string' && value.trim(),
        `${locale} is missing filterBar.${allKey}`,
      )
    }
  }
})
