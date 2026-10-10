import type { SetupEntity, SetupField } from '../types';
const label = (key: string) => `workCalendars.${key}`;
const field = (key: string, kind: SetupField['kind'], extra: Partial<SetupField> = {}): SetupField => ({ key, kind, labelKey: label(key), ...extra });
export const WORK_CALENDARS_ENTITY: SetupEntity = {
  key: 'work-calendars', table: 'schedule_calendars', groupKey: 'projects', iconKey: 'calendar', orgScoped: true,
  actorCols: true, hasActive: false, orderBy: 'name', allowDelete: false, importVia: 'none',
  featureKeysAny: ['manufacturing', 'projectScheduling'], drawerSize: 'lg',
  mutationPath: '/api/work-calendars', mutationRevision: { requestKey: 'expectedRevision', rowColumn: 'revision', format: 'token' },
  mutationCreateKeys: ['name', 'description', 'isDefault', 'workingDays', 'holidays', 'reason'],
  mutationUpdateKeys: ['name', 'description', 'isDefault', 'workingDays', 'holidays', 'reason', 'expectedRevision'],
  formDescriptionKey: label('help'),
  columns: [{ key: 'name', kind: 'text', labelKey: label('name') }, { key: 'isDefault', kind: 'boolean', labelKey: label('isDefault') }],
  fields: [
    field('name', 'text', { required: true }), field('description', 'textarea'), field('isDefault', 'boolean', { booleanStyle: 'switch' }),
    field('workingDays', 'object', { required: true, fullWidth: true, defaultValue: { '0': false, '1': true, '2': true, '3': true, '4': true, '5': true, '6': false },
      fields: ['0','1','2','3','4','5','6'].map(day => field(day, 'boolean', { booleanStyle: 'switch' })) }),
    field('holidays', 'objectArray', { required: true, fullWidth: true, defaultValue: [], addLabelKey: label('addClosure'), fields: [field('date', 'date', { required: true })] }),
    field('reason', 'textarea', { required: true, resetOnEdit: true, fullWidth: true }),
  ],
};
