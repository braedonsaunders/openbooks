import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const publisher = fileURLToPath(new URL('./publish-trust.mjs', import.meta.url))
const repositoryRoot = dirname(dirname(publisher))

function runPublisher({ conformance, checkpoint, out, sha = 'test-sha' }) {
  return spawnSync(
    process.execPath,
    [
      publisher,
      '--conformance',
      conformance,
      '--checkpoint',
      checkpoint,
      '--out',
      out,
      '--sha',
      sha,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )
}

test('empty publication refuses before mutating the output directory', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-publish-trust-'))
  try {
    const conformance = join(tempDirectory, 'conformance')
    const checkpoint = join(tempDirectory, 'checkpoint')
    const out = join(tempDirectory, 'trust')
    const preservedHistory = '[{"gitSha":"previous"}]\n'
    const preservedBadge = '{"message":"previous"}\n'

    for (const directory of [conformance, checkpoint, out]) {
      mkdirSync(directory, { recursive: true })
    }
    writeFileSync(join(out, 'history.json'), preservedHistory)
    writeFileSync(join(out, 'badge-conformance.json'), preservedBadge)
    writeFileSync(join(out, 'badge-invariants.json'), preservedBadge)

    const result = runPublisher({ conformance, checkpoint, out })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /refusing to publish an empty trust page/)
    assert.equal(readFileSync(join(out, 'history.json'), 'utf8'), preservedHistory)
    assert.equal(readFileSync(join(out, 'badge-conformance.json'), 'utf8'), preservedBadge)
    assert.equal(readFileSync(join(out, 'badge-invariants.json'), 'utf8'), preservedBadge)
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})

test('publication writes evidence and history when inputs are present', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'openbooks-publish-trust-'))
  try {
    const conformance = join(tempDirectory, 'conformance')
    const checkpoint = join(tempDirectory, 'checkpoint')
    const out = join(tempDirectory, 'trust')
    mkdirSync(conformance, { recursive: true })
    mkdirSync(checkpoint, { recursive: true })

    writeFileSync(
      join(conformance, 'conformance.json'),
      JSON.stringify({
        totals: { pass: 1, fail: 0, gap: 0 },
        pass: true,
        cases: [{ id: 'case-1', status: 'pass' }],
      }),
    )
    writeFileSync(
      join(checkpoint, 'checkpoint.json'),
      JSON.stringify({
        orgName: 'Acme',
        counts: { postedEntries: 1 },
        checks: [{ name: 'balanced', ok: true }],
        pass: true,
      }),
    )

    const result = runPublisher({ conformance, checkpoint, out })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(out, 'badge-conformance.json')), true)
    assert.equal(existsSync(join(out, 'badge-invariants.json')), true)
    assert.equal(existsSync(join(out, 'conformance.json')), true)
    assert.equal(existsSync(join(out, 'checkpoint.json')), true)
    assert.equal(existsSync(join(out, 'history.json')), true)
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})
