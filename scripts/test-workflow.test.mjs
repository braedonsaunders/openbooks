import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const workflow = readFileSync(
  new URL('../.github/workflows/test.yml', import.meta.url),
  'utf8',
)

function occurrenceCount(source, value) {
  return source.split(value).length - 1
}

function namedStep(name) {
  const marker = `      - name: ${name}\n`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `workflow must contain the ${name} step`)
  const next = workflow.indexOf('\n      - ', start + marker.length)
  return workflow.slice(start, next === -1 ? workflow.length : next)
}

test('test workflow propagates tee producer failures and retains its failure guards', (t) => {
  const pipelines = [
    { stepName: 'Integration canary', logFile: 'canary.tap' },
    { stepName: 'Full test suite (with database)', logFile: 'coverage.txt' },
  ]
  const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-test-workflow-'))
  t.after(() => rmSync(tempDirectory, { recursive: true, force: true }))

  for (const { stepName, logFile } of pipelines) {
    const step = namedStep(stepName)
    const pipefail = 'set -o pipefail'
    const loggingPipeline = `2>&1 | tee ${logFile}`
    assert.match(step, /^\s{8}shell: bash$/m, `${stepName} must select bash explicitly`)
    assert.ok(step.includes(pipefail), `${stepName} must arm pipefail`)
    assert.ok(step.includes(loggingPipeline), `${stepName} must retain its tee logging pipeline`)
    assert.ok(
      step.indexOf(pipefail) < step.indexOf(loggingPipeline),
      `${stepName} must arm pipefail before starting the logging pipeline`,
    )

    const failingProducer = [
      pipefail,
      `${JSON.stringify(process.execPath)} -e 'console.log("deliberate producer failure"); process.exit(23)' ${loggingPipeline}`,
    ].join('\n')
    const failure = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-e', '-c', failingProducer],
      { cwd: tempDirectory, encoding: 'utf8' },
    )
    assert.notEqual(
      failure.status,
      0,
      `${stepName} must propagate a deliberate producer failure through tee`,
    )
    assert.match(
      readFileSync(join(tempDirectory, logFile), 'utf8'),
      /deliberate producer failure/,
      `${stepName} must still capture producer output`,
    )

    const successfulProducer = [
      pipefail,
      `${JSON.stringify(process.execPath)} -e 'console.log("successful producer")' ${loggingPipeline}`,
    ].join('\n')
    const success = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-e', '-c', successfulProducer],
      { cwd: tempDirectory, encoding: 'utf8' },
    )
    assert.equal(success.status, 0, `${stepName} must still accept a successful producer`)
  }

  const canary = namedStep('Integration canary')
  for (const assertion of [
    '/# SKIP(?:\\s|$)/im.test(s)',
    '/^not ok \\d+ - /m.test(s)',
    '!/^# fail 0$/m.test(s)',
    '!/^ok \\d+ - /m.test(s)',
  ]) {
    assert.ok(canary.includes(assertion), `integration canary must retain ${assertion}`)
  }

  const bypass = 'OPENBOOKS_TRUSTED_TEST_BYPASS: "1"'
  const restoreDrill = namedStep('Export, destroy, restore, and verify an isolated backup')
  assert.equal(
    occurrenceCount(workflow, bypass),
    1,
    'trusted test bypass must be limited to the restore drill step that imports its guard',
  )
  assert.equal(occurrenceCount(restoreDrill, bypass), 1)
})
