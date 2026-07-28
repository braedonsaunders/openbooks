import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  parseExpectedTaskVersion,
  parseWorkBreakdownTaskInput,
  ProjectWorkBreakdownError,
} from './project-work-breakdown-validation.ts'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('WBS input validation is strict and preserves exact four-decimal values', () => {
  assert.deepEqual(
    parseWorkBreakdownTaskInput({
      code: ' 01.20 ',
      name: '  Mobilization ',
      status: 'open',
      estimatedHours: '12.125',
      estimatedCost: '101.2300',
    }),
    {
      code: '01.20',
      name: 'Mobilization',
      status: 'open',
      estimatedHours: '12.1250',
      estimatedCost: '101.2300',
    },
  )

  for (const input of [
    { name: '' },
    { name: 'Invalid status', status: 'draft' },
    { name: 'Negative hours', estimatedHours: '-1' },
    { name: 'Negative cost', estimatedCost: '-0.01' },
    { name: 'Unknown field', postedAmount: '1.00' },
  ]) {
    assert.throws(
      () => parseWorkBreakdownTaskInput(input),
      ProjectWorkBreakdownError,
    )
  }
})

test('WBS updates require a valid optimistic-concurrency version', () => {
  assert.equal(
    parseExpectedTaskVersion('2026-07-28T12:34:56.000Z'),
    '2026-07-28T12:34:56.000Z',
  )
  assert.throws(() => parseExpectedTaskVersion(undefined), /valid task version/)
  assert.throws(() => parseExpectedTaskVersion('not-a-date'), /valid task version/)
})

test('WBS API boundaries enforce project gates, permissions, ownership, concurrency, and audit', () => {
  const collection = source('app/api/projects/[id]/tasks/route.ts')
  const item = source('app/api/projects/[id]/tasks/[taskId]/route.ts')
  const service = source('lib/project-work-breakdown.ts')
  const projectRoute = source('app/api/projects/[id]/route.ts')

  assert.match(collection, /guardPermission\('projects\.read'\)/)
  assert.match(collection, /guardPermission\('projects\.manage'\)/)
  assert.match(collection, /guardProjectsFeature/)
  assert.match(item, /guardPermission\('projects\.manage'\)/)
  assert.match(item, /guardProjectsFeature/)
  assert.match(service, /project_id = \$\{args\.projectId\}/)
  assert.match(service, /org_id = \$\{args\.orgId\}/)
  assert.match(service, /for update/)
  assert.match(service, /locked snapshot comparison/)
  assert.doesNotMatch(service, /and updated_at = \$\{args\.expectedUpdatedAt\}/)
  assert.match(service, /Concurrent creates cannot both observe the same max/)
  assert.match(service, /insert into audit_log/)
  assert.match(service, /source: 'project_work_breakdown'/)
  assert.match(collection, /Task details must be valid JSON/)
  assert.match(item, /Task details must be valid JSON/)
  assert.match(projectRoute, /must be changed through the project task endpoint/)
  assert.doesNotMatch(projectRoute, /delete from project_tasks/)
})

test('WBS drawer supports direct create, edit, refresh, canonical saves, and conflict errors', () => {
  const tab = source('app/(app)/projects/tabs/WorkBreakdownTab.tsx')

  assert.match(tab, /method: creating \? 'POST' : 'PATCH'/)
  assert.match(tab, /expectedUpdatedAt: editor\.updatedAt/)
  assert.match(tab, /cache: 'no-store'/)
  assert.match(tab, /setTasks\(\(current\)/)
  assert.match(tab, /role="alert"/)
  assert.match(tab, /stacked/)
  assert.match(tab, /router\.refresh\(\)/)
  assert.match(tab, /if \(!left\.code && right\.code\) return 1/)
})
