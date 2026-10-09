import { writeFile } from 'node:fs/promises';
import { renderSchedulePdf } from '../engine/src/schedule-boards/distribution-report.ts';
import type { ScheduleDistributionPreview } from '../engine/src/schedule-boards/distribution.ts';

// The deployed worker must render the same unified schedule document as interactive delivery.
const recipient = {
  partyId: 'example-contact', name: 'Example contact', email: 'example@example.test',
  contacts: [{ id: 'example-contact', name: 'Example contact' }], subjects: [],
  lines: Array.from({ length: 85 }, (_, person) => Array.from({ length: 14 }, (_, day) => ({
    subjectId: `example-person-${person}`, subject: `Example Person ${String(person + 1).padStart(2, '0')}`,
    date: `2026-10-${String(11 + day).padStart(2, '0')}`, assignment: day % 3 === 0 ? 'SON/ N' : 'SERVICE',
    hours: 'Hours unknown', status: 'Source date observation',
  }))).flat(),
};
const preview: ScheduleDistributionPreview = {
  boardId: 'example-board', boardName: 'Service schedule', organizationName: 'Example Company',
  from: '2026-10-11', through: '2026-10-24', timeZone: 'America/Toronto',
  generatedAt: '2026-10-12T10:03:00Z', version: 'a'.repeat(64),
  audience: { visibility: 'board', recipientMode: 'selected', everyone: false, subjectIds: [], additionalPartyIds: ['example-contact'], includePdf: true },
  recipients: [recipient], refusals: [],
};
const pdf = await renderSchedulePdf(preview, recipient);
if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || !pdf.includes(Buffer.from('/MediaBox [0 0 1224 792]')))
  throw new Error('The deployed unified schedule PDF did not render its requested landscape page.');
if (process.env.OPENBOOKS_NATIVE_PDF_REVIEW_FILE) await writeFile(process.env.OPENBOOKS_NATIVE_PDF_REVIEW_FILE, pdf);
console.log('Unified populated schedule PDF rendered with native runtime assets.');
