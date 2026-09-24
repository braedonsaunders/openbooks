import type { SetupEntity } from './registry'

/**
 * HR-20 field-time Setup entities. All three are rehomed — geofences
 * onto the project page, kiosks and approval stages onto the Timesheets
 * setup surface — never a second switchboard. Device tokens are issued
 * and revoked through the kiosk API (the raw token shows once); the
 * registry never reads or writes the token hash. Stage chains are
 * validated structures edited through the Timesheets setup API, with
 * the registry carrying the subject row only.
 */

const GEOFENCE_KINDS = [
  { value: 'circle', labelKey: 'options.geofenceKind.circle' },
  { value: 'polygon', labelKey: 'options.geofenceKind.polygon' },
]

const STAGE_SUBJECTS = [
  { value: 'timesheet_week', labelKey: 'options.approvalSubject.timesheetWeek' },
  { value: 'crew_time_batch', labelKey: 'options.approvalSubject.crewTimeBatch' },
]

export const PROJECT_GEOFENCES_ENTITY: SetupEntity = {
  key: 'project-geofences',
  table: 'project_geofences',
  groupKey: 'projects',
  featureKey: 'fieldTimeGeofence',
  rehomed: true, // section on the project page
  rehomedTo: '/projects',
  iconKey: 'map-pin',
  orgScoped: true,
  actorCols: true,
  orderBy: 'created_at',
  hasActive: true,
  docSlug: 'field-clock-in',
  columns: [
    { key: 'projectId', kind: 'ref', ref: 'projects' },
    { key: 'kind', kind: 'badge', options: GEOFENCE_KINDS },
    { key: 'radiusM', kind: 'number' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'projectId', kind: 'ref', ref: 'projects', required: true, lockedOnEdit: true },
    { key: 'kind', kind: 'select', required: true, lockedOnEdit: true, options: GEOFENCE_KINDS },
    { key: 'center', kind: 'json' },
    { key: 'radiusM', kind: 'integer' },
    { key: 'polygon', kind: 'json' },
    { key: 'isActive', kind: 'boolean' },
  ],
}

export const TIME_KIOSKS_ENTITY: SetupEntity = {
  key: 'time-kiosks',
  table: 'time_kiosks',
  groupKey: 'workforce',
  featureKey: 'fieldTimeKiosk',
  rehomed: true, // section on the Timesheets setup surface
  rehomedTo: '/time/setup',
  iconKey: 'tablet',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'name',
  hasActive: true,
  docSlug: 'field-clock-in',
  columns: [
    { key: 'name', kind: 'text' },
    { key: 'projectId', kind: 'ref', ref: 'projects' },
    { key: 'pinRequired', kind: 'boolean' },
    { key: 'photoRequired', kind: 'boolean' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'name', kind: 'text', required: true },
    { key: 'locationId', kind: 'ref', ref: 'locations' },
    { key: 'projectId', kind: 'ref', ref: 'projects' },
    { key: 'pinRequired', kind: 'boolean' },
    { key: 'photoRequired', kind: 'boolean' },
    { key: 'isActive', kind: 'boolean' },
  ],
}

export const TIME_APPROVAL_STAGES_ENTITY: SetupEntity = {
  key: 'time-approval-stages',
  table: 'time_approval_stages',
  groupKey: 'workforce',
  featureKey: 'fieldTimeMultiStageApproval',
  rehomed: true, // section on the Timesheets setup surface
  rehomedTo: '/time/setup',
  iconKey: 'git-branch',
  orgScoped: true,
  actorCols: true,
  orderBy: 'subject_kind',
  hasActive: false,
  docSlug: 'crew-time-entry',
  columns: [
    { key: 'subjectKind', kind: 'badge', options: STAGE_SUBJECTS },
  ],
  fields: [
    { key: 'subjectKind', kind: 'select', required: true, lockedOnEdit: true, options: STAGE_SUBJECTS },
    { key: 'stages', kind: 'json', required: true },
  ],
}
