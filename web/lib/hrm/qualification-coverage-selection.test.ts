import assert from 'node:assert/strict'
import test from 'node:test'
import { selectCoverageProject } from './qualification-coverage-selection'

test('an unfiltered coverage matrix has no selected project', () => {
  assert.equal(
    selectCoverageProject(undefined, [
      { value: 'project-a', label: 'Project A' },
      { value: 'project-b', label: 'Project B' },
    ]),
    null,
  )
})

test('coverage selection keeps an explicitly selected available project only', () => {
  const projects = [{ value: 'project-a', label: 'Project A' }]
  assert.equal(selectCoverageProject('project-a', projects), 'project-a')
  assert.equal(selectCoverageProject('stale-project', projects), null)
})
