import type { SetupEntity } from './types'

/**
 * Field-time Setup entities. Both are rehomed — geofences onto the
 * project page, kiosks onto the Timesheets setup surface — never a second
 * switchboard. Device tokens are issued and revoked through the kiosk API
 * (the raw token shows once); the registry never reads or writes the
 * token hash. Approval routing for timesheets and crew batches is authored
 * in Flows, not here.
 */

const GEOFENCE_KINDS = [
  { value: 'circle', labelKey: 'options.geofenceKind.circle' },
  { value: 'polygon', labelKey: 'options.geofenceKind.polygon' },
]

export const PROJECT_GEOFENCES_ENTITY: SetupEntity = {
  key: 'project-geofences',
  table: 'project_geofences',
  groupKey: 'projects',
  featureKey: 'fieldTime',
  rehomed: true, // section on the project page
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
  featureKey: 'fieldTime',
  rehomed: true, // section on the Timesheets setup surface
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
