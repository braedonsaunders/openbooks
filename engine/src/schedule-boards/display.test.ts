import assert from 'node:assert/strict';
import test from 'node:test';
import { bookingColor, sourceObservationColor } from './display.ts';

test('ordered color rules preserve literal values and use the first case-insensitive match', () => {
  const rules = [
    { field: 'detail', match: 'equals', value: 'night', color: '#112233' },
    {
      field: 'bookingLabel',
      match: 'startsWith',
      value: 'SITE/',
      color: '#445566',
    },
  ] as const;
  assert.equal(
    bookingColor(rules, { code: 'Site', label: 'Customer', detail: ' NIGHT ' }),
    '#112233',
  );
  assert.equal(
    bookingColor(rules, { code: 'Site', label: 'Customer', detail: 'East' }),
    '#445566',
  );
  assert.equal(
    bookingColor(rules, {
      code: 'Other',
      label: 'Site customer',
      detail: null,
    }),
    null,
  );
  assert.equal(
    bookingColor(
      [
        {
          field: 'targetName',
          match: 'contains',
          value: 'customer',
          color: '#abcdef',
        },
      ],
      { code: 'Site', label: 'Customer Ltd', detail: null },
    ),
    '#abcdef',
  );
});

test('source colors use exact code boundaries, longest configured code and ordered overrides without rewriting literals', () => {
  const codes = [
    { code: 'SHOP', label: 'Shop work', color: '#ff0000' },
    { code: 'SHOP/N', label: 'Night shop', color: '#00ff00' },
    { code: 'STAT', label: 'Stat holiday', color: '#0000ff' },
  ];
  assert.equal(sourceObservationColor([], 'SHOP', codes), '#ff0000');
  assert.equal(sourceObservationColor([], 'SHOP/ N', codes), '#ff0000');
  assert.equal(sourceObservationColor([], 'SHOP/N', codes), '#00ff00');
  assert.equal(sourceObservationColor([], 'SHOPPING', codes), null);
  assert.equal(sourceObservationColor([], null, codes), null);
  const literal = 'SHOP/ N';
  const rules = [
    {
      field: 'bookingLabel',
      match: 'equals',
      value: literal,
      color: '#112233',
    },
    { field: 'detail', match: 'equals', value: 'N', color: '#445566' },
  ] as const;
  assert.equal(sourceObservationColor(rules, literal, codes), '#112233');
  assert.equal(
    sourceObservationColor([...rules].reverse(), literal, codes),
    '#445566',
  );
  assert.equal(
    bookingColor(rules, { code: 'SHOP', label: 'Shop work', detail: ' N' }),
    '#112233',
  );
  assert.equal(literal, 'SHOP/ N');
});
