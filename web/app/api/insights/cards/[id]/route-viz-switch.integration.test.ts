import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../../lib/auth'

// A Bar -> Table switch in the card studio must persist: the debounced
// autosave PATCHes { vizType: 'table' } while the bar-only viz settings
// (category axis, stacked, …) stay in viz_settings, and the server must
// accept that combination — a table renders every column and ignores
// chart-only keys. A refusal here would surface as the generic
// "Autosave failed" toast with the edit lost on reload.
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __insightCardVizSwitchSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__insightCardVizSwitchSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})

const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET, PATCH } = await import('./route')

function signIn(orgId: string, actor: string): void {
  session.user = { id: actor, orgId, name: 'Viz switch', email: 'viz-switch@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor }
}

const QUERY = {
  source: 'ledger_lines',
  measures: [{ agg: 'sum', field: 'amount' }],
  dimensions: [{ field: 'posting_date', bin: 'month' }],
  filters: [],
}

function patchRequest(id: string, body: unknown): Request {
  return new Request(`http://cards.local/api/insights/cards/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('a Bar-to-Table autosave persists the table viz with bar leftovers intact', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Viz switch', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    const cardId = randomUUID()
    await db.execute(sql`insert into insight_cards (id, org_id, name, status, viz_type, created_by, updated_by)
      values (${cardId}, ${org.orgId}, ${'Viz switch card'}, ${'draft'}, ${'bar'}, ${actor}, ${actor})`)
    signIn(org.orgId, actor)

    await withOrgContext(org.orgId, async () => {
      const params = { params: Promise.resolve({ id: cardId }) }
      const before = await (await GET(new Request(`http://cards.local/api/insights/cards/${cardId}`), params)).json() as { updated_at: string }
      assert.match(before.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)

      // The exact PATCH CardStudio's debounced autosave sends after the
      // picker calls setVizType('table'): only the type changes, the
      // bar-only settings ride along untouched.
      const response = await PATCH(patchRequest(cardId, {
        name: 'Viz switch card',
        description: null,
        query: QUERY,
        vizType: 'table',
        vizSettings: { categoryField: 'posting_date_month', valueFields: ['amount_sum'], stacked: true, showValues: true },
        expectedUpdatedAt: before.updated_at,
      }), params)
      assert.equal(response.status, 200, await response.clone().text())
      const saved = await response.json() as { viz_type: string; viz_settings: Record<string, unknown>; updated_at: unknown }
      assert.equal(saved.viz_type, 'table')
      assert.equal(typeof saved.updated_at, 'string', 'the next autosave needs a revision token to send')

      const after = await (await GET(new Request(`http://cards.local/api/insights/cards/${cardId}`), params)).json() as {
        viz_type: string
        viz_settings: Record<string, unknown>
        updated_at: string
      }
      assert.equal(after.viz_type, 'table', 'a reload must still show Table, not revert to Bar')
      assert.deepEqual(after.viz_settings, { categoryField: 'posting_date_month', valueFields: ['amount_sum'], stacked: true, showValues: true })
      assert.notEqual(after.updated_at, before.updated_at, 'the save must advance the revision')
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('a stale revision is refused, never a 200, leaving the row untouched', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Stale revision', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    const cardId = randomUUID()
    await db.execute(sql`insert into insight_cards (id, org_id, name, status, viz_type, created_by, updated_by)
      values (${cardId}, ${org.orgId}, ${'Stale card'}, ${'draft'}, ${'bar'}, ${actor}, ${actor})`)
    signIn(org.orgId, actor)

    await withOrgContext(org.orgId, async () => {
      const params = { params: Promise.resolve({ id: cardId }) }
      const get = () => GET(new Request(`http://cards.local/api/insights/cards/${cardId}`), params)
      const before = await (await get()).json() as { updated_at: string }

      // The current save commits Table and advances the revision…
      const current = await PATCH(patchRequest(cardId, {
        name: 'Stale card',
        description: null,
        query: QUERY,
        vizType: 'table',
        vizSettings: {},
        expectedUpdatedAt: before.updated_at,
      }), params)
      assert.equal(current.status, 200, await current.clone().text())
      const committed = await current.json() as { updated_at: string }

      // …so a retry still carrying the older token is a conflict, not a 200
      // that silently restores Bar over the committed Table.
      const stale = await PATCH(patchRequest(cardId, {
        name: 'Stale card',
        description: null,
        query: QUERY,
        vizType: 'bar',
        vizSettings: {},
        expectedUpdatedAt: before.updated_at,
      }), params)
      assert.equal(stale.status, 409, await stale.clone().text())
      assert.deepEqual(await stale.json(), {
        error: 'this card changed after you opened it; reload and review the latest revision',
      })

      const after = await (await get()).json() as { viz_type: string; updated_at: string }
      assert.equal(after.viz_type, 'table', 'the refused write must not restore the older chart type')
      assert.equal(after.updated_at, committed.updated_at, 'the refused write must not move the revision')
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
