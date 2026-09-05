import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../engine/src/db.ts';

const migration = readFileSync(new URL('./migrations/generated/0088_custom_field_definition_uniqueness.sql', import.meta.url), 'utf8');
function uniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
for (const collision of [false, true]) {
  test(`custom-field uniqueness migration ${collision ? 'preserves and reports legacy collisions' : 'enforces normalized scopes on inserts and updates'}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const namespace = `review_custom_fields_${randomUUID().replaceAll('-', '')}`;
    const table = sql`${sql.identifier(namespace)}.${sql.identifier('custom_field_defs')}`;
    const orgId = randomUUID();
    await db.execute(sql`create schema ${sql.identifier(namespace)}`);
    try {
      await db.execute(sql`create table ${table} (id uuid primary key default gen_random_uuid(), org_id uuid not null, target_table text not null, target_kind text, key text not null, is_active boolean not null default true, config jsonb not null default '{}'::jsonb)`);
      await db.execute(sql`insert into ${table}(org_id,target_table,key,config) values (${orgId},'parties','review_note','{"evidence":"preserve"}'::jsonb)`);
      if (collision) await db.execute(sql`insert into ${table}(org_id,target_table,target_kind,key,is_active) values (${orgId},'parties','','review_note',false)`);
      const apply = () => db.transaction(tx => tx.execute(sql.raw(migration.replaceAll('public.', `${namespace}.`))));
      const before = (await db.execute(sql`select * from ${table} order by id`)).rows;
      if (collision) {
        await assert.rejects(apply, uniqueViolation);
        assert.deepEqual((await db.execute(sql`select * from ${table} order by id`)).rows, before, 'no historical row may be renamed, merged, deactivated or deleted');
        assert.equal((await db.execute(sql`select 1 from pg_indexes where schemaname=${namespace} and indexname='custom_field_defs_scope_key_unique'`)).rows.length, 0);
        return;
      }
      await apply();
      await apply();
      assert.deepEqual((await db.execute(sql`select * from ${table} order by id`)).rows, before, 'clean migration retains every value');
      for (const kind of [null, '']) await assert.rejects(() => db.execute(sql`insert into ${table}(org_id,target_table,target_kind,key) values (${orgId},'parties',${kind},'review_note')`), uniqueViolation);
      await db.execute(sql`update ${table} set is_active=false where key='review_note'`);
      await assert.rejects(() => db.execute(sql`insert into ${table}(org_id,target_table,key) values (${orgId},'parties','review_note')`), uniqueViolation);
      await db.execute(sql`insert into ${table}(org_id,target_table,target_kind,key) values (${orgId},'documents','vendor_bill','review_note'),(${orgId},'documents','invoice','review_note'),(${randomUUID()},'parties',null,'review_note'),(${orgId},'projects',null,'review_note'),(${orgId},'parties',null,'other_note')`);
      await assert.rejects(() => db.execute(sql`update ${table} set key='review_note' where org_id=${orgId} and target_table='parties' and key='other_note'`), uniqueViolation);
      const raced = await Promise.allSettled(Array.from({length:8}, () => db.execute(sql`insert into ${table}(org_id,target_table,key) values (${orgId},'parties','raced_note')`)));
      assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
      assert.ok(raced.every(result => result.status === 'fulfilled' || uniqueViolation(result.reason)));
    } finally { await db.execute(sql`drop schema ${sql.identifier(namespace)} cascade`); }
  });
}
