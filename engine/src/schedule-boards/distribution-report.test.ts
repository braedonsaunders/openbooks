import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { renderSchedulePdf, schedulePdfInput } from "./distribution-report.ts";
import {
  scheduleRecipientLines,
  serializeSchedulePreview,
  type ScheduleDistributionPreview,
} from "./distribution.ts";
import type { BoardWindow } from "./window.ts";
const recipient = {
  partyId: "contact",
  name: "Operator",
  email: "operator@example.test",
  contacts: [{ id: "contact", name: "Operator" }],
  subjects: [],
  lines: [
    {
      subjectId: "one",
      subject: "Alex Field",
      date: "2026-10-12",
      assignment: "SON/ N",
      hours: "Hours unknown",
      status: "Source date observation",
    },
    {
      subjectId: "one",
      subject: "Alex Field",
      date: "2026-10-12",
      assignment: "0205",
      hours: "Hours unknown",
      status: "Source date observation",
    },
    {
      subjectId: "two",
      subject: "Alex Field",
      date: "2026-10-12",
      assignment: "SERVICE",
      hours: "8h 0m booked",
      status: "Published booking",
    },
  ],
};
const preview: ScheduleDistributionPreview = {
  boardId: "board",
  boardName: "Service schedule",
  organizationName: "Example Company",
  from: "2026-10-11",
  through: "2026-10-24",
  timeZone: "America/Toronto",
  generatedAt: "2026-10-12T10:03:00.000Z",
  version: "a".repeat(64),
  audience: {
    visibility: "board",
    recipientMode: "selected",
    everyone: false,
    subjectIds: [],
    additionalPartyIds: ["contact"],
    includePdf: true,
  },
  recipients: [recipient],
  refusals: [],
};

test("native PDF grid keeps same-name people separate, literal multiple assignments, actual issuance time and unknown-hour evidence", () => {
  const input = schedulePdfInput(preview, recipient);
  assert.equal(input.generatedAt.toISOString(), preview.generatedAt);
  assert.equal(input.branding.orgName, "Example Company");
  assert.equal(input.groups.length, 1);
  assert.equal(input.groups[0]!.columns.length, 15);
  assert.equal(input.groups[0]!.rows.length, 2);
  assert.equal(input.groups[0]!.rows[0]![2], "SON/ N *\n\n0205 *");
  assert.equal(input.groups[0]!.rows[1]![2], "SERVICE");
  assert.match(input.footerLeft!, /hours unknown/);
  assert.equal(input.groups[0]!.overflow, "refuse");
  const detailed = schedulePdfInput(
    {
      ...preview,
      audience: {
        ...preview.audience,
        pdfLayout: {
          paperSize: "a4",
          orientation: "landscape",
          marginMm: 10,
          density: "standard",
          daysPerSection: 7,
          detail: "full",
        },
      },
    },
    recipient,
  );
  assert.equal(detailed.groups.length, 2);
  assert.match(
    String(detailed.groups[0]!.rows[0]![2]),
    /SON\/ N\nHours unknown\nSource date observation/,
  );
});

test("unified renderer creates real Tabloid and A4 PDFs with native pagination and preserves date-only semantics", async () => {
  const tabloid = await PDFDocument.load(
    await renderSchedulePdf(preview, recipient),
  );
  assert.ok(tabloid.getPageCount() > 0);
  assert.deepEqual(tabloid.getPage(0).getSize(), { width: 1224, height: 792 });
  const a4 = await PDFDocument.load(
    await renderSchedulePdf(
      {
        ...preview,
        audience: {
          ...preview.audience,
          pdfLayout: {
            paperSize: "a4",
            orientation: "landscape",
            marginMm: 10,
            density: "standard",
            daysPerSection: 7,
            detail: "full",
          },
        },
      },
      recipient,
    ),
  );
  assert.ok(a4.getPage(0).getWidth() > a4.getPage(0).getHeight());
  assert.equal(recipient.lines[0]!.hours, "Hours unknown");
});

test("an exact evidence PDF refuses unprintable rows without silently dropping the requested attachment", async () => {
  const huge = {
    ...recipient,
    lines: [
      { ...recipient.lines[0]!, assignment: "LONG SOURCE\n".repeat(300) },
    ],
  };
  await assert.rejects(
    renderSchedulePdf(
      {
        ...preview,
        audience: {
          ...preview.audience,
          pdfLayout: {
            paperSize: "letter",
            orientation: "portrait",
            marginMm: 30,
            density: "standard",
            daysPerSection: 7,
            detail: "full",
          },
        },
      },
      huge,
    ),
    /no report evidence was truncated/,
  );
});

test("only current-board published bookings enter the addressed report; linked source observations appear once", () => {
  const window = {
    board: { id: "one" },
    rows: [{ subjectId: "person", name: "Person" }],
    entries: [
      {
        id: "own",
        boardId: "one",
        status: "published",
        subjectId: "person",
        workedMinutes: 480,
        startsOn: "2026-10-12",
        endsOn: "2026-10-12",
        startClock: "07:00",
        endClock: "15:00",
        target: { code: "OWN" },
        detail: null,
      },
      {
        id: "peer",
        boardId: "two",
        status: "published",
        subjectId: "person",
        workedMinutes: 480,
        startsOn: "2026-10-12",
        endsOn: "2026-10-12",
        startClock: "07:00",
        endClock: "15:00",
        target: { code: "PRIVATE" },
        detail: null,
      },
      {
        id: "linked",
        boardId: "one",
        status: "published",
        subjectId: "person",
        workedMinutes: 480,
        startsOn: "2026-10-12",
        endsOn: "2026-10-12",
        startClock: "07:00",
        endClock: "15:00",
        target: { code: "DUPLICATE" },
        detail: null,
      },
    ],
    sourceRecords: [
      {
        workerPartyId: "person",
        onDate: "2026-10-12",
        label: "0205",
        linkedEntryId: "linked",
      },
    ],
  } as unknown as BoardWindow;
  const lines = scheduleRecipientLines(window, new Set(["person"]));
  assert.deepEqual(lines.map((line) => line.assignment).sort(), [
    "0205",
    "OWN",
  ]);
  assert.ok(lines.every((line) => line.subjectId === "person"));
  const serialized = serializeSchedulePreview(preview);
  assert.deepEqual(serialized.sharedLines, recipient.lines);
  assert.deepEqual(serialized.recipients[0]!.lines, []);
  assert.deepEqual(recipient.lines, preview.recipients[0]!.lines);
});


test("populated shared PDF layouts paginate readable people/date grids with repeated identity and bounded exact evidence", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const lines = Array.from({ length: 85 }, (_, person) => Array.from({ length: 14 }, (_, day) => ({
    subjectId: `native-example-${person}`,
    subject: person === 0 ? "Alexandra Example - Field Services and Equipment Coordination" : `Example Person ${String(person + 1).padStart(2, "0")}`,
    date: `2026-10-${String(11 + day).padStart(2, "0")}`,
    assignment: day % 7 === 0 || day % 7 === 6 ? "" : person % 3 === 0 ? "SON/ N" : person % 3 === 1 ? "SERVICE / East" : "0205",
    hours: day % 7 === 0 || day % 7 === 6 ? "" : "Hours unknown",
    status: day % 7 === 0 || day % 7 === 6 ? "No schedule evidence" : "Source date observation",
  }))).flat();
  const sample = { ...recipient, lines };
  const layouts = [
    { name: "two-week-tabloid", layout: { paperSize: "tabloid" as const, orientation: "landscape" as const, marginMm: 8, density: "compact" as const, daysPerSection: 14 as const, detail: "assignments" as const } },
    { name: "weekly-a4-detail", layout: { paperSize: "a4" as const, orientation: "landscape" as const, marginMm: 10, density: "standard" as const, daysPerSection: 7 as const, detail: "full" as const } },
    { name: "empty-personal-letter", layout: { paperSize: "letter" as const, orientation: "landscape" as const, marginMm: 10, density: "standard" as const, daysPerSection: 7 as const, detail: "assignments" as const }, empty: true },
  ];
  for (const variant of layouts) {
    const report = { ...preview, recipients: [sample], audience: { ...preview.audience, pdfLayout: variant.layout } };
    const pdf = await renderSchedulePdf(report, variant.empty ? { ...sample, lines: [] } : sample);
    const parsed = await PDFDocument.load(pdf);
    assert.ok(parsed.getPageCount() >= (variant.empty ? 1 : 2));
    assert.ok(parsed.getPages().every(page => page.getWidth() > page.getHeight()));
    const group = schedulePdfInput(report, variant.empty ? { ...sample, lines: [] } : sample).groups[0]!;
    assert.equal(group.rows.length, variant.empty ? 0 : 85);
    assert.match(group.columns[1]!, /Sun/);
    assert.deepEqual(group.columnWeights, [2.5, ...Array(variant.layout.daysPerSection).fill(1)]);
    // A coordinator may retain these synthetic examples for visual review in its private artifact directory.
    if (process.env.OPENBOOKS_PDF_REVIEW_DIR) {
      await mkdir(process.env.OPENBOOKS_PDF_REVIEW_DIR, { recursive: true });
      await writeFile(join(process.env.OPENBOOKS_PDF_REVIEW_DIR, `${variant.name}.pdf`), pdf);
    }
  }
});
