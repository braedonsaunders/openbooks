/** Reviewed, version-bound schedule reports use native Flows and the durable email outbox. */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  scheduleDistributionEmail,
  normalizeEmailDeliveryInput,
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
import { dispatchScheduleDistribution } from './distribution-hooks.ts';

export interface ScheduleAudience {
  visibility: 'personal' | 'board';
  everyone: boolean;
  subjectIds: readonly string[];
}
export interface ScheduleRecipient {
  partyId: string;
  name: string;
  email: string | null;
  subjects: readonly {
    id: string;
    kind: 'person' | 'equipment' | 'location';
    name: string;
  }[];
  lines: readonly ScheduleEmailLine[];
}
export interface ScheduleDistributionPreview {
  boardId: string;
  boardName: string;
  from: string;
  through: string;
  timeZone: string;
  version: string;
  audience: ScheduleAudience;
  recipients: readonly ScheduleRecipient[];
  refusals: readonly string[];
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
      !linked.has(entry.id)
    ) {
      const minutes = entry.workedMinutes;
      lines.push({
        date: entry.startsOn,
        subject: names.get(entry.subjectId) ?? '—',
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
      .filter((e) => e.status === 'published')
      .map((e) => e.subjectId),
    ...(window.sourceRecords ?? []).map((r) => r.workerPartyId),
  ]);
  const ids = audience.everyone
    ? [...relevant].sort()
    : [...audience.subjectIds].sort();
  if (ids.length === 0 || ids.length > 500)
    throw refused(
      'Choose between 1 and 500 relevant people/resources.',
      'Select a smaller date window or explicit recipients.',
    );
  const rows = window.rows.filter((r) => ids.includes(r.subjectId));
  if (rows.length !== ids.length)
    throw refused(
      'A selected person/resource is not a visible member of this board window.',
      'Reload the preview and choose native subjects in the addressed board and date window.',
    );
  const bindings =
    board.rowKind === 'people'
      ? rows.map((r) => ({ subjectId: r.subjectId, partyId: r.subjectId }))
      : (
          await db.execute<{ subjectId: string; partyId: string }>(
            sql`select coalesce(equipment_unit_id,resource_location_id)::text as "subjectId",party_id as "partyId" from schedule_resource_recipients where org_id=${actor.orgId} and board_id=${board.id} and is_active and coalesce(equipment_unit_id,resource_location_id) in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`,
          )
        ).rows;
  const partyIds = [...new Set(bindings.map((b) => b.partyId))];
  const parties = partyIds.length
    ? (
        await db.execute<{
          id: string;
          name: string;
          email: string | null;
          subsidiaryId: string | null;
        }>(
          sql`select id,display_name as name,email,subsidiary_id as "subsidiaryId" from parties where org_id=${actor.orgId} and is_active and id in (select jsonb_array_elements_text(${JSON.stringify(partyIds)}::jsonb)::uuid) ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed)}`,
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
        `${row.name}: choose an active, visible native contact in Board resource recipients${board.rowKind === 'people' ? ' or review the employee’s native contact/status' : ''}.`,
      );
      continue;
    }
    const email = party.email?.trim() ?? null;
    let validEmail = Boolean(email);
    if (email)
      try {
        normalizeEmailDeliveryInput({
          to: email,
          subject: 'Schedule',
          html: '',
          text: '',
        });
      } catch {
        validEmail = false;
      }
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
  for (const recipient of recipients)
    (recipient as { lines: ScheduleEmailLine[] }).lines =
      scheduleRecipientLines(
        window,
        audience.visibility === 'board'
          ? relevant
          : new Set(recipient.subjects.map((s) => s.id)),
      );
  if (
    recipients.some((r) => r.lines.length > 5000) ||
    Buffer.byteLength(JSON.stringify(recipients), 'utf8') > 16 * 1024 * 1024
  )
    throw refused(
      'This reviewed report exceeds the bounded distribution size.',
      'Choose a shorter date window or fewer recipients; no report rows are silently omitted.',
    );
  for (const recipient of recipients)
    if (recipient.email) {
      const report = scheduleDistributionEmail({
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
  const version = digest({
    board: {
      id: board.id,
      name: board.name,
      timeZone: board.timeZone,
      subsidiaryId: board.subsidiaryId,
      distributionVisibility: board.distributionVisibility,
    },
    from,
    through,
    audience: {
      visibility: audience.visibility,
      everyone: audience.everyone,
      subjectIds: ids,
    },
    recipients,
    entries: window.entries
      .map((e) => ({ id: e.id, revision: e.revision, status: e.status }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    sourceIds: (window.sourceRecords ?? []).map((r) => r.id).sort(),
    provider,
    allowed: allowed === null ? null : [...allowed].sort(),
  });
  return {
    boardId: board.id,
    boardName: board.name,
    from,
    through,
    timeZone: board.timeZone,
    version,
    audience: {
      visibility: audience.visibility,
      everyone: audience.everyone,
      subjectIds: audience.everyone ? [] : ids,
    },
    recipients,
    refusals,
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
      sql`select id,board_id as "boardId",from_date::text as "from",through_date::text as "through",version,audience,reason,created_by as "createdBy",status from schedule_distributions where org_id=${actor.orgId} and (replay_key=${key} or (board_id=${p.boardId} and version=${p.version} and status='queued')) for update`,
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
  for (const recipient of p.recipients)
    for (const subject of recipient.subjects) {
      const mail = scheduleDistributionEmail({
        recipient: recipient.name,
        board: p.boardName,
        from: p.from,
        through: p.through,
        timeZone: p.timeZone,
        version: p.version,
        lines: recipient.lines,
      });
      const written = (
        await db.execute(
          sql`insert into schedule_distribution_recipients(org_id,distribution_id,party_id,worker_party_id,equipment_unit_id,resource_location_id,email,report) values(${actor.orgId},${id},${recipient.partyId},${subject.kind === 'person' ? subject.id : null},${subject.kind === 'equipment' ? subject.id : null},${subject.kind === 'location' ? subject.id : null},${recipient.email},${JSON.stringify(mail)}::jsonb) returning id`,
        )
      ).rows;
      if (written.length !== 1)
        throw new Error('The schedule recipient snapshot was not recorded.');
    }
  await db.execute(
    sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${actor.orgId},'schedule_distributions',${id},'insert',${JSON.stringify({ after: { version: p.version, boardId: p.boardId, from: p.from, through: p.through, recipients: p.recipients.map((r) => ({ partyId: r.partyId, subjects: r.subjects.map((s) => s.id) })) }, reason })}::jsonb,${actor.actorId})`,
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
      sql`select id from flow_runs where org_id=${input.orgId} and id=${input.runId} and subject_kind='schedule_distribution' and subject_id=${row.id} and created_by=${input.actorId} for share`,
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
      report: { subject: string; html: string; text: string };
    }>(
      sql`select id,email,party_id as "partyId",report from schedule_distribution_recipients where org_id=${input.orgId} and distribution_id=${row.id} order by id`,
    )
  ).rows;
  if (!recipients.length)
    throw new Error('The reviewed report has no recipients.');
  const distinct = new Map(recipients.map((r) => [r.partyId, r]));
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
