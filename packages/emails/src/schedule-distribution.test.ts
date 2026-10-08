import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleDistributionEmail } from './schedule-distribution';
test('reviewed reports escape source prose, identify exact window/version and distinguish unknown from booked hours', () => {
  const report = scheduleDistributionEmail({
    recipient: 'Alex <Admin>',
    board: 'Service & resources',
    from: '2026-10-12',
    through: '2026-10-18',
    timeZone: 'America/Toronto',
    version: 'a'.repeat(64),
    lines: [
      {
        date: '2026-10-12',
        subject: 'Alex',
        assignment: 'SHOP/ N <script>',
        hours: 'Hours unknown',
        status: 'Source date observation',
      },
      {
        date: '2026-10-13',
        subject: 'Forklift 7',
        assignment: 'Customer',
        hours: '10h 0m booked',
        status: 'Published booking',
      },
    ],
  });
  assert.ok(!report.html.includes('<script>'));
  assert.match(report.html, /SHOP\/ N &lt;script&gt;/);
  assert.match(report.text, /Hours unknown/);
  assert.match(report.text, /10h 0m booked/);
  assert.match(report.text, /America\/Toronto/);
  assert.ok(report.html.includes('a'.repeat(64)));
  assert.match(report.subject, /2026-10-12 – 2026-10-18/);
});
