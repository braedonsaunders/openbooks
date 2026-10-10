import assert from 'node:assert/strict'
import test from 'node:test'
import { searchIndustries } from './industry-search'

// The real English catalog: the synonyms are product copy, so the test reads
// what operators read rather than a hand-written fixture.
const wizard = (await import('../../../../../messages/en/admin.json', { with: { type: 'json' } }))
  .default.setup.wizard as { industries: Record<string, { title: string; description: string; keywords: string }> }
const KEYS = Object.keys(wizard.industries)
const INDUSTRIES = KEYS.map((key) => ({ key }))
const copy = (key: string) => wizard.industries[key]!
const find = (query: string) => searchIndustries(INDUSTRIES, query, copy).map((industry) => industry.key)

test('every industry carries localized search keywords', () => {
  for (const key of KEYS) assert.ok(copy(key).keywords.trim(), `${key} needs keywords`)
})

test('everyday business words reach the nearest templates', () => {
  assert.ok(find('retail').includes('wholesale_distribution'))
  assert.ok(find('retail').includes('general_business'))
  assert.ok(find('restaurant').includes('general_business'))
  assert.ok(find('e-commerce').includes('wholesale_distribution'))
  assert.ok(find('beverage').includes('manufacturing'))
  assert.ok(find('food').includes('manufacturing'))
  assert.ok(find('food').includes('wholesale_distribution'))
})

test('accents and case fold, so cafe finds café', () => {
  assert.deepEqual(find('CAFE'), find('café'))
  assert.ok(find('cafe').includes('general_business'))
})

test('a coffee roaster with wholesale, café and online sales finds more than Manufacturing', () => {
  const coffee = find('coffee')
  for (const key of ['manufacturing', 'wholesale_distribution', 'general_business']) {
    assert.ok(coffee.includes(key), `coffee should reach ${key}`)
  }
  assert.deepEqual(find('coffee roaster'), ['manufacturing'])
})

test('presets named by their own copy lead; keyword matches follow; a blank query keeps registry order', () => {
  const results = find('manufacturing')
  assert.equal(results[0], 'manufacturing')
  assert.deepEqual(find('   '), KEYS)
  assert.deepEqual(find('zzzz-no-such-business'), [])
})
