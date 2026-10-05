import assert from 'node:assert/strict'
import test from 'node:test'
import { unjustifiedConflicts } from './check-on-conflict-justification.mjs'

test('ignored conflicts require a nearby comment across SQL spellings and ORM calls', () => {
  for (const clause of ['on conflict do nothing', 'ON CONFLICT (id)\nDO NOTHING', 'on\nconflict (id) do\nnothing']) {
    const source = `db.execute(sql\`insert into jobs (id) values (1)\n${clause}\`);`
    assert.equal(unjustifiedConflicts(source).length, 1, clause)
    assert.equal(unjustifiedConflicts(`// The existing job owns this occurrence; a retry reuses it.\n${source}`).length, 0)
    assert.equal(unjustifiedConflicts(`// An unrelated distant explanation.\n\n\n\n${source}`).length, 1)
  }
  assert.equal(unjustifiedConflicts('db.insert(jobs).values(row).onConflictDoNothing()').length, 1)
  assert.equal(unjustifiedConflicts('// A retry preserves the existing occurrence.\ndb.insert(jobs).values(row).onConflictDoNothing()').length, 0)
  assert.equal(unjustifiedConflicts('db.insert(jobs)\n.values(row)\n// The existing occurrence already owns the work.\n.onConflictDoNothing()').length, 0)
})

test('quoted values, comments, ordinary prose and conflict updates do not mint ignored writes', () => {
  for (const source of [
    '// on conflict do nothing',
    'const message = "on conflict do nothing requires a reason";',
    'db.execute(sql`insert into notes values (\'on conflict do nothing\')`);',
    'db.execute(sql`insert into jobs values (1) -- on conflict do nothing\n`);',
    'db.execute(sql`insert into jobs values (1) on conflict (id) do update set id = excluded.id`);',
  ]) assert.deepEqual(unjustifiedConflicts(source), [], source)
  assert.equal(unjustifiedConflicts('db.execute(sql`insert into jobs values (1)\n-- Replays preserve the existing job.\non conflict do nothing`);').length, 0)
  assert.equal(unjustifiedConflicts('const query = `insert into jobs values (1) on conflict do nothing`; db.execute(query);').length, 1)
  assert.equal(unjustifiedConflicts('db.execute("insert into jobs values (1) on conflict do nothing");').length, 1)
  assert.equal(unjustifiedConflicts('const url = "https://example.test";\ndb.execute(sql`insert into jobs values (1) on conflict do nothing`);').length, 1)
  assert.equal(unjustifiedConflicts('db.execute(sql`insert into notes values (\'-- a quoted value\') on conflict do nothing`);').length, 1)
})
