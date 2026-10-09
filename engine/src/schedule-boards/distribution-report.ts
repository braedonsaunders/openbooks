import { ScheduleError } from "./errors.ts";
import {
  renderPdfDocument,
  resolvePdfPageSetup,
  type PdfDocumentInput,
} from "@openbooks/pdf";
import { addCalendarDays } from "../platform/civil-date.ts";
import type {
  ScheduleDistributionPreview,
  ScheduleRecipient,
} from "./distribution.ts";
/** Landscape sections preserve literal observations and independently identified people/resources. */
export function schedulePdfInput(
  preview: ScheduleDistributionPreview,
  recipient: ScheduleRecipient,
): PdfDocumentInput {
  const layout = preview.audience.pdfLayout ?? {
    paperSize: "tabloid",
    orientation: "landscape",
    marginMm: 8,
    density: "compact",
    daysPerSection: 14,
    detail: "assignments",
  };
  const days: string[] = [];
  for (
    let day = preview.from;
    day <= preview.through;
    day = addCalendarDays(day, 1)
  )
    days.push(day);
  const subjects = [
    ...new Map(
      recipient.lines.map((line) => [
        line.subjectId ?? line.subject,
        { id: line.subjectId ?? line.subject, name: line.subject },
      ]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const cells = new Map<string, Map<string, string[]>>();
  for (const line of recipient.lines) {
    const id = line.subjectId ?? line.subject;
    let subjectDays = cells.get(id);
    if (!subjectDays) cells.set(id, subjectDays = new Map());
    const assignment = line.assignment + (line.status === "Source date observation" && layout.detail === "assignments" ? " *" : "");
    const value = line.status === "No schedule evidence" ? "-"
      : layout.detail === "assignments" ? assignment
      : layout.detail === "hours" ? `${assignment}\n${line.hours}`
      : `${assignment}\n${line.hours}\n${line.status}`;
    const values = subjectDays.get(line.date) ?? [];
    values.push(value);
    subjectDays.set(line.date, values);
  }
  const dateLabel = new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  const groups: PdfDocumentInput["groups"] = [];
  if (preview.audience.message) groups.push({ kind: "results", title: "Message", columns: ["Message"], columnWeights: [1], rows: [[preview.audience.message]], overflow: "refuse" });
  for (let offset = 0; offset < days.length; offset += layout.daysPerSection) {
    const section = days.slice(offset, offset + layout.daysPerSection);
    groups.push({
      kind: "section",
      overflow: "refuse",
      title: `${section[0]} - ${section.at(-1)}`,
      subtitle: preview.timeZone,
      columns: ["Person / resource", ...section.map(day => dateLabel.format(new Date(`${day}T12:00:00Z`)).replace(", ", "\n"))],
      columnWeights: [2.5, ...section.map(() => 1)],
      rows: subjects.map((subject) => [
        subject.name,
        ...section.map(date => cells.get(subject.id)?.get(date)?.join("\n\n") || "-"),
      ]),
      isEmpty: subjects.length === 0,
    });
  }
  return {
    title: preview.boardName,
    dateRangeLabel: `${preview.from} - ${preview.through}`,
    generatedAt: new Date(preview.generatedAt),
    branding: { orgName: preview.organizationName },
    summary: [
      { label: "People / resources", value: String(subjects.length) },
      { label: "Days", value: String(days.length) },
      {
        label: "Sharing",
        value:
          preview.audience.visibility === "board" ? "Whole board" : "Personal",
      },
    ],
    groups,
    layout: resolvePdfPageSetup(layout),
    footerLeft:
      "* Source dates: hours unknown; blanks are not worked time.",
    footerRight: `Version ${preview.version.slice(0, 16)}`,
  };
}
/** Renderer failures propagate; a requested PDF is never silently dropped from delivery. */
export async function renderSchedulePdf(
  preview: ScheduleDistributionPreview,
  recipient: ScheduleRecipient,
) {
  try {
    return await renderPdfDocument(schedulePdfInput(preview, recipient));
  } catch (cause) {
    throw new ScheduleError(
      `The native PDF renderer could not prepare this schedule: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        code: "schedule_pdf_refused",
        remedy:
          "Choose a wider page, fewer date columns or less report detail, then preview again. No PDF or email was issued.",
        cause,
      },
    );
  }
}
