import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILT_IN_REPORT_DEFINITIONS, BUILT_IN_REPORT_DEFINITION_MAP } from '@openbooks/reports'

/**
 * UX-12b: hub card copy must fit the card — no mid-word clipping at 1280px.
 *
 * Budgets are derived from the 1280px card width measured in the UX-12
 * persona-lane screenshot (shot-ux12-hub-1280.png): at `lg` the hub is three
 * columns, so a card is ~395px and the text column — after the 40px icon,
 * gaps, padding and the arrow — is ~290px.
 *
 * - Description (12px, two lines): an 89-character description
 *   ("GAAP indirect method … working-capital detail") renders in full on two
 *   lines, while a 95-character one ("Income statement … custom layouts")
 *   clips mid-word ("custo…"). Budget: 90 characters.
 * - Title (14px semibold, one tidy line): "Expense detail by department
 *   (this FY)" at 38 characters already truncates ("(this…"), so titles stay
 *   at or under 36 characters. Titles additionally WRAP (ReportsHub renders
 *   no `truncate`), so the budget keeps new cards to one short line while
 *   wrapping — not clipping — is the safety net.
 *
 * The test reads the real copy sources: the `en` reports messages (static
 * hub cards) and the built-in report registry (definition cards, including
 * the generated workforce definitions). Any new card in either source must
 * fit, in the same turn it is added.
 */

const TITLE_BUDGET = 36
const DESCRIPTION_BUDGET = 90

const reports = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'messages', 'en', 'reports.json'), 'utf8'),
) as {
  hub: {
    cards: Record<string, string>
    customStudio: { title: string; description: string }
    savedViews: string
  }
  builtIns: Record<string, { name: string; description: string }>
}
const analytics = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'messages', 'en', 'analytics.json'), 'utf8'),
) as { trueCost: { title: string; summary: { compositeRate: string } } }

test('UX-12b: every static hub card title and description fits the card', () => {
  const over: string[] = []
  for (const [key, value] of Object.entries(reports.hub.cards)) {
    if (key.endsWith('Title') && value.length > TITLE_BUDGET) over.push(`${key} (${value.length})`)
    if (key.endsWith('Description') && value.length > DESCRIPTION_BUDGET) over.push(`${key} (${value.length})`)
  }
  assert.deepEqual(over, [], `hub card copy over budget:\n${over.join('\n')}`)
})

test('UX-12b: hub chrome copy (studio, saved views, true cost) fits the card', () => {
  assert.ok(
    reports.hub.customStudio.title.length <= TITLE_BUDGET,
    `custom studio title (${reports.hub.customStudio.title.length}) must stay under ${TITLE_BUDGET}`,
  )
  assert.ok(
    reports.hub.customStudio.description.length <= DESCRIPTION_BUDGET,
    `custom studio description (${reports.hub.customStudio.description.length}) must stay under ${DESCRIPTION_BUDGET}`,
  )
  assert.ok(
    reports.hub.savedViews.length <= DESCRIPTION_BUDGET,
    `saved-views description (${reports.hub.savedViews.length}) must stay under ${DESCRIPTION_BUDGET}`,
  )
  assert.ok(
    analytics.trueCost.title.length <= TITLE_BUDGET,
    `true-cost title (${analytics.trueCost.title.length}) must stay under ${TITLE_BUDGET}`,
  )
  assert.ok(
    analytics.trueCost.summary.compositeRate.length <= DESCRIPTION_BUDGET,
    `true-cost description (${analytics.trueCost.summary.compositeRate.length}) must stay under ${DESCRIPTION_BUDGET}`,
  )
})

test('UX-12b: every built-in registry name and description fits the card', () => {
  const over: string[] = []
  for (const definition of BUILT_IN_REPORT_DEFINITIONS) {
    if (definition.name.length > TITLE_BUDGET) over.push(`${definition.slug} name (${definition.name.length})`)
    if (definition.description.length > DESCRIPTION_BUDGET) {
      over.push(`${definition.slug} description (${definition.description.length})`)
    }
  }
  assert.deepEqual(over, [], `registry copy over budget:\n${over.join('\n')}`)
})

test('UX-12b: localized built-ins say the same thing as the registry', () => {
  // The hub renders the registry name/description while the custom list and
  // the runner prefer the `builtIns.<slug>` message — a card must not promise
  // one thing on the hub and another on its own page.
  const drift: string[] = []
  for (const [slug, entry] of Object.entries(reports.builtIns)) {
    const definition = BUILT_IN_REPORT_DEFINITION_MAP[slug]
    assert.ok(definition, `builtIns message ${slug} has no registry definition`)
    if (definition.name !== entry.name) drift.push(`${slug} name`)
    if (definition.description !== entry.description) drift.push(`${slug} description`)
  }
  assert.deepEqual(drift, [], `builtIns messages drifted from the registry:\n${drift.join('\n')}`)
})

test('UX-12b: every localized built-in name and description fits the card', () => {
  const over: string[] = []
  for (const [slug, entry] of Object.entries(reports.builtIns)) {
    if (entry.name.length > TITLE_BUDGET) over.push(`${slug} name (${entry.name.length})`)
    if (entry.description.length > DESCRIPTION_BUDGET) over.push(`${slug} description (${entry.description.length})`)
  }
  assert.deepEqual(over, [], `builtIns message copy over budget:\n${over.join('\n')}`)
})
