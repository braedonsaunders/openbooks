import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const storeSource = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')
const routeSource = readFileSync(new URL('../../app/api/apps/[key]/route.ts', import.meta.url), 'utf8')

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`)
  assert.notEqual(start, -1, `${name} must remain defined`)
  const end = source.indexOf('\nexport ', start + 1)
  return source.slice(start, end === -1 ? undefined : end)
}

test('setAppStatus and deleteApp return this request\'s affected-row count, not void', () => {
  const setBody = functionBody(storeSource, 'setAppStatus')
  const delBody = functionBody(storeSource, 'deleteApp')
  assert.doesNotMatch(setBody, /Promise<void>/)
  assert.doesNotMatch(delBody, /Promise<void>/)
  assert.match(setBody, /Promise<\{ affectedRows: number \}>/)
  assert.match(delBody, /Promise<\{ affectedRows: number \}>/)
  assert.match(setBody, /return \{ affectedRows: updated\.rows\.length \}/)
  assert.match(delBody, /return \{ affectedRows: updated\.rows\.length \}/)
  assert.match(delBody, /return \{ affectedRows: deleted\.rows\.length \}/)
})

test('setAppStatus throws in-transaction on a missing row, unchanged status, or zero-row UPDATE', () => {
  const body = functionBody(storeSource, 'setAppStatus')
  assert.match(body, /for update/)
  assert.match(body, /if \(!app\) \{/)
  assert.match(body, /throw new AppError\(/)
  assert.match(body, /was not found in this organization/)
  assert.match(body, /app\.status === status/)
  assert.match(body, /is already \$\{status\}/)
  assert.match(body, /status is distinct from \$\{status\}/)
  assert.match(body, /returning id/)
  assert.match(body, /if \(!updated\.rows\.length\)/)
  assert.doesNotMatch(body, /if \(!app \|\| app\.status === status\) return/)
})

test('deleteApp throws in-transaction on a missing row or zero-row uninstall write', () => {
  const body = functionBody(storeSource, 'deleteApp')
  assert.match(body, /for update of a/)
  assert.match(body, /if \(!app\) \{/)
  assert.match(body, /throw new AppError\(/)
  assert.match(body, /was not found in this organization/)
  assert.match(body, /Confirm the key is installed here before uninstalling/)
  assert.match(body, /returning id/)
  assert.match(body, /if \(!updated\.rows\.length\)/)
  assert.match(body, /if \(!deleted\.rows\.length\)/)
  assert.doesNotMatch(body, /if \(!app\) return/)
})

test('PATCH and DELETE report {ok:true} only when this request\'s affectedRows is greater than zero', () => {
  const patch = functionBody(routeSource, 'PATCH')
  const del = functionBody(routeSource, 'DELETE')
  assert.match(patch, /setAppStatus\(gate\.user\.orgId, gate\.user\.id, key, body\.status\)/)
  assert.match(del, /deleteApp\(gate\.user\.orgId, gate\.user\.id, key\)/)
  assert.match(patch, /written\.affectedRows < 1/)
  assert.match(del, /written\.affectedRows < 1/)
  assert.doesNotMatch(patch, /getAppByKey/)
  assert.doesNotMatch(del, /getAppByKey/)
  assert.doesNotMatch(routeSource, /refuseAppWrite/)
})
