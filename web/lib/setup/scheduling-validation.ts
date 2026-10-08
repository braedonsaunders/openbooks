import 'server-only'
import { sql } from 'drizzle-orm'
import { lockAndCheckOrgFeature } from '@openbooks/engine/src/organization/org-feature-lock.ts'
import type { SetupEntityValidationHook } from './types'

const PEOPLE_VIEWS = new Set(['grid', 'targets', 'timeline', 'calendar'])
const TASK_VIEWS = new Set(['gantt', 'progress'])
const RANGE_DAYS = new Set([1, 3, 7, 14, 21, 28, 35, 42])

function list(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(String) : null
    } catch {
      return null
    }
  }
  return null
}

export const validateScheduleBoardWrite: SetupEntityValidationHook = async ({ body, executor, orgId, rowId }) => {
  let current: Record<string, unknown> = {}
  if (rowId) {
    current = (await executor.execute<Record<string, unknown>>(sql`select row_kind as "rowKind", views, default_view as "defaultView",
      resource_kind as "resourceKind", department_id as "departmentId", location_id as "locationId", range_days as "rangeDays", prefill_timesheets as "prefillTimesheets", prefill_crew_time as "prefillCrewTime",
      prefill_field_tickets as "prefillFieldTickets", notify_assignees as "notifyAssignees", subsidiary_id as "subsidiaryId", distribution_visibility as "distributionVisibility"
      from schedule_boards where org_id = ${orgId} and id = ${rowId}`)).rows[0] ?? {}
  }
  const merged = { ...current, ...body }
  const rowKind = String(merged.rowKind ?? 'people')
  const enabled = rowKind === 'people'
    ? await lockAndCheckOrgFeature(executor, orgId, 'hrm') && await lockAndCheckOrgFeature(executor, orgId, 'hrmShiftPlanning')
    : await lockAndCheckOrgFeature(executor, orgId, 'projects') && await lockAndCheckOrgFeature(executor, orgId, 'projectScheduling')
  if (!enabled) return `Enable ${rowKind === 'people' ? 'Human Resources and Scheduling' : 'Projects and Project Scheduling'} in Company Settings → Features before configuring this board.`
  if (rowKind === 'resources' && merged.resourceKind === 'equipment' && !await lockAndCheckOrgFeature(executor, orgId, 'equipment')) return 'Enable Equipment in Company Settings → Features before configuring an equipment board.'
  if (merged.distributionVisibility === 'board' && !merged.subsidiaryId) return 'Choose a legal entity before allowing whole-board schedule reports.'
  const views = list(merged.views) ?? []
  const allowedViews = rowKind === 'tasks' ? TASK_VIEWS : PEOPLE_VIEWS
  const foreign = views.filter((view) => !allowedViews.has(view))
  if (views.length === 0) return 'Choose at least one view for the board.'
  if (foreign.length) return `${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not available on a ${rowKind === 'tasks' ? 'task' : rowKind === 'resources' ? 'resource' : 'people'} board.`
  if (!views.includes(String(merged.defaultView ?? ''))) return 'The default view must be one of the board views.'
  if (!RANGE_DAYS.has(Number(merged.rangeDays))) return 'Show 1, 3, 7, 14, 21, 28, 35 or 42 days.'
  if (rowKind !== 'people' && [merged.prefillTimesheets, merged.prefillCrewTime, merged.prefillFieldTickets, merged.notifyAssignees].some((flag) => flag === true || flag === 'true')) {
    return 'Pre-fill and notification settings apply to people boards; turn them off for a task or resource board.'
  }
  if (rowKind === 'resources' && !['equipment', 'location'].includes(String(merged.resourceKind))) return 'Choose equipment units or locations for this resource board.'
  if (rowKind === 'resources' && (merged.departmentId || (merged.resourceKind === 'equipment' && merged.locationId))) return 'Resource boards use native legal-entity scope; equipment units have no department or location assignment.'
  if (body.cellColorRules !== undefined) {
    const rules = body.cellColorRules
    if (!Array.isArray(rules) || rules.length > 100) return 'Use at most 100 ordered color rules.'
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object' || !['bookingLabel', 'targetName', 'detail'].includes(rule.field) || !['equals', 'startsWith', 'contains'].includes(rule.match) || typeof rule.value !== 'string' || !rule.value.trim() || rule.value.length > 120 || typeof rule.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(rule.color)) return 'Each color rule needs a field, match, value and six-digit hex color.'
    }
  }
  for (const key of ['dayStarts', 'dayEnds'] as const) {
    if (merged[key] !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(String(merged[key]))) return 'Enter the working day as clock times such as 07:00 and 15:30.'
  }
  return null
}

export const validateScheduleCodeWrite: SetupEntityValidationHook = async ({ body, executor, orgId }) => {
  const people = await lockAndCheckOrgFeature(executor, orgId, 'hrm') && await lockAndCheckOrgFeature(executor, orgId, 'hrmShiftPlanning')
  const projects = await lockAndCheckOrgFeature(executor, orgId, 'projects') && await lockAndCheckOrgFeature(executor, orgId, 'projectScheduling')
  if (!people && !projects) return 'Enable Scheduling or Project Scheduling in Company Settings → Features before configuring booking codes.'
  if (body.code !== undefined && !/^[A-Z0-9][A-Z0-9/&+._-]{0,15}$/.test(String(body.code))) {
    return 'Codes are up to 16 capital letters, digits or / & + . _ -, such as TRAIN or SHOP.'
  }
  if (body.color !== undefined && !/^#[0-9a-f]{6}$/i.test(String(body.color))) return 'Enter the colour as a hex value such as #38bdf8.'
  return null
}
