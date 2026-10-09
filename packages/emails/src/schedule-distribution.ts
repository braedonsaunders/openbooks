import { esc, shell, type EmailOut } from './shell';
export interface ScheduleEmailLine {
  date: string;
  subject: string;
  /** Native identity distinguishes people/resources with the same display name. */
  subjectId?: string;
  assignment: string;
  hours: string;
  status: string;
  /** Native board rule/code resolution, bound with the reviewed report evidence. */
  color?: string | null;
}
/** Reports contain the reviewed personal or explicitly shared board audience. */
export function scheduleDistributionEmail(input: {
  message?: string;
  recipient: string;
  board: string;
  from: string;
  through: string;
  timeZone: string;
  version: string;
  lines: readonly ScheduleEmailLine[];
}): EmailOut {
  const subject = `${input.board} · ${input.from} – ${input.through}`;
  const text =
    `Hello ${input.recipient},\n\n${subject}\nTime zone: ${input.timeZone}\n\n${input.message ?? ""}\n\n` +
    input.lines
      .map(
        (l) =>
          `${l.date} · ${l.subject} · ${l.assignment} · ${l.hours} · ${l.status}`,
      )
      .join('\n') +
    `\n\nDate-only source observations do not establish booked or worked hours.\nVersion: ${input.version}`;
  const rows = input.lines.length
    ? input.lines
        .map(
          (l) =>
            `<tr>${[l.date, l.subject, l.assignment, l.hours, l.status].map((v) => `<td style="padding:10px;border-bottom:1px solid #e2e8f0;vertical-align:top">${esc(v)}</td>`).join('')}</tr>`,
        )
        .join('')
    : '<tr><td colspan="5" style="padding:16px;color:#64748b">No published bookings or source-date observations in this window.</td></tr>';
  return {
    subject,
    text,
    html: shell({
      heading: input.board,
      bodyHtml: `<p>Hello ${esc(input.recipient)},</p>${input.message ? `<p>${esc(input.message)}</p>` : ""}<p>${esc(input.from)} – ${esc(input.through)} · ${esc(input.timeZone)}</p><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px"><thead><tr>${["Date", "Person or resource", "Assignment", "Hours", "Status"].map((h) => `<th align="left" style="padding:10px;background:#f1f5f9">${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table><p style="font-size:12px;color:#64748b">Date-only source observations do not establish booked or worked hours. Draft bookings are not included.</p>`,
      footer: `Schedule version ${input.version}. Contact your scheduler to request a change.`,
    }),
  };
}
