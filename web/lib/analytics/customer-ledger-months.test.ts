import assert from 'node:assert/strict';
import test from 'node:test';
import { mulDecimal } from '@openbooks/engine/money';
import { customerLedgerMonths } from './customer-ledger-months';

test('monthly recognition preserves functional/day conversion grain across customers and reversals', () => {
  const months = customerLedgerMonths([
    { func: 'USD', day: '2026-06-30', recognized: '999' },
    { func: 'USD', day: '2026-07-01', recognized: '0.0001' },
    { func: 'USD', day: '2026-07-01', recognized: '0.0001' },
    { func: 'USD', day: '2026-07-02', recognized: '-0.0002' },
    { func: 'CAD', day: '2026-07-01', recognized: '900719925474099.0001' },
    { func: 'CAD', day: '2026-07-01', recognized: '-900719925474099' },
    { func: null, day: '2026-07-01', recognized: null },
    { func: null, day: '2026-08-01', recognized: '0' },
  ], '2026-07-01');
  assert.deepEqual(months, [
    { month: '2026-07', func: 'USD', day: '2026-07-01', recognized: '0.0002' },
    { month: '2026-07', func: 'USD', day: '2026-07-02', recognized: '-0.0002' },
    { month: '2026-07', func: 'CAD', day: '2026-07-01', recognized: '0.0001' },
    { month: '2026-08', func: null, day: '2026-08-01', recognized: '0' },
  ]);
  assert.equal(mulDecimal(months[0]!.recognized, '1.3333333333'), '0.0003');
  assert.equal(mulDecimal('0.0001', '1.3333333333'), '0.0001');
  assert.deepEqual(customerLedgerMonths([], '2026-07-01'), []);
});
