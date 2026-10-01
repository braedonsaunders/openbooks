import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '../platform/db.ts'
import { DB, setupHarness, withHarness, seedEmployment } from '../testing/hrm-harness.ts'
import { loadDirectory } from './org-chart.ts'
import { loadOrgChartWorkspace, saveOrgChartLayout } from './org-chart-layout.ts'
const spec = { features: ['hrm'], users: [
  { key: 'editor', name: 'Chart editor', handle: 'chart_editor', permissions: ['hrm.employment.read', 'hrm.employment.manage'] },
  { key: 'viewer', name: 'Chart only viewer', handle: 'chart_viewer', permissions: ['hrm.org_chart.read'] },
  { key: 'selfViewer', name: 'Chart and self viewer', handle: 'chart_self_viewer', permissions: ['hrm.org_chart.read', 'hrm.self.read'] },
  { key: 'reader', name: 'Chart reader', handle: 'chart_reader', permissions: ['hrm.employment.read'] },
] } as const

test('layouts start empty, save with an audit record, and reject stale writes without losing the winner', { skip: !DB }, async () => {
  await withHarness(() => setupHarness(spec), async h => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId)
    const before = await loadOrgChartWorkspace({ orgId: h.org.orgId, actorId: h.editor, asOf: '2026-09-30' })
    assert.deepEqual(before.layout, { revision: 0, graph: { nodes: [], edges: [] } })
    const graph = { nodes: [{ id: randomUUID(), kind: 'employee', referenceId: employmentId, position: { x: 100, y: 200 } }], edges: [] }
    const saved = await saveOrgChartLayout({ orgId: h.org.orgId, actorId: h.editor, expectedRevision: 0, graph })
    assert.equal(saved.revision, 1)
    assert.deepEqual((await loadOrgChartWorkspace({ orgId: h.org.orgId, actorId: h.editor, asOf: '2026-09-30' })).layout, saved)
    const audit = (await db.execute<{ changes: { before: unknown; after: unknown }; actor: string }>(sql`select changes, actor_id as actor from audit_log where org_id = ${h.org.orgId} and action = 'org_chart_layout_saved'`)).rows
    assert.equal(audit.length, 1); assert.equal(audit[0]!.actor, h.editor); assert.deepEqual(audit[0]!.changes.after, saved)
    await assert.rejects(saveOrgChartLayout({ orgId: h.org.orgId, actorId: h.editor, expectedRevision: 0, graph: { nodes: [], edges: [] } }), /another editor/)
    assert.deepEqual((await loadOrgChartWorkspace({ orgId: h.org.orgId, actorId: h.editor, asOf: '2026-09-30' })).layout, saved)
  })
})
test('native employee references from another organization and viewer writes are refused', { skip: !DB }, async () => {
  await withHarness(() => setupHarness(spec), async a => {
    await withHarness(() => setupHarness(spec), async b => {
      const { employmentId } = await seedEmployment(b.org.orgId, b.org.subsidiaryId)
      const graph = { nodes: [{ id: randomUUID(), kind: 'employee', referenceId: employmentId, position: { x: 0, y: 0 } }], edges: [] }
      await assert.rejects(saveOrgChartLayout({ orgId: a.org.orgId, actorId: a.editor, expectedRevision: 0, graph }), /unavailable employee/)
      await assert.rejects(saveOrgChartLayout({ orgId: a.org.orgId, actorId: a.reader, expectedRevision: 0, graph: { nodes: [], edges: [] } }), /hrm.employment.manage/)
      assert.equal((await loadOrgChartWorkspace({ orgId: a.org.orgId, actorId: a.editor, asOf: '2026-09-30' })).layout.revision, 0)
    })
  })
})

test('chart-only readers see saved people and placeholders without directory or write access', { skip: !DB }, async () => {
  await withHarness(() => setupHarness(spec), async h => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId)
    const graph = { nodes: [
      { id: randomUUID(), kind: 'employee', referenceId: employmentId, position: { x: 100, y: 200 } },
      { id: randomUUID(), kind: 'department', label: 'Workshop', position: { x: 400, y: 200 } },
    ], edges: [] }
    const saved = await saveOrgChartLayout({ orgId: h.org.orgId, actorId: h.editor, expectedRevision: 0, graph })
    const workspace = await loadOrgChartWorkspace({ orgId: h.org.orgId, actorId: h.viewer, asOf: '2026-09-30' })
    assert.deepEqual(workspace.layout, saved)
    assert.equal(workspace.chart.headcount, 1)
    assert.equal((await loadDirectory({ orgId: h.org.orgId, actorId: h.selfViewer, asOf: '2026-09-30' })).totalCount, 0, 'chart access does not widen self-service directory scope')
    const person = workspace.chart.roots[0]!
    assert.equal(person.employmentId, employmentId)
    assert.equal('email' in person, false)
    assert.equal('salary' in person, false)
    await assert.rejects(loadDirectory({ orgId: h.org.orgId, actorId: h.viewer }), /directory requires hrm.employment.read or hrm.self.read/)
    await assert.rejects(saveOrgChartLayout({ orgId: h.org.orgId, actorId: h.viewer, expectedRevision: saved.revision, graph: { nodes: [], edges: [] } }), /hrm.employment.manage/)
    assert.deepEqual((await loadOrgChartWorkspace({ orgId: h.org.orgId, actorId: h.viewer, asOf: '2026-09-30' })).layout, saved)
  })
})
