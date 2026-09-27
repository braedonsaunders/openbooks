import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { CONTROL_ACCOUNT_ROLES } from '@openbooks/engine/src/records/control-accounts.ts'

const messages = new URL('../messages/', import.meta.url)
for (const locale of readdirSync(messages, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
  test(`${locale.name}: every control account role has exactly a label and hint`, () => {
    const catalog = JSON.parse(readFileSync(new URL(`${locale.name}/admin.json`, messages), 'utf8'))
    for (const role of CONTROL_ACCOUNT_ROLES) {
      const path = `${locale.name}: settings.controlAccounts.fields.${role}`
      const field = catalog.settings?.controlAccounts?.fields?.[role]
      assert.ok(field && typeof field === 'object', `${path} must exist`)
      assert.deepEqual(Object.keys(field).sort(), ['hint', 'label'], `${path} must hold only label and hint`)
      for (const key of ['label', 'hint']) {
        assert.equal(typeof field[key], 'string', `${path}.${key} must be a string`)
        assert.ok(field[key].trim(), `${path}.${key} must not be empty`)
      }
    }
  })
}
