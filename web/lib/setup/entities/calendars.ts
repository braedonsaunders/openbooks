/** Setup-registry business calendar and aging policy entities (Company group). */
import type { SetupEntity } from '../types'
import { ISO_WEEKDAYS } from '../options'

export const CALENDAR_ENTITIES: SetupEntity[] = [
  {
    // The organization's business calendar: ISO week start, weekend days, and
    // the country whose statutory holidays apply, effective-dated per
    // organization with an optional per-subsidiary override. A row without a
    // subsidiary is the org-wide fallback where an entity has no own row.
    key: 'business-calendars',
    table: 'org_business_calendars',
    singularTitleKey: 'entities.business-calendars.singularTitle',
    actorCols: true,
    groupKey: 'company',
    iconKey: 'calendar',
    orgScoped: true,
    orderBy: 'effective_from desc',
    hasActive: true,
    // Versions are immutable: closing the window or deactivating stays
    // possible, rewriting a version's facts takes a new version (enforced in
    // validation and by the table's history guard).
    allowDelete: false,
    docSlug: 'company-setup',
    columns: [
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'weekStartsOn', kind: 'text', options: ISO_WEEKDAYS },
      { key: 'holidayCountry', kind: 'text' },
      { key: 'holidayRegion', kind: 'text' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries', lockedOnEdit: true },
      { key: 'weekStartsOn', kind: 'select', options: ISO_WEEKDAYS, required: true, lockedOnEdit: true },
      // ISO weekdays as JSON (for example [6, 7]); an empty list states
      // explicitly that no weekday is a weekend day.
      { key: 'weekendDays', kind: 'json', required: true, helpTextKey: 'fieldHelp.businessCalendarWeekendDays', lockedOnEdit: true },
      { key: 'holidayCountry', kind: 'country', helpTextKey: 'fieldHelp.businessCalendarHolidayCountry', lockedOnEdit: true },
      { key: 'holidayRegion', kind: 'text', helpTextKey: 'fieldHelp.businessCalendarHolidayRegion', lockedOnEdit: true },
      { key: 'effectiveFrom', kind: 'date', required: true, lockedOnEdit: true },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // The ascending day boundaries that turn days-past-due into bucket
    // indexes, effective-dated per organization. With no policy configured,
    // readers use the declared 30/60/90 default, never a per-screen ladder.
    key: 'aging-bucket-policies',
    table: 'aging_bucket_policies',
    singularTitleKey: 'entities.aging-bucket-policies.singularTitle',
    actorCols: true,
    groupKey: 'company',
    iconKey: 'timer',
    orgScoped: true,
    orderBy: 'effective_from desc',
    hasActive: true,
    // Ladder versions are immutable; only the window and activity stay
    // editable (enforced in validation and by the table's history guard).
    allowDelete: false,
    docSlug: 'company-setup',
    columns: [
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      // Ascending day counts as JSON (for example [30, 60, 90]); the
      // final boundary opens the last bucket, so 90 is already 90+.
      { key: 'boundaries', kind: 'json', required: true, helpTextKey: 'fieldHelp.agingBucketBoundaries', lockedOnEdit: true },
      { key: 'effectiveFrom', kind: 'date', required: true, lockedOnEdit: true },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
]
