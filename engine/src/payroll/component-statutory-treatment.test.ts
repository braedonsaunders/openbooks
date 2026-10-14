import assert from 'node:assert/strict';
import test from 'node:test';
import { selectComponentStatutoryTreatments } from './component-statutory-treatment.ts';

const policy = (id: string, group: string | null, exclusions: string[]) => ({
  id,
  pay_component_id: 'component-1',
  worker_comp_group_id: group,
  effective_from: '2026-01-01',
  effective_to: null,
  program_exclusions: exclusions,
});

test('a workers compensation group treatment overrides the component-wide treatment', () => {
  const resolved = selectComponentStatutoryTreatments([
    policy('group', '238220', ['wcb']),
    policy('default', null, ['eht']),
  ], '238220', '2026-01-01');
  assert.equal(resolved.get('component-1')?.id, 'group');
});

test('a component-wide treatment remains the fallback for other workers compensation groups', () => {
  const resolved = selectComponentStatutoryTreatments([
    policy('default', null, ['eht']),
    policy('other-group', '002', ['wcb']),
  ], '238220', '2026-01-01');
  assert.equal(resolved.get('component-1')?.id, 'default');
});

test('component 130 transitions EHT and workers compensation assessability on the configured pay dates', () => {
  const versions = [
    { ...policy('before-march-13', null, ['eht', 'wcb']), effective_from: '2026-01-09', effective_to: '2026-03-12' },
    { ...policy('march-13', null, ['wcb']), effective_from: '2026-03-13', effective_to: '2026-03-26' },
    { ...policy('march-27', null, []), effective_from: '2026-03-27', effective_to: null },
  ];
  assert.deepEqual(selectComponentStatutoryTreatments(versions, null, '2026-03-12').get('component-1')?.program_exclusions, ['eht', 'wcb']);
  assert.deepEqual(selectComponentStatutoryTreatments(versions, null, '2026-03-13').get('component-1')?.program_exclusions, ['wcb']);
  assert.deepEqual(selectComponentStatutoryTreatments(versions, null, '2026-03-27').get('component-1')?.program_exclusions, []);
});

test('component 114 workers compensation treatment changes only for the scoped group', () => {
  const versions = [
    { ...policy('group-312-excluded', '238220', ['wcb']), effective_from: '2026-01-09', effective_to: '2026-04-02' },
    { ...policy('group-312-assessable', '238220', []), effective_from: '2026-04-03', effective_to: null },
    { ...policy('component-default', null, []), effective_from: '2026-01-09', effective_to: null },
  ];
  assert.deepEqual(selectComponentStatutoryTreatments(versions, '238220', '2026-04-02').get('component-1')?.program_exclusions, ['wcb']);
  assert.deepEqual(selectComponentStatutoryTreatments(versions, '238220', '2026-04-03').get('component-1')?.program_exclusions, []);
  assert.equal(selectComponentStatutoryTreatments(versions, '002', '2026-04-02').get('component-1')?.id, 'component-default');
});

test('a scoped treatment does not cover a worker without that compensation group', () => {
  const resolved = selectComponentStatutoryTreatments([
    policy('group-only', '238220', ['wcb']),
  ], null, '2026-01-01');
  assert.equal(resolved.has('component-1'), false);
});

test('overlapping rows at one scope refuse instead of selecting an arbitrary version', () => {
  assert.throws(() => selectComponentStatutoryTreatments([
    policy('first', '238220', ['wcb']),
    policy('second', '238220', []),
  ], '238220', '2026-01-01'), /same scope/);
});
