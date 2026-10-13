// source-pin-contract: Published0701–0703 immutable SQL and preflight predecessor bodies are the migration admission contract.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const generated = join(import.meta.dirname, 'migrations', 'generated');
const preflight = join(import.meta.dirname, 'migrations', 'preflight');

function body(sql, name) {
  return [...sql.matchAll(/CREATE(?: OR REPLACE)? FUNCTION public\.(\w+)\(\) RETURNS trigger[\s\S]*? AS (\$[^$]*\$)([\s\S]*?)\2;/gi)]
    .filter(match => match[1] === name).at(-1)?.[3];
}

function latestBefore(ordinal, name) {
  let latest;
  for (const file of readdirSync(generated).filter(file => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0,4)) < ordinal).sort()) {
    const published = body(readFileSync(join(generated, file), 'utf8'), name);
    if (published !== undefined) latest = published;
  }
  assert.ok(latest, `published prerequisite ${name}`);
  return latest;
}

function expected(sql) {
  return sql.match(/\$expected\$([\s\S]*?)\$expected\$/)?.[1];
}

test('merged-account attachment pins the published refusal without replacing history or clone admission', () => {
  const file = '0701_merged_account_reference_guards.sql';
  const published = latestBefore(701, 'refuse_merged_account_reference');
  const migration = readFileSync(join(generated, file), 'utf8');
  assert.equal(expected(readFileSync(join(preflight, file), 'utf8')), published);
  assert.equal(expected(migration), published);
  assert.equal(body(migration, 'refuse_merged_account_reference'), undefined);
});

test('currency binding pins the latest instruction guard and changes only its four local bindings', () => {
  const file = '0702_journal_instruction_currency_binding.sql';
  const published = latestBefore(702, 'journal_instruction_line_guard');
  const migration = readFileSync(join(generated, file), 'utf8');
  assert.equal(expected(readFileSync(join(preflight, file), 'utf8')), published);
  const amended = body(migration, 'journal_instruction_line_guard');
  assert.ok(amended);
  const restored = amended.replace('chosen_period uuid; v_book_currency text;', 'chosen_period uuid; currency text;')
    .replace('   v_book_currency:=public.accounting_book_currency(', '   currency:=public.accounting_book_currency(')
    .replace('NEW.currency=journal_instruction_line_guard.v_book_currency OR', 'NEW.currency=currency OR')
    .replace('f.currency<>journal_instruction_line_guard.v_book_currency\n', 'f.currency<>currency\n');
  assert.equal(restored, published);
  assert.match(amended, /f\.currency<>journal_instruction_line_guard\.v_book_currency/);
});


test('statistical storage upgrade pins its predecessor and uses an explicit local block namespace', () => {
  const file = '0703_journal_measurement_and_instruction_guards.sql';
  const published = latestBefore(703, 'journal_instruction_line_guard');
  const migration = readFileSync(join(generated, file), 'utf8');
  const gate = readFileSync(join(preflight, file), 'utf8');
  assert.equal(expected(gate), published);
  const amended = body(migration, 'journal_instruction_line_guard');
  assert.ok(amended);
  assert.match(amended, /<<instruction_line>>\nDECLARE/);
  assert.match(amended, /f\.currency<>instruction_line\.v_book_currency/);
  const restored = amended.replace('<<instruction_line>>\n', '')
    .replaceAll('instruction_line.v_book_currency', 'journal_instruction_line_guard.v_book_currency');
  assert.equal(restored, published);
  const baseline = readFileSync(join(generated, '0001_baseline.sql'), 'utf8');
  assert.ok(baseline.includes('CONSTRAINT jl_nonzero CHECK ((amount <> (0)::numeric))'));
  assert.ok(gate.includes("pg_get_constraintdef(oid)='CHECK ((amount <> (0)::numeric))'"));
});
