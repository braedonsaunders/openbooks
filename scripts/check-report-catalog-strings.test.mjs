import assert from 'node:assert/strict'
import test from 'node:test'
import { findMissingReportCatalogStrings } from './check-report-catalog-strings.mjs'

const entities = [{
  source: 'fixture',
  entity: { key: 'orders', columns: [{ key: 'total' }] },
}]

test('report catalog string coverage accepts complete catalogs and reports missing locale keys', () => {
  const cases = [
    {
      name: 'complete report labels and headings',
      catalogs: {
        en: { catalog: { entities: { orders: { label: 'Orders', description: 'Order activity' } }, columns: { orders: { total: 'Total' } } } },
      },
      expected: [],
    },
    {
      name: 'blank entity description and missing column heading',
      catalogs: {
        fr: { catalog: { entities: { orders: { label: 'Commandes', description: '  ' } }, columns: { orders: {} } } },
      },
      expected: [
        { locale: 'fr', key: 'catalog.entities.orders.description' },
        { locale: 'fr', key: 'catalog.columns.orders.total' },
      ],
    },
  ]

  for (const { name, catalogs, expected } of cases) {
    assert.deepEqual(findMissingReportCatalogStrings(entities, catalogs), expected, name)
  }
})
