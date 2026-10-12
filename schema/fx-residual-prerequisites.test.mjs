import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const generated = join(import.meta.dirname,'migrations','generated');
const preflight = join(import.meta.dirname,'migrations','preflight');

/** Resolve each overload from immutable source order, independently of a live database. */
function publishedOverloadsBefore(ordinal) {
  const latest = new Map();
  for (const file of readdirSync(generated).filter(file=>/^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0,4))<ordinal).sort()) {
    const sql = readFileSync(join(generated,file),'utf8');
    for (const match of sql.matchAll(/CREATE(?: OR REPLACE)? FUNCTION public\.journal_lines_check_fx_residual_entries\(([^)]*)\) RETURNS void[\s\S]*? AS (\$[^$]*\$)([\s\S]*?)\2;/gi)) {
      latest.set(match[1].includes(',')?'uuid[],boolean':'uuid[]',{body:match[3],file});
    }
  }
  return latest;
}

function expectedOverloads(file) {
  const sql = readFileSync(join(preflight,file),'utf8');
  return new Map([...sql.matchAll(/oid='public\.journal_lines_check_fx_residual_entries\(([^)]*)\)'::regprocedure\) IS DISTINCT FROM \$expected\$([\s\S]*?)\$expected\$/g)].map(match=>[match[1],match[2]]));
}

test('journal instruction preflight pins the latest published residual wrapper, not its superseded implementation',()=>{
  const published = publishedOverloadsBefore(692);
  const expected = expectedOverloads('0692_journal_instruction_modes.sql');
  assert.equal(expected.get('uuid[]'),published.get('uuid[]')?.body);
  assert.match(expected.get('uuid[]'),/perform public\.journal_lines_check_fx_residual_entries\(p_entry_ids, false\)/);
});

test('typed residual upgrade pins both published overload prerequisites separately',()=>{
  const published = publishedOverloadsBefore(700);
  const expected = expectedOverloads('0700_typed_currency_adjustment_fx_residual_guards.sql');
  assert.equal(expected.size,2);
  for (const signature of ['uuid[]','uuid[],boolean']) {
    assert.equal(expected.get(signature),published.get(signature)?.body,signature);
  }
  assert.match(expected.get('uuid[],boolean'),/e\.id=any\(p_entry_ids\)/);
  assert.match(expected.get('uuid[],boolean'),/touched\.repetitions/);
});
