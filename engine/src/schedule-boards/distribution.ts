import {
  schedulePdfLayoutSchema,
  type SchedulePdfLayout,
  automaticScheduleDeliverySchema,
} from "@openbooks/forms-core";
import { addCalendarDays } from "../platform/civil-date.ts";
import { roleUsers } from "../organization/role-members.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
/** Reviewed, version-bound schedule reports use native Flows and the durable email outbox. */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  scheduleDistributionEmail,
  normalizeEmailDeliveryInput,
  isValidEmailAddress,
  type ScheduleEmailLine,
} from '@openbooks/emails';
import { db, withOrgTransaction } from '../platform/db.ts';
import { canonicalJson } from '../platform/canonical-json.ts';
import { isUuid } from '../platform/uuid.ts';
import { lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts';
import { subsidiaryVisibleFilter } from '../organization/subsidiary-scope.ts';
import {
  resolveOrgEmailTransportDetailed,
  readOrgEmailConfigView,
} from '../delivery/email-config.ts';
import { enqueueFlowEmail } from '../delivery/outbox-enqueue.ts';
import { getBoard, boardAuthority, type ScheduleActor } from './boards.ts';
import { loadBoardWindow, type BoardWindow } from './window.ts';
import { ScheduleError, scheduleDatabaseRefusal } from './errors.ts';
import {
  resolvePeopleAudience,
  type ScheduleCohort,
} from "./distribution-audience.ts";
import { renderSchedulePdf } from "./distribution-report.ts";
import { dispatchScheduleDistribution } from "./distribution-hooks.ts";

export interface ScheduleAudience {
  visibility: 'personal' | 'board';
  recipientMode?: "automatic" | "selected" | "combined";
  everyone: boolean;
  subjectIds: readonly string[];
  cohort?: ScheduleCohort;
  additionalPartyIds?: readonly string[];
  additionalRoleKeys?: readonly string[];
  includePdf?: boolean;
  pdfLayout?: SchedulePdfLayout | null;
  message?: string;
}
export interface ScheduleRecipient {
  partyId: string;
  name: string;
  email: string | null;
  /** Exact native contacts represented by this mailbox; independent of report subjects. */
  contacts: readonly { id: string; name: string }[];
  subjects: readonly {
    id: string;
    kind: 'person' | 'equipment' | 'location';
    name: string;
    recipientPartyId?: string;
  }[];
  lines: readonly ScheduleEmailLine[];
}
export interface ScheduleDistributionPreview {
  boardId: string;
  boardName: string;
  organizationName: string;
  from: string;
  through: string;
  timeZone: string;
  /** Actual preview/issuance time, separate from the schedule date window. */
  generatedAt: string;
  version: string;
  audience: ScheduleAudience;
  recipients: readonly ScheduleRecipient[];
  refusals: readonly string[];
  excludedHistoricalSubjects?: readonly string[];
  /** Shared whole-board evidence is serialized once, not once per mailbox. */
  sharedLines?: readonly ScheduleEmailLine[];
}
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const refused = (message: string, remedy: string) =>
  new ScheduleError(message, { code: 'schedule_distribution_refused', remedy });

/** Published/native observations retain their own semantics; private notes are excluded and audience selection controls peer rows. */
export function scheduleRecipientLines(
  window: BoardWindow,
  subjects: ReadonlySet<string>,
): ScheduleEmailLine[] {
  const linked = new Set(
    (window.sourceRecords ?? []).flatMap((r) =>
      r.linkedEntryId ? [r.linkedEntryId] : [],
    ),
  );
  const names = new Map(window.rows.map((r) => [r.subjectId, r.name]));
  const lines: ScheduleEmailLine[] = [];
  for (const entry of window.entries)
    if (
      subjects.has(entry.subjectId) &&
      entry.status === 'published' &&
      entry.boardId === window.board.id &&
      !linked.has(entry.id)
    ) {
      const minutes = entry.workedMinutes;
      lines.push({
        date: entry.startsOn,
        subject: names.get(entry.subjectId) ?? '—',
        subjectId: entry.subjectId,
        assignment: [
          entry.target?.code ?? entry.target?.label ?? 'Unassigned',
          entry.detail,
        ]
          .filter(Boolean)
          .join(' / '),
        hours: `${Math.floor(minutes / 60)}h ${minutes % 60}m booked`,
        status: `Published booking · ${entry.startClock}–${entry.endClock}${entry.endsOn !== entry.startsOn ? ` (${entry.endsOn})` : ''}`,
      });
    }
  for (const record of window.sourceRecords ?? [])
    if (subjects.has(record.workerPartyId))
      lines.push({
        date: record.onDate,
        subject: names.get(record.workerPartyId) ?? '—',
        subjectId: record.workerPartyId,
        assignment: record.label ?? '—',
        hours: 'Hours unknown',
        status: 'Source date observation',
      });
  return lines.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.subject.localeCompare(b.subject) ||
      a.assignment.localeCompare(b.assignment) ||
      a.status.localeCompare(b.status),
  );
}

async function preview(
  actor: ScheduleActor,
  boardId: string,
  from: string,
  through: string,
  audience: ScheduleAudience,
): Promise<ScheduleDistributionPreview> {
  const board = await getBoard(actor, boardId);
  await boardAuthority(actor, board, 'read');
  // Recipient addresses and issuance belong to schedulers, never self-service readers.
  const allowed = await boardAuthority(actor, board, 'manage');
  if (!(await lockAndCheckOrgFeature(db, actor.orgId, 'flows')))
    throw refused(
      'Flows is switched off.',
      'Enable Flows in Company Settings → Features and configure an enabled Schedule distribution flow.',
    );
  if (
    !['personal', 'board'].includes(audience.visibility) ||
    typeof audience.everyone !== 'boolean' ||
    !Array.isArray(audience.subjectIds) ||
    audience.subjectIds.length > 500 ||
    audience.subjectIds.some((id) => !isUuid(id)) ||
    new Set(audience.subjectIds).size !== audience.subjectIds.length ||
    (audience.everyone && audience.subjectIds.length)
  )
    throw refused(
      'Choose everyone relevant or a distinct list of people/resources.',
      'Reload the recipient selector.',
    );
  if (
    audience.visibility === 'board' &&
    (board.distributionVisibility !== 'board' || board.subsidiaryId === null)
  )
    throw refused(
      'Whole-board report sharing is not configured for this board.',
      'In Board Settings choose a legal entity and allow whole-board reports before previewing this audience.',
    );
  const window = await loadBoardWindow({ ...actor, boardId, from, through });
  const relevant = new Set([
    ...window.entries
      .filter((e) => e.boardId === board.id && e.status === "published")
      .map((e) => e.subjectId),
    ...(window.sourceRecords ?? []).map((r) => r.workerPartyId),
    ...window.rows.filter((r) => r.inScope).map((r) => r.subjectId),
  ]);
  if (
    audience.pdfLayout != null &&
    !schedulePdfLayoutSchema.safeParse(audience.pdfLayout).success
  )
    throw refused(
      "Choose a valid native PDF page layout.",
      "Review paper size, orientation, spacing and report detail.",
    );
  const mode = audience.recipientMode ?? "automatic";
  if (!["automatic", "selected", "combined"].includes(mode))
    throw refused(
      "Choose a recipient selection mode.",
      "Choose automatic, selected contacts/subjects, or a combination.",
    );
  const roleKeys = audience.additionalRoleKeys ?? [];
  if (
    roleKeys.length > 20 ||
    roleKeys.some(
      (key) => typeof key !== "string" || !key.trim() || key.length > 80,
    ) ||
    new Set(roleKeys).size !== roleKeys.length ||
    (roleKeys.length && audience.visibility !== "board")
  )
    throw refused(
      "Additional native roles require whole-board sharing.",
      "Choose up to 20 distinct native application roles.",
    );
  const rolePartyIds: string[] = [];
  if (roleKeys.length) {
    await lockActorCommandAuthority(
      db,
      actor.orgId,
      actor.actorId,
      board.subsidiaryId,
      "flows.manage",
    );
    for (const role of roleKeys) {
      const users = await roleUsers(actor.orgId, role);
      if (!users.length)
        throw refused(
          `Native role ${role} has no active recipients.`,
          "Review the native role assignments or remove this additional recipient rule.",
        );
      const contacts = (
        await db.execute<{ id: string; userId: string }>(
          sql`select p.id,u.id as "userId" from users u join parties p on p.org_id=u.org_id and p.id=u.party_id join role_assignments ra on ra.org_id=u.org_id and ra.user_id=u.id join app_roles ar on ar.org_id=ra.org_id and ar.id=ra.role_id where u.org_id=${actor.orgId} and ar.key=${role} and u.id in(select jsonb_array_elements_text(${JSON.stringify(users.map((user) => user.id))}::jsonb)::uuid) and u.is_active and p.is_active and p.kind='person' ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowed)} order by u.id,p.id for share of u,p,ra,ar`,
        )
      ).rows;
      if (new Set(contacts.map(contact => contact.userId)).size !== users.length)
        throw refused(
          `Native role ${role} contains a user without a visible active People contact.`,
          "Link the native user to a visible People contact in the board legal entity, or choose explicit contacts instead.",
        );
      rolePartyIds.push(...contacts.map((contact) => contact.id));
    }
  }
  const explicitContacts = audience.additionalPartyIds ?? [];
  if (explicitContacts.length > 500 || explicitContacts.some(id => !isUuid(id)) || new Set(explicitContacts).size !== explicitContacts.length)
    throw refused("Choose distinct native additional contacts.", "Review the selected contact identities before previewing.");
  const extras = [
    ...new Set([...explicitContacts, ...rolePartyIds]),
  ];
  if (
    extras.length > 500 ||
    extras.some((id) => !isUuid(id)) ||
    new Set(extras).size !== extras.length ||
    (extras.length && audience.visibility !== "board") ||
    (audience.message !== undefined &&
      (typeof audience.message !== "string" ||
        audience.message.length > 4000)) ||
    (audience.includePdf !== undefined &&
      typeof audience.includePdf !== "boolean") ||
    (audience.cohort &&
      !["scope", "scheduled", "supervisors", "self"].includes(audience.cohort))
  )
    throw refused(
      "The report audience or additional contacts are invalid.",
      "Additional native contacts require an explicitly shared whole-board report.",
    );
  if (mode === "automatic" && extras.length)
    throw refused(
      "Automatic-only delivery does not include explicit contacts.",
      "Choose combined delivery or selected recipients.",
    );
  if (board.rowKind === "resources" && audience.cohort)
    throw refused("Employee cohorts apply only to people boards.", "Choose native resource-associated recipients or explicit contacts for this resource board.");
  const resolved =
    mode !== "selected" && board.rowKind === "people"
      ? await resolvePeopleAudience(
          actor,
          board,
          window,
          allowed,
          audience.cohort ?? "scope",
          audience.everyone ? null : audience.subjectIds,
        )
      : null;
  const ids =
    mode === "selected"
      ? [...audience.subjectIds].sort()
      : (resolved?.ids ??
        (audience.everyone
    ? [...relevant].sort()
          : [...audience.subjectIds].sort()));
  if (ids.length + extras.length === 0 || ids.length + extras.length > 500)
    throw refused(
      "Choose between 1 and 500 current native recipients.",
      "Choose explicit native contacts/subjects or configure a nonempty automatic audience.",
    );
  const rows = [...window.rows.filter((row) => ids.includes(row.subjectId))];
  const missing = ids.filter((id) => !rows.some((row) => row.subjectId === id));
  if (board.rowKind === "people" && missing.length && mode !== "selected") {
    const contacts = (
      await db.execute<{ id: string; name: string }>(
        sql`select id,display_name as name from parties where org_id=${actor.orgId} and is_active and kind='person' and id in(select jsonb_array_elements_text(${JSON.stringify(missing)}::jsonb)::uuid) ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed)}`,
      )
    ).rows;
    rows.push(
      ...contacts.map((person) => ({
        subjectId: person.id,
        subjectKind: "person" as const,
        name: person.name,
        shortCode: null,
        jobTitle: null,
        departmentId: null,
        departmentName: null,
        tradeName: null,
        inScope: false,
      })),
    );
  }
  if (rows.length !== ids.length)
    throw refused(
      "A selected schedule subject is unavailable or outside your visible board.",
      "Choose visible native people/resources, or explicitly shared contacts-only delivery.",
    );
  const bindings =
    board.rowKind === 'people'
      ? rows.map((r) => ({ subjectId: r.subjectId, partyId: r.subjectId }))
      : (
          await db.execute<{ subjectId: string; partyId: string }>(
            sql`select coalesce(equipment_unit_id,resource_location_id)::text as "subjectId",party_id as "partyId" from schedule_resource_recipients where org_id=${actor.orgId} and board_id=${board.id} and is_active and coalesce(equipment_unit_id,resource_location_id) in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`,
          )
        ).rows;
  const partyIds = [
    ...new Set([...bindings.map((binding) => binding.partyId), ...extras]),
  ];
  const parties = partyIds.length
    ? (
        await db.execute<{
          id: string;
          name: string;
          email: string | null;
          subsidiaryId: string | null;
        }>(
          sql`select id,display_name as name,email,subsidiary_id as "subsidiaryId" from parties where org_id=${actor.orgId} and is_active and id in (select jsonb_array_elements_text(${JSON.stringify(partyIds)}::jsonb)::uuid) ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed)} order by id for share`,
        )
      ).rows
    : [];
  const recipients: ScheduleRecipient[] = [];
  const refusals: string[] = [];
  for (const row of rows) {
    const binding = bindings.find((b) => b.subjectId === row.subjectId),
      party = parties.find((p) => p.id === binding?.partyId);
    if (!party) {
      refusals.push(
        board.rowKind === "people"
          ? `${row.name}: review the employee’s native People contact and current employee role/status.`
          : `${row.name}: choose an active native contact in Resource delivery contacts for this resource board.`,
      );
      continue;
    }
    const email = party.email?.trim() ?? null;
    const validEmail = email !== null && isValidEmailAddress(email);
    if (!validEmail)
      refusals.push(
        `${party.name}: enter a valid email on the native person/contact record.`,
      );
    let recipient = recipients.find((p) => p.partyId === party.id);
    if (!recipient) {
      recipient = {
        partyId: party.id,
        name: party.name,
        email,
        contacts: [{ id: party.id, name: party.name }],
        subjects: [],
        lines: [],
      };
      recipients.push(recipient);
    }
    (
      recipient.subjects as {
        id: string;
        kind: 'person' | 'equipment' | 'location';
        name: string;
      }[]
    ).push({ id: row.subjectId, kind: row.subjectKind, name: row.name });
  }
  for (const id of extras) {
    const party = parties.find((contact) => contact.id === id);
    if (!party)
      throw refused(
        "An explicit native contact is inactive or outside your visibility.",
        "Choose an active native People contact in the board legal entity.",
      );
    if (!isValidEmailAddress(party.email?.trim() ?? ""))
      refusals.push(
        `${party.name}: enter a valid email on the native People contact.`,
      );
    if (!recipients.some((recipient) => recipient.partyId === id))
      recipients.push({
        partyId: id,
        name: party.name,
        email: party.email?.trim() ?? null,
        contacts: [{ id, name: party.name }],
        subjects: [],
        lines: [],
      });
  }
  if (audience.visibility === 'board') {
    const subjectEntities = (
      await db.execute<{ id: string; subsidiaryId: string | null }>(
        board.rowKind === 'people'
          ? sql`select id,subsidiary_id as "subsidiaryId" from parties where org_id=${actor.orgId} and id in (select jsonb_array_elements_text(${JSON.stringify([...relevant])}::jsonb)::uuid)`
          : board.resourceKind === 'equipment'
            ? sql`select id,subsidiary_id as "subsidiaryId" from equipment_units where org_id=${actor.orgId} and id in (select jsonb_array_elements_text(${JSON.stringify([...relevant])}::jsonb)::uuid)`
            : sql`select id,subsidiary_id as "subsidiaryId" from locations where org_id=${actor.orgId} and id in (select jsonb_array_elements_text(${JSON.stringify([...relevant])}::jsonb)::uuid)`,
      )
    ).rows;
    if (
      subjectEntities.length !== relevant.size ||
      subjectEntities.some((s) => s.subsidiaryId !== board.subsidiaryId) ||
      parties.some((p) => p.subsidiaryId !== board.subsidiaryId)
    )
      throw refused(
        'The whole-board audience crosses the configured legal entity.',
        'Use personal reports, or a board and recipients scoped to one legal entity.',
      );
  }
  function reportLines(subjectIds: ReadonlySet<string>, reportRows: readonly { subjectId: string; name: string }[]) {
    const lines = scheduleRecipientLines(window, subjectIds);
    const observed = new Set(lines.map(line => `${line.subjectId}:${line.date}`));
    for (const row of reportRows)
      for (const day of window.days)
        if (!observed.has(`${row.subjectId}:${day.date}`))
          lines.push({ date: day.date, subjectId: row.subjectId, subject: row.name, assignment: "—", hours: "No booking recorded", status: "No schedule evidence" });
    return lines.sort((a, b) => a.date.localeCompare(b.date) || a.subject.localeCompare(b.subject) || (a.subjectId ?? "").localeCompare(b.subjectId ?? ""));
  }
  const sharedReport = audience.visibility === "board"
    ? reportLines(relevant, window.rows.filter(row => relevant.has(row.subjectId)))
    : null;
  for (const recipient of recipients)
    (recipient as { lines: ScheduleEmailLine[] }).lines = sharedReport ?? reportLines(new Set(recipient.subjects.map(subject => subject.id)), recipient.subjects.map(subject => ({ subjectId: subject.id, name: subject.name })));
  // One native mailbox owns one delivery; the preview retains all associated identities.
  for (let i = 0; i < recipients.length; i++)
    for (let j = recipients.length - 1; j > i; j--)
      if (
        recipients[i]!.email &&
        recipients[i]!.email!.trim().toLowerCase() ===
          recipients[j]!.email?.trim().toLowerCase()
      ) {
        const keep = recipients[i]!,
          other = recipients[j]!;
        (keep.contacts as { id: string; name: string }[]).push(
          ...other.contacts,
        );
        (
          keep.subjects as {
            id: string;
            kind: "person" | "equipment" | "location";
            name: string;
            recipientPartyId?: string;
          }[]
        ).push(
          ...other.subjects.map((subject) => ({
            ...subject,
            recipientPartyId: other.partyId,
          })),
        );
        if (!sharedReport) (keep as { lines: ScheduleEmailLine[] }).lines = [
          ...new Map([...keep.lines, ...other.lines].map(line => [canonicalJson(line), line])).values(),
        ];
        recipients.splice(j, 1);
      }
  if (
    recipients.some((r) => r.lines.length > 5000) ||
    Buffer.byteLength(
      JSON.stringify(
        audience.visibility === "board"
          ? {
              lines: recipients[0]?.lines ?? [],
              recipients: recipients.map((recipient) => ({
                ...recipient,
                lines: [],
              })),
            }
          : recipients,
      ),
      "utf8",
    ) >
      16 * 1024 * 1024
  )
    throw refused(
      'This reviewed report exceeds the bounded distribution size.',
      'Choose a shorter date window or fewer recipients; no report rows are silently omitted.',
    );
  for (const recipient of recipients)
    if (recipient.email) {
      const report = scheduleDistributionEmail({
        message: audience.message,
        recipient: recipient.name,
        board: board.name,
        from,
        through,
        timeZone: board.timeZone,
        version: 'preview',
        lines: recipient.lines,
      });
      try {
        normalizeEmailDeliveryInput({ to: recipient.email, ...report });
      } catch (error) {
        refusals.push(
          `${recipient.name}: ${error instanceof Error ? error.message : 'The report exceeds the native email limits.'}`,
        );
      }
    }
  recipients.sort((a, b) => a.partyId.localeCompare(b.partyId));
  const provider = await readOrgEmailConfigView(actor.orgId);
  const transport = await resolveOrgEmailTransportDetailed(actor.orgId);
  if (transport.state !== 'ready')
    refusals.push(
      'Configure an available outbound email provider in Company Settings → Email before sending.',
    );
  const organizationName = (
    await db.execute<{ name: string }>(
      sql`select name from orgs where id=${actor.orgId}`,
    )
  ).rows[0]!.name;
  const version = digest({
    organizationName,
    board: {
      id: board.id,
      name: board.name,
      timeZone: board.timeZone,
      subsidiaryId: board.subsidiaryId,
      distributionVisibility: board.distributionVisibility,
      automaticDeliveryPolicy: board.automaticDeliveryPolicy,
    },
    from,
    through,
    audience: {
      ...audience,
      visibility: audience.visibility,
      everyone: audience.everyone,
      subjectIds: ids,
    },
    recipients:
      audience.visibility === "board"
        ? recipients.map((recipient) => ({ ...recipient, lines: [] }))
        : recipients,
    sharedLines:
      audience.visibility === "board" ? recipients[0]?.lines : undefined,
    entries: window.entries
      .filter((entry) => entry.boardId === board.id)
      .map((e) => ({ id: e.id, revision: e.revision, status: e.status }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    sourceIds: (window.sourceRecords ?? []).map((r) => r.id).sort(),
    provider,
    allowed: allowed === null ? null : [...allowed].sort(),
  });
  return {
    boardId: board.id,
    boardName: board.name,
    organizationName,
    from,
    through,
    timeZone: board.timeZone,
    generatedAt: new Date().toISOString(),
    version,
    audience: {
      ...audience,
      visibility: audience.visibility,
      everyone: audience.everyone,
      subjectIds: audience.everyone ? [] : [...audience.subjectIds].sort(),
    },
    recipients,
    sharedLines:
      audience.visibility === "board" ? recipients[0]?.lines : undefined,
    refusals,
    excludedHistoricalSubjects: resolved?.excluded ?? [],
  };
}
export function previewScheduleDistribution(
  actor: ScheduleActor,
  boardId: string,
  from: string,
  through: string,
  audience: ScheduleAudience,
) {
  return withOrgTransaction(
    actor.orgId,
    () => preview(actor, boardId, from, through, audience),
    { isolationLevel: 'REPEATABLE READ' },
  );
}
interface RequestRow {
  id: string;
  boardId: string;
  from: string;
  through: string;
  version: string;
  audience: ScheduleAudience;
  reason: string;
  createdBy: string;
  status: 'previewed' | 'queued';
}
async function persist(
  actor: ScheduleActor,
  p: ScheduleDistributionPreview,
  reason: string,
  key: string,
): Promise<RequestRow> {
  if (!reason.trim() || reason.length > 2000 || !key.trim() || key.length > 200)
    throw refused(
      'A reason and bounded replay key are required.',
      'Enter why this schedule is being distributed and preview again.',
    );
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`schedule-distribution:${actor.orgId}:${p.boardId}:${p.version}`},0))`,
  );
  const existing = (
    await db.execute<RequestRow>(
      sql`select id,board_id as "boardId",from_date::text as "from",through_date::text as "through",version,audience,reason,created_by as "createdBy",status from schedule_distributions where org_id=${actor.orgId} and (replay_key=${key} or (board_id=${p.boardId} and version=${p.version} and status='queued' and replay_key not like 'automatic:%' and ${key} not like 'automatic:%')) for update`,
    )
  ).rows[0];
  if (existing) {
    if (
      existing.version !== p.version ||
      existing.createdBy !== actor.actorId ||
      existing.reason !== reason
    )
      throw refused(
        'This send key already belongs to a different review.',
        'Start a new preview/send intent.',
      );
    return existing;
  }
  const id = randomUUID();
  const inserted = (
    await db.execute(
      sql`insert into schedule_distributions(id,org_id,board_id,subsidiary_id,from_date,through_date,version,audience,reason,replay_key,created_by) select ${id},${actor.orgId},b.id,b.subsidiary_id,${p.from}::date,${p.through}::date,${p.version},${JSON.stringify(p.audience)}::jsonb,${reason},${key},${actor.actorId} from schedule_boards b where b.org_id=${actor.orgId} and b.id=${p.boardId} returning id`,
    )
  ).rows;
  if (inserted.length !== 1)
    throw refused(
      'The board changed while creating the report.',
      'Reload the board.',
    );
  const sharedPdf =
    p.audience.includePdf && p.audience.visibility === "board"
      ? await renderSchedulePdf(p, p.recipients[0]!)
      : null;
  for (const recipient of p.recipients) {
    const pdf = p.audience.includePdf
      ? (sharedPdf ?? (await renderSchedulePdf(p, recipient)))
      : null;
    const snapshots: [ScheduleRecipient["subjects"][number] | null, string][] =
      [
        ...recipient.subjects.map(
          (subject) =>
            [subject, subject.recipientPartyId ?? recipient.partyId] as [
              ScheduleRecipient["subjects"][number],
              string,
            ],
        ),
        ...recipient.contacts
          .filter(
            (contact) =>
              !recipient.subjects.some(
                (subject) =>
                  (subject.recipientPartyId ?? recipient.partyId) ===
                  contact.id,
              ),
          )
          .map((contact) => [null, contact.id] as [null, string]),
      ];
    for (const [subject, contactId] of snapshots) {
      const mail = scheduleDistributionEmail({
        message: p.audience.message,
        recipient: recipient.name,
        board: p.boardName,
        from: p.from,
        through: p.through,
        timeZone: p.timeZone,
        version: p.version,
        lines: recipient.lines,
      });
      const report = {
        ...mail,
        ...(pdf
          ? {
              attachments: [
                {
                  filename: "Schedule.pdf",
                  content: pdf.toString("base64"),
                  contentType: "application/pdf",
                },
              ],
            }
          : {}),
      };
      normalizeEmailDeliveryInput({
        to: recipient.email ?? "missing@example.invalid",
        ...report,
      });
      const written = (
        await db.execute(
          sql`insert into schedule_distribution_recipients(org_id,distribution_id,party_id,worker_party_id,equipment_unit_id,resource_location_id,email,report) values(${actor.orgId},${id},${contactId},${subject?.kind === "person" ? subject.id : null},${subject?.kind === "equipment" ? subject.id : null},${subject?.kind === "location" ? subject.id : null},${recipient.email},${JSON.stringify(report)}::jsonb) returning id`,
        )
      ).rows;
      if (written.length !== 1)
        throw new Error('The schedule recipient snapshot was not recorded.');
    }
    }
  await db.execute(
    sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${actor.orgId},'schedule_distributions',${id},'insert',${JSON.stringify({ after: { generatedAt: p.generatedAt, version: p.version, boardId: p.boardId, from: p.from, through: p.through, recipients: p.recipients.map((r) => ({ partyId: r.partyId, contacts: r.contacts, subjects: r.subjects.map((s) => s.id) })) }, reason })}::jsonb,${actor.actorId})`,
  );
  return {
    id,
    boardId: p.boardId,
    from: p.from,
    through: p.through,
    version: p.version,
    audience: p.audience,
    reason,
    createdBy: actor.actorId,
    status: 'previewed',
  };
}
async function deliveryReceipt(orgId: string, id: string, replayed: boolean) {
  const row = (
    await db.execute<{ runId: string; flowId: string }>(
      sql`select d.flow_run_id as "runId",r.flow_id as "flowId" from schedule_distributions d join flow_runs r on r.org_id=d.org_id and r.id=d.flow_run_id where d.org_id=${orgId} and d.id=${id} and d.status='queued'`,
    )
  ).rows[0];
  if (!row) throw new Error('The queued schedule has no native delivery run.');
  return { id, status: 'queued' as const, replayed, ...row };
}
export async function sendScheduleDistribution(
  actor: ScheduleActor,
  input: {
    boardId: string;
    from: string;
    through: string;
    audience: ScheduleAudience;
    version: string;
    reason: string;
    key: string;
  },
) {
  return withOrgTransaction(
    actor.orgId,
    async () => {
      if (input.key.startsWith("automatic:"))
        throw refused(
          "This key is reserved for native timer occurrences.",
          "Use a new manual send key.",
        );
      const board = await getBoard(actor, input.boardId);
      await boardAuthority(actor, board, 'manage');
      await db.execute(
        sql`select id from schedule_boards where org_id=${actor.orgId} and id=${board.id} for update`,
      );
      const prior = (
        await db.execute<RequestRow>(
          sql`select id,board_id as "boardId",from_date::text as "from",through_date::text as "through",version,audience,reason,created_by as "createdBy",status from schedule_distributions where org_id=${actor.orgId} and replay_key=${input.key} for update`,
        )
      ).rows[0];
      if (prior) {
        if (
          prior.createdBy !== actor.actorId ||
          prior.boardId !== input.boardId ||
          prior.from !== input.from ||
          prior.through !== input.through ||
          prior.version !== input.version ||
          prior.reason !== input.reason ||
          canonicalJson(prior.audience) !==
            canonicalJson({
              ...input.audience,
              visibility: input.audience.visibility,
              everyone: input.audience.everyone,
              subjectIds: [...input.audience.subjectIds].sort(),
            })
        )
          throw refused(
            'This send key belongs to a different reviewed intent.',
            'Start a new preview/send intent.',
          );
        if (prior.status === 'queued')
          return deliveryReceipt(actor.orgId, prior.id, true);
      }
      const p = await preview(
        actor,
        input.boardId,
        input.from,
        input.through,
        input.audience,
      );
      if (p.version !== input.version)
        throw refused(
          'The schedule or recipient configuration changed after preview.',
          'Preview the current version before sending.',
        );
      if (p.refusals.length)
        throw refused(
          p.refusals.join(' '),
          'Resolve the listed contact/provider configuration, then preview again.',
        );
      const request = await persist(actor, p, input.reason, input.key);
      if (request.status === 'queued')
        return deliveryReceipt(actor.orgId, request.id, true);
      const result = await dispatchScheduleDistribution({
        event: 'on_submit',
        requestId: request.id,
        actor,
      });
      const stored = (
        await db.execute<{ status: string }>(
          sql`select status from schedule_distributions where org_id=${actor.orgId} and id=${request.id}`,
        )
      ).rows[0];
      if (result.failed || !result.runs || stored?.status !== 'queued')
        throw refused(
          result.error ??
            'No enabled Schedule distribution flow queued this reviewed report.',
          'In Flows configure Schedule distribution → On submit → Email reviewed schedule. No emails were queued by this attempt.',
        );
      return deliveryReceipt(actor.orgId, request.id, false);
    },
    { isolationLevel: 'SERIALIZABLE' },
  ).catch((error) => {
    throw scheduleDatabaseRefusal(error);
  });
}

/** Called only by the native Flow effect with its real run; no direct transport send. */
export async function enqueueReviewedSchedule(input: {
  orgId: string;
  actorId: string;
  requestId: string;
  runId: string;
}): Promise<number> {
  const row = (
    await db.execute<RequestRow>(
      sql`select id,board_id as "boardId",from_date::text as "from",through_date::text as "through",version,audience,reason,created_by as "createdBy",status from schedule_distributions where org_id=${input.orgId} and id=${input.requestId} for update`,
    )
  ).rows[0];
  if (!row || row.createdBy !== input.actorId)
    throw refused(
      'The reviewed schedule does not belong to this actor.',
      'Open a new schedule preview with your own authorized identity.',
    );
  const actor = { orgId: input.orgId, actorId: input.actorId };
  const current = await preview(
    actor,
    row.boardId,
    row.from,
    row.through,
    row.audience,
  );
  if (current.version !== row.version || current.refusals.length)
    throw refused(
      'The reviewed schedule or contacts changed before delivery.',
      'Preview and explicitly send the current version.',
    );
  if (row.status === 'queued') return 0;
  const lineage = (
    await db.execute(
      sql`select id from flow_runs where org_id=${input.orgId} and id=${input.runId} and ((subject_kind='schedule_distribution' and subject_id=${row.id}) or (subject_kind='schedule_board' and subject_id=${row.boardId} and trigger='scheduled' and occurrence_key=${row.reason.startsWith("Automatic schedule occurrence ") ? row.reason.slice("Automatic schedule occurrence ".length) : ""})) and created_by=${input.actorId} for share`,
    )
  ).rows;
  if (lineage.length !== 1)
    throw refused(
      'The delivery run does not own this schedule review.',
      'Send through its native Schedule distribution flow.',
    );
  const recipients = (
    await db.execute<{
      id: string;
      email: string;
      partyId: string;
      report: {
        subject: string;
        html: string;
        text: string;
        attachments?: {
          filename: string;
          content: string;
          contentType: string;
        }[];
      };
    }>(
      sql`select id,email,party_id as "partyId",report from schedule_distribution_recipients where org_id=${input.orgId} and distribution_id=${row.id} order by id`,
    )
  ).rows;
  if (!recipients.length)
    throw new Error('The reviewed report has no recipients.');
  const distinct = new Map(
    recipients.map((r) => [r.email.trim().toLowerCase(), r]),
  );
  for (const recipient of distinct.values())
    await enqueueFlowEmail({
      orgId: input.orgId,
      runId: input.runId,
      occurrenceKey: `schedule:${row.id}:${recipient.partyId}`,
      payload: {
        to: [recipient.email],
        ...recipient.report,
        meta: {
          category: 'schedule_distribution',
          distributionId: row.id,
          version: row.version,
        },
      },
    });
  const updated = (
    await db.execute(
      sql`update schedule_distributions set status='queued',queued_at=now(),flow_run_id=${input.runId} where org_id=${input.orgId} and id=${row.id} and status='previewed' returning id`,
    )
  ).rows;
  if (updated.length !== 1)
    throw new Error('The reviewed schedule was not marked queued.');
  await db.execute(
    sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${input.orgId},'schedule_distributions',${row.id},'update',${JSON.stringify({ before: { status: 'previewed' }, after: { status: 'queued', flowRunId: input.runId, recipientReports: recipients.length, version: row.version }, reason: row.reason })}::jsonb,${input.actorId})`,
  );
  return distinct.size;
}
/** Enabled native Flows decide whether publish/update events distribute; installation activates nothing. */
export async function prepareScheduleLifecycle(
  actor: ScheduleActor,
  boardId: string,
  from: string,
  through: string,
  event: 'on_update' | 'after_post',
  occurrence: string,
  subjectIds: readonly string[],
) {
  const board = await getBoard(actor, boardId);
  const window = await loadBoardWindow({ ...actor, boardId, from, through });
  const relevant = [
    ...new Set([
      ...subjectIds,
      ...window.entries
        .filter((e) => e.status === 'published')
        .map((e) => e.subjectId),
      ...(window.sourceRecords ?? []).map((r) => r.workerPartyId),
    ]),
  ].sort();
  const p = await preview(actor, boardId, from, through, {
    visibility: board.distributionVisibility === 'board' ? 'board' : 'personal',
    everyone: false,
    subjectIds: relevant,
  });
  const row = await persist(
    actor,
    p,
    `Schedule ${event === 'after_post' ? 'publication' : 'update'}`,
    `event:${digest(occurrence)}`,
  );
  return dispatchScheduleDistribution({ event, requestId: row.id, actor });
}

/** Timers prepare a fresh report under the configured native operator; manual reviewed intents remain separate. */
export async function deliverAutomaticSchedule(input: {
  orgId: string;
  boardId: string;
  runId: string;
  operatorId: string;
  occurrence: {
    nodeId: string;
    occurredAt: string;
    key: string;
    timeZone?: string;
  };
}) {
  return withOrgTransaction(input.orgId, async () => {
    const actor = { orgId: input.orgId, actorId: input.operatorId };
    const active = (
      await db.execute(
        sql`select id from users where org_id=${input.orgId} and id=${input.operatorId} and is_active for share`,
      )
    ).rows;
    if (active.length !== 1)
      throw refused(
        "The automatic delivery operator is inactive or unavailable.",
        "Configure an active authorized operator in Board Settings.",
      );
    // Serialize issuance with board policy changes before resolving current recipients.
    const lockedBoard = (await db.execute(sql`select id from schedule_boards where org_id=${input.orgId} and id=${input.boardId} for update`)).rows;
    if (lockedBoard.length !== 1) throw refused("The schedule board is unavailable.", "Choose an active board in your organization.");
    const board = await getBoard(actor, input.boardId);
    if (!board.isActive)
      throw refused(
        "This board is archived.",
        "Restore the board or disable its native delivery Flow.",
      );
    await boardAuthority(actor, board, "manage");
    await lockActorCommandAuthority(
      db,
      input.orgId,
      input.operatorId,
      board.subsidiaryId,
      "flows.manage",
    );
    const policy = automaticScheduleDeliverySchema.parse(
      board.automaticDeliveryPolicy,
    );
    if (policy.operatorId !== input.operatorId)
      throw refused(
        "The configured delivery operator changed.",
        "Review the Flow occurrence and current board policy.",
      );
    if (
      input.occurrence.timeZone !== policy.timeZone ||
      policy.timeZone !== board.timeZone
    )
      throw refused(
        "The Flow timer and report use different time zones.",
        "Set the Flow trigger timezone to the board delivery policy timezone.",
      );
    const lineage = (
      await db.execute(
        sql`select r.id from flow_runs r join flows f on f.org_id=r.org_id and f.id=r.flow_id where r.org_id=${input.orgId} and r.id=${input.runId} and r.subject_kind='schedule_board' and r.subject_id=${board.id} and r.trigger='scheduled' and r.occurrence_key=${input.occurrence.key} and r.created_by=${input.operatorId} and r.context->>'deliveryPolicyVersion'=${digest(board.automaticDeliveryPolicy)} and r.context->'scheduledOccurrence'=${JSON.stringify(input.occurrence)}::jsonb and f.enabled for share of r,f`,
      )
    ).rows;
    if (lineage.length !== 1)
      throw refused(
        "This report does not belong to the native timer run.",
        "Use the authored Schedule board delivery Flow.",
      );
    const instant = new Date(input.occurrence.occurredAt);
    if (!Number.isFinite(instant.getTime()))
      throw refused(
        "The scheduled occurrence date is invalid.",
        "Review the native timer occurrence.",
      );
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: policy.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    let from = `${part("year")}-${part("month")}-${part("day")}`;
    if (policy.anchor === "week")
      from = addCalendarDays(
        from,
        -(
          (new Date(`${from}T00:00:00Z`).getUTCDay() -
            policy.weekStartsOn +
            7) %
          7
        ),
      );
    const through = addCalendarDays(from, policy.days - 1);
    const key = `automatic:${digest(input.occurrence.key)}`;
    const prior = (
      await db.execute<{ id: string; status: string }>(
        sql`select id,status from schedule_distributions where org_id=${input.orgId} and replay_key=${key} for update`,
      )
    ).rows[0];
    if (prior?.status === "queued") return 0;
    const p = await preview(actor, board.id, from, through, {
      visibility: policy.visibility,
      recipientMode: policy.recipientMode,
      everyone: policy.recipientMode !== "selected",
      subjectIds: policy.subjectIds,
      cohort: policy.cohort,
      additionalPartyIds: policy.additionalPartyIds,
      additionalRoleKeys: policy.additionalRoleKeys,
      includePdf: policy.includePdf,
      pdfLayout: policy.pdfLayout,
      message: policy.message,
    });
    if (p.refusals.length)
      throw refused(
        p.refusals.join(" "),
        "Correct native People contact email/provider/scope settings and review this failed Flow occurrence.",
      );
    const request = await persist(
      actor,
      p,
      `Automatic schedule occurrence ${input.occurrence.key}`,
      key,
    );
    return enqueueReviewedSchedule({
      orgId: input.orgId,
      actorId: input.operatorId,
      requestId: request.id,
      runId: input.runId,
    });
  });
}

export async function searchScheduleContacts(
  actor: ScheduleActor,
  boardId: string,
  query: string,
) {
  return withOrgTransaction(actor.orgId, async () => {
    const board = await getBoard(actor, boardId);
    const allowed = await boardAuthority(actor, board, "manage");
    const contacts = (
      await db.execute<{ id: string; name: string; email: string | null }>(
        sql`select id,display_name as name,email from parties where org_id=${actor.orgId} and kind='person' and is_active and display_name ilike ${`%${query.replace(/[\\%_]/g, "\\$&")}%`} ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed)} ${board.subsidiaryId ? sql`and subsidiary_id=${board.subsidiaryId}` : sql``} order by display_name,id limit 101`,
      )
    ).rows;
    const roles = (await actorHasPermission(
      db,
      actor.orgId,
      actor.actorId,
      "flows.manage",
    ))
      ? (
          await db.execute<{ key: string; name: string }>(
            sql`select key,name from app_roles where org_id=${actor.orgId} order by name,key`,
          )
        ).rows
      : [];
    return {
      contacts: contacts.slice(0, 100),
      more: contacts.length > 100,
      roles,
    };
  });
}
export async function previewSchedulePdf(
  actor: ScheduleActor,
  input: {
    boardId: string;
    from: string;
    through: string;
    audience: ScheduleAudience;
    version: string;
    partyId: string;
  },
) {
  return withOrgTransaction(
    actor.orgId,
    async () => {
      const p = await preview(
        actor,
        input.boardId,
        input.from,
        input.through,
        input.audience,
      );
      if (p.version !== input.version)
        throw refused(
          "The report changed after preview.",
          "Preview its current audience and version again.",
        );
      const recipient = p.recipients.find((r) => r.partyId === input.partyId);
      if (!recipient)
        throw refused(
          "This contact is outside the reviewed report audience.",
          "Choose a recipient from this preview.",
        );
      return renderSchedulePdf(p, recipient);
    },
    { isolationLevel: "REPEATABLE READ" },
  );
}

/** The operator sees exact contacts while a shared report travels once across the API boundary. */
export function serializeSchedulePreview(
  preview: ScheduleDistributionPreview,
): ScheduleDistributionPreview {
  return preview.audience.visibility === "board"
    ? {
        ...preview,
        sharedLines: preview.recipients[0]?.lines ?? [],
        recipients: preview.recipients.map((recipient) => ({
          ...recipient,
          lines: [],
        })),
      }
    : preview;
}
