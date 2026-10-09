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

test('explicit rich messages emit only escaped formatting and safe links with a plain-text alternative; legacy HTML-looking prose remains literal', () => {
  const common = {recipient: 'Ana', board: 'Crew', from: '2026-10-12', through: '2026-10-18', timeZone: 'UTC', version: 'b'.repeat(64), lines: []}
  const legacy = scheduleDistributionEmail({...common, message: '<strong>Literal</strong>'})
  assert.ok(legacy.html.includes('&lt;strong&gt;Literal&lt;/strong&gt;'))
  assert.ok(!legacy.html.includes('<strong>Literal</strong>'))
  const rich = scheduleDistributionEmail({...common, message: 'Untrusted alternative', messageContent: {version: 1, blocks: [{kind: 'paragraph', spans: [{text: '<img src=x onerror=alert(1)>', bold: true}, {text: ' instructions', italic: true, href: 'https://example.test/crew?a=1&b=2'}]}, {kind: 'bullet', spans: [{text: 'Bring tools', underline: true}]}]}})
  assert.ok(rich.html.includes('<strong>&lt;img'))
  assert.ok(!rich.html.includes('<img'))
  assert.ok(rich.html.includes('<ul><li><u>Bring tools</u></li></ul>'))
  assert.ok(rich.html.includes('href="https://example.test/crew?a=1&amp;b=2"'))
  assert.ok(rich.text.includes('• Bring tools'))
  assert.ok(rich.text.includes('instructions (https://example.test/crew?a=1&b=2)'))
  assert.ok(!rich.text.includes('Untrusted alternative'))
  assert.throws(() => scheduleDistributionEmail({...common, messageContent: {version: 1, blocks: [{kind: 'paragraph', spans: [{text: 'Unsafe', href: 'javascript:alert(1)'}]}]}}))
})
