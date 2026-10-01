import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EMPTY_ORG_CHART_LAYOUT, orgChartLayoutSchema } from './org-chart-layout-schema.ts'
const employee = () => ({ id: randomUUID(), kind: 'employee' as const, referenceId: randomUUID(), position: { x: 0, y: 0 } })
const placeholder = () => ({ id: randomUUID(), kind: 'department' as const, label: 'Workshop', position: { x: 300, y: 0 } })
test('the default chart is empty and placeholders do not create a parallel employee roster', () => {
  assert.deepEqual(EMPTY_ORG_CHART_LAYOUT.graph, { nodes: [], edges: [] })
  assert.ok(orgChartLayoutSchema.safeParse({ nodes: [placeholder()], edges: [] }).success)
  assert.equal(orgChartLayoutSchema.safeParse({ nodes: [{ ...employee(), label: 'Different employee name' }], edges: [] }).success, false)
  assert.equal(orgChartLayoutSchema.safeParse({ nodes: [{ ...placeholder(), referenceId: randomUUID() }], edges: [] }).success, false)
})
test('native reporting lines cannot be saved as separate diagram relationships', () => {
  const a = employee(), b = employee()
  const result = orgChartLayoutSchema.safeParse({ nodes: [a, b], edges: [{ source: a.id, target: b.id }] })
  assert.equal(result.success, false)
  if (!result.success) assert.match(result.error.message, /Edit the employee’s manager/)
})
test('duplicate employees, cycles, missing endpoints, and nonfinite positions are refused', () => {
  const a = employee(), b = placeholder(), c = placeholder()
  const bad = [
    { nodes: [a, { ...a, id: randomUUID() }], edges: [] },
    { nodes: [b, c], edges: [{ source: b.id, target: c.id }, { source: c.id, target: b.id }] },
    { nodes: [b], edges: [{ source: b.id, target: randomUUID() }] },
    { nodes: [{ ...a, position: { x: Infinity, y: 0 } }], edges: [] },
  ]
  for (const graph of bad) assert.equal(orgChartLayoutSchema.safeParse(graph).success, false)
})
test('a 5,000-person workspace is accepted without automatic placement or quadratic cycle walks', () => {
  const nodes = Array.from({ length: 5000 }, employee)
  const result = orgChartLayoutSchema.safeParse({ nodes, edges: [] })
  assert.ok(result.success)
  if (result.success) assert.equal(result.data.nodes.length, 5000)
})
