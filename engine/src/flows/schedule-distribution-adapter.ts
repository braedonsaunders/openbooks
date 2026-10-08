import { sql } from 'drizzle-orm';
import type { FlowSubjectProfile } from '@openbooks/forms-core';
import { db, ambientTenantOrgId } from '../platform/db.ts';
import { tableScope } from './subject-scope.ts';
import { defineTableSubjectAdapter } from './table-subject-adapter.ts';
export const SCHEDULE_DISTRIBUTION_SUBJECT_KIND = 'schedule_distribution';
export const scheduleDistributionSubjectProfile: FlowSubjectProfile = {
  subjectKind: SCHEDULE_DISTRIBUTION_SUBJECT_KIND,
  label: 'Schedule distribution',
  triggers: ['on_submit', 'on_update', 'after_post'],
  actions: ['distribute_schedule'],
  statuses: [
    { value: 'previewed', label: 'Reviewed' },
    { value: 'queued', label: 'Queued for delivery' },
  ],
  fields: [
    { key: 'boardId', label: 'Board identity', type: 'text' },
    { key: 'boardCode', label: 'Board code', type: 'text' },
    {
      key: 'visibility',
      label: 'Report sharing',
      type: 'enum',
      options: [
        { value: 'personal', label: 'Personal reports' },
        { value: 'board', label: 'Whole-board reports' },
      ],
    },
    { key: 'boardName', label: 'Board', type: 'text' },
    { key: 'from', label: 'From date', type: 'date' },
    { key: 'through', label: 'Through date', type: 'date' },
    { key: 'version', label: 'Schedule version', type: 'text' },
    { key: 'status', label: 'Status', type: 'enum' },
    { key: 'recipientCount', label: 'Recipient count', type: 'number' },
  ],
};
export const scheduleDistributionsFlowAdapter = defineTableSubjectAdapter({
  subjectKind: SCHEDULE_DISTRIBUTION_SUBJECT_KIND,
  profile: scheduleDistributionSubjectProfile,
  permissions: {
    read: 'flows.manage',
    edit: 'flows.manage',
    approve: 'flows.manage',
  },
  scope: tableScope('column', 'schedule_distributions', 'subsidiary_id'),
  async loadContext(id) {
    const orgId = ambientTenantOrgId();
    if (!orgId)
      throw new Error(
        'Schedule distribution requires a native tenant context.',
      );
    const row = (
      await db.execute<{
        id: string;
        boardId: string;
        boardCode: string;
        visibility: string;
        boardName: string;
        from: string;
        through: string;
        version: string;
        status: string;
        createdBy: string;
        recipientCount: number;
      }>(
        sql`select d.id,d.board_id as "boardId",b.code as "boardCode",d.audience->>'visibility' as visibility,b.name as "boardName",d.from_date::text as "from",d.through_date::text as "through",d.version,d.status,d.created_by as "createdBy",(select count(distinct party_id)::int from schedule_distribution_recipients r where r.org_id=d.org_id and r.distribution_id=d.id) as "recipientCount" from schedule_distributions d join schedule_boards b on b.org_id=d.org_id and b.id=d.board_id where d.org_id=${orgId} and d.id=${id}`,
      )
    ).rows[0];
    return row
      ? {
          values: {
            id: row.id,
            boardId: row.boardId,
            boardCode: row.boardCode,
            visibility: row.visibility,
            boardName: row.boardName,
            from: row.from,
            through: row.through,
            version: row.version,
            status: row.status,
            recipientCount: row.recipientCount,
          },
          submitterUserId: row.createdBy,
          makerUserId: row.createdBy,
        }
      : null;
  },
  label: (_id, values) => `Schedule · ${values.boardName ?? ''}`,
  deepLink: (id) => `/scheduling?distribution=${encodeURIComponent(id)}`,
  async getStatus(id) {
    return (
      (
        await db.execute<{ status: string }>(
          sql`select status from schedule_distributions where id=${id}`,
        )
      ).rows[0]?.status ?? null
    );
  },
  async changeStatus() {
    throw new Error(
      'Schedule issuance is governed by Email reviewed schedule, not a status override.',
    );
  },
  async setField() {
    throw new Error(
      'Reviewed schedule reports are immutable; create a new preview.',
    );
  },
});
