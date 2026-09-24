import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDatabaseEnvironment } from './db-environment.ts'

test('test processes never read developer database, queue or transport configuration', () => {
  for (const mode of [
    { NODE_ENV: 'test' },
    { NODE_TEST_CONTEXT: 'child-v8' },
  ]) {
    let reads = 0
    const resolved = resolveDatabaseEnvironment(
      { ...mode, OPENBOOKS_DB_URL: 'isolated-db' },
      () => {
        reads++
        return 'OPENBOOKS_DB_URL=real-db\nOPENBOOKS_REDIS_URL=real-queue\nSMTP_PASSWORD=private'
      },
    )
    assert.equal(reads, 0)
    assert.equal(resolved.OPENBOOKS_DB_URL, 'isolated-db')
    assert.equal(resolved.OPENBOOKS_REDIS_URL, undefined)
    assert.equal(resolved.SMTP_PASSWORD, undefined)
  }
})

test('tests use only explicitly supplied service endpoints, including an explicit empty value', () => {
  const env = {
    NODE_ENV: 'test',
    OPENBOOKS_DB_URL: '',
    OPENBOOKS_REDIS_URL: 'redis://127.0.0.1:56379',
  }
  assert.deepEqual(
    resolveDatabaseEnvironment(env, () => {
      throw new Error('must not read')
    }),
    env,
  )
})

test('normal application startup preserves environment precedence and missing-file handling', () => {
  assert.deepEqual(
    resolveDatabaseEnvironment(
      { NODE_ENV: 'development', OPENBOOKS_DB_URL: 'override' },
      () => 'OPENBOOKS_DB_URL=file\nORG_COUNTRY=CA',
    ),
    { NODE_ENV: 'development', OPENBOOKS_DB_URL: 'override', ORG_COUNTRY: 'CA' },
  )
  assert.deepEqual(
    resolveDatabaseEnvironment({ NODE_ENV: 'production' }, () => {
      throw new Error('no local file')
    }),
    { NODE_ENV: 'production' },
  )
})

test('an unset NODE_ENV never reads developer-local configuration (fail closed)', () => {
  for (const env of [{}, { NODE_ENV: '' }, { NODE_ENV: 'production' }, { NODE_ENV: 'staging' }]) {
    let reads = 0
    const resolved = resolveDatabaseEnvironment(env, () => {
      reads++
      return 'OPENBOOKS_DB_URL=repo-dev-db'
    })
    assert.equal(reads, 0)
    assert.equal(resolved.OPENBOOKS_DB_URL, undefined)
  }
})

test('only an explicit development runtime reads the local file', () => {
  let reads = 0
  const resolved = resolveDatabaseEnvironment({ NODE_ENV: 'development' }, () => {
    reads++
    return 'OPENBOOKS_DB_URL=dev-db'
  })
  assert.equal(reads, 1)
  assert.equal(resolved.OPENBOOKS_DB_URL, 'dev-db')
})
