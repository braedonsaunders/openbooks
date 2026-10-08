/** Native parties own contact details; a board stores only governed resource associations. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withOrgTransaction } from '../platform/db.ts';
import { isUuid } from '../platform/uuid.ts';
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts';
import { getBoard, boardAuthority, type ScheduleActor } from './boards.ts';
import { ScheduleError, scheduleDatabaseRefusal } from './errors.ts';
interface ResourceRecipientInput {
  boardId: string;
  equipmentUnitId: string | null;
  resourceLocationId: string | null;
  partyId: string;
  reason: string;
  isActive: boolean;
}
export async function saveResourceRecipient(
  actor: ScheduleActor,
  input: ResourceRecipientInput & { id?: string; expectedRevision?: number },
) {
  return withOrgTransaction(actor.orgId, async () => {
    if (
      !isUuid(input.boardId) ||
      !isUuid(input.partyId) ||
      (!isUuid(input.equipmentUnitId) && !isUuid(input.resourceLocationId)) ||
      Boolean(input.equipmentUnitId) === Boolean(input.resourceLocationId) ||
      !input.reason.trim() ||
      input.reason.length > 2000 ||
      typeof input.isActive !== 'boolean'
    )
      throw new ScheduleError(
        'Choose one native resource and contact, and enter a reason.',
      );
    if (
      input.id !== undefined &&
      (!isUuid(input.id) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        Number(input.expectedRevision) < 1)
    )
      throw new ScheduleError(
        'Choose the existing resource association and its current revision.',
        { status: 409, remedy: 'Reload its native settings drawer.' },
      );
    const board = await getBoard(actor, input.boardId);
    const allowed = await boardAuthority(actor, board, 'manage');
    await lockActorCommandAuthority(
      db,
      actor.orgId,
      actor.actorId,
      board.subsidiaryId,
      'admin.setup.manage',
    );
    if (
      board.rowKind !== 'resources' ||
      Boolean(input.equipmentUnitId) !== (board.resourceKind === 'equipment')
    )
      throw new ScheduleError(
        'The resource must match the selected board kind.',
      );
    const resource = (
      await db.execute<{ subsidiaryId: string | null }>(
        input.equipmentUnitId
          ? sql`select subsidiary_id as "subsidiaryId" from equipment_units where org_id=${actor.orgId} and id=${input.equipmentUnitId} for share`
          : sql`select subsidiary_id as "subsidiaryId" from locations where org_id=${actor.orgId} and id=${input.resourceLocationId} for share`,
      )
    ).rows[0];
    const party = (
      await db.execute<{ subsidiaryId: string | null; active: boolean }>(
        sql`select subsidiary_id as "subsidiaryId",is_active as active from parties where org_id=${actor.orgId} and id=${input.partyId} and kind='person' for share`,
      )
    ).rows[0];
    if (
      !resource ||
      !party ||
      (input.isActive && !party.active) ||
      resource.subsidiaryId !== party.subsidiaryId ||
      (board.subsidiaryId !== null &&
        board.subsidiaryId !== resource.subsidiaryId) ||
      (allowed !== null &&
        (resource.subsidiaryId === null || !allowed.has(resource.subsidiaryId)))
    )
      throw new ScheduleError(
        'Choose a visible resource and native person/contact in the same legal entity.',
        {
          remedy:
            'Review the board scope and the resource/contact legal entities. No association was changed.',
        },
      );
    const id = input.id ?? randomUUID();
    const before = input.id
      ? (
          await db.execute<Record<string, unknown>>(
            sql`select * from schedule_resource_recipients where org_id=${actor.orgId} and id=${id} for update`,
          )
        ).rows[0]
      : null;
    if (
      input.id &&
      (!before ||
        before.board_id !== input.boardId ||
        before.equipment_unit_id !== input.equipmentUnitId ||
        before.resource_location_id !== input.resourceLocationId ||
        before.revision !== input.expectedRevision)
    )
      throw new ScheduleError(
        'The resource association changed or is unavailable.',
        {
          status: 409,
          remedy:
            'Reload the board recipient settings; resource identity cannot be rehomed by an edit.',
        },
      );
    const saved = input.id
      ? (
          await db.execute(
            sql`update schedule_resource_recipients set party_id=${input.partyId},reason=${input.reason},is_active=${input.isActive},revision=revision+1,updated_at=now(),updated_by=${actor.actorId} where org_id=${actor.orgId} and id=${id} and revision=${input.expectedRevision} returning *`,
          )
        ).rows
      : (
          await db.execute(
            sql`insert into schedule_resource_recipients(id,org_id,board_id,equipment_unit_id,resource_location_id,party_id,subsidiary_id,reason,is_active,created_by,updated_by) values(${id},${actor.orgId},${input.boardId},${input.equipmentUnitId},${input.resourceLocationId},${input.partyId},${resource.subsidiaryId},${input.reason},${input.isActive},${actor.actorId},${actor.actorId}) returning *`,
          )
        ).rows;
    if (saved.length !== 1)
      throw new ScheduleError('The resource association was not saved.', {
        status: 409,
        remedy: 'Reload its current revision.',
      });
    await db.execute(
      sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${actor.orgId},'schedule_resource_recipients',${id},${before ? 'update' : 'insert'},${JSON.stringify({ before, after: saved[0], reason: input.reason })}::jsonb,${actor.actorId})`,
    );
    return { id, record: saved[0] };
  }).catch((error) => {
    throw scheduleDatabaseRefusal(error);
  });
}
