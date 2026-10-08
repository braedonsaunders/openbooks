import assert from 'node:assert/strict';
import test from 'node:test';
import { bookingColor } from './display.ts';

test('ordered color rules preserve literal values and use the first case-insensitive match', () => {
  const rules = [
    { field: 'detail', match: 'equals', value: 'night', color: '#112233' },
    { field: 'bookingLabel', match: 'startsWith', value: 'SITE/', color: '#445566' },
  ] as const;
  assert.equal(bookingColor(rules, { code: 'Site', label: 'Customer', detail: ' NIGHT ' }), '#112233');
  assert.equal(bookingColor(rules, { code: 'Site', label: 'Customer', detail: 'East' }), '#445566');
  assert.equal(bookingColor(rules, { code: 'Other', label: 'Site customer', detail: null }), null);
  assert.equal(bookingColor([{ field: 'targetName', match: 'contains', value: 'customer', color: '#abcdef' }], { code: 'Site', label: 'Customer Ltd', detail: null }), '#abcdef');
});
