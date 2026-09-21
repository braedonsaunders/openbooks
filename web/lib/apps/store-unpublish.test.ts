import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const storeSource = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')
const routeSource = readFileSync(
  new URL('../../app/api/apps/marketplace/route.ts', import.meta.url),
  'utf8',
)

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`)
  assert.notEqual(start, -1, `${name} must remain defined`)
  const end = source.indexOf('\nexport ', start + 1)
  return source.slice(start, end === -1 ? undefined : end)
}

test('unpublishApp fail-closes on an already-inactive listing under FOR UPDATE', () => {
  const body = functionBody(storeSource, 'unpublishApp')
  assert.match(body, /for update/)
  assert.doesNotMatch(
    body,
    /if \(!listing\.is_active\) return/,
    'an inactive locked listing must not no-op',
  )
  assert.match(
    body,
    /if \(!listing\.is_active\) throw new AppError\(/,
    'the lock holder must throw when it observes inactive',
  )
  assert.match(body, /already unpublished/)
  assert.match(
    body,
    /update app_listings set is_active=false[\s\S]*and is_active=true[\s\S]*returning id/,
    'the UPDATE must require is_active=true and return the withdrawn row',
  )
  assert.match(
    body,
    /if \(!withdrawn\) throw new AppError\(/,
    'a zero-row withdrawal is a failure, not {ok:true}',
  )
})

test('marketplace unpublish reports {ok:true} only after unpublishApp returns', () => {
  const start = routeSource.indexOf("body.action === 'unpublish'")
  assert.notEqual(start, -1)
  const success = routeSource.indexOf('return NextResponse.json({ ok: true })', start)
  assert.notEqual(success, -1)
  const block = routeSource.slice(start, success)
  assert.match(block, /await unpublishApp\(/)
  assert.match(
    routeSource,
    /error instanceof AppError/,
    'AppError from the locked helper must become the JSON refusal',
  )
})
