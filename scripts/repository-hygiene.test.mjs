import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { test } from 'node:test'

const GENERATED_BINARY_EXTENSIONS = new Set([
  '.7z',
  '.a',
  '.bin',
  '.class',
  '.dll',
  '.dylib',
  '.exe',
  '.gz',
  '.jar',
  '.o',
  '.pdf',
  '.rar',
  '.so',
  '.tar',
  '.tgz',
  '.zip',
])

/** Exact repository-relative paths for binary regression fixtures belong here. */
const CATALOGUED_BINARY_FIXTURES = new Set()

const REPOSITORY_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim()

function repositoryPaths() {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--deduplicate', '-z'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .filter((relativePath) => existsSync(join(REPOSITORY_ROOT, relativePath)))
}

function isTestFixturePath(relativePath) {
  const segments = relativePath.split('/')
  return segments.some(
    (segment, index) =>
      segment === '__fixtures__' ||
      (segment === 'fixtures' && (segments[index - 1] === 'test' || segments[index - 1] === 'tests')),
  )
}

function looksLikeGeneratedBinary(relativePath, contents) {
  return (
    GENERATED_BINARY_EXTENSIONS.has(extname(relativePath).toLowerCase()) ||
    contents.includes(0)
  )
}

function hygieneViolation(
  relativePath,
  contents,
  cataloguedFixtures = CATALOGUED_BINARY_FIXTURES,
) {
  if (!looksLikeGeneratedBinary(relativePath, contents)) return null

  if (!relativePath.includes('/')) {
    return `${relativePath}: generated PDF or binary artifact is not allowed at repository root`
  }

  if (isTestFixturePath(relativePath) && !cataloguedFixtures.has(relativePath)) {
    return `${relativePath}: binary test fixture is not explicitly catalogued`
  }

  return null
}

test('generated root artifacts are forbidden and binary test fixtures require an exact catalogue entry', () => {
  const fixturePath = 'packages/pdf/test/fixtures/encrypted-document.pdf'
  const pdfBytes = Buffer.from('%PDF-1.7\nfixture')

  assert.match(
    hygieneViolation('forged.pdf', pdfBytes, new Set(['forged.pdf'])),
    /not allowed at repository root/,
    'a root artifact must stay forbidden even if someone tries to catalogue it as a fixture',
  )
  assert.match(
    hygieneViolation(fixturePath, pdfBytes, new Set()),
    /not explicitly catalogued/,
    'a fixture-directory location alone must not admit an abandoned binary',
  )
  assert.equal(
    hygieneViolation(fixturePath, pdfBytes, new Set([fixturePath])),
    null,
    'an exact catalogue entry permits an intentional binary regression fixture',
  )

  const violations = repositoryPaths()
    .map((relativePath) => {
      const contents = readFileSync(join(REPOSITORY_ROOT, relativePath))
      return hygieneViolation(relativePath, contents)
    })
    .filter(Boolean)

  assert.deepEqual(
    violations,
    [],
    `repository artifact hygiene violations:\n${violations.join('\n')}`,
  )
})
