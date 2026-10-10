import { OPERATING_PRESETS } from '@openbooks/engine/src/organization/operating-profile-model.ts'
import type { SetupEntity, SetupField } from '../types'
const label = (key: string) => `operatingProfiles.${key}`
const field = (key: string, kind: SetupField['kind'], extra: Partial<SetupField> = {}): SetupField => ({ key, kind, labelKey: label(`fields.${key}`), ...extra })
const options = (values: string[]) => values.map(value => ({ value, labelKey: label(`values.${value}`) }))
export const OPERATING_PROFILE_ENTITIES: SetupEntity[] = [{
  key: 'operating-profiles', table: 'operating_profiles', groupKey: 'projects', iconKey: 'building',
  orgScoped: true, actorCols: true, orderBy: 'name', hasActive: true, allowDelete: false,
  featureKeysAny: ['projects', 'manufacturing'], importVia: 'none', drawerSize: 'xl',
  mutationPath: '/api/operating-profiles',
  mutationCreateKeys: ['code', 'name', 'definition', 'reason', 'isActive'],
  mutationUpdateKeys: ['code', 'name', 'definition', 'reason', 'expectedVersion', 'isActive'],
  mutationRevision: { requestKey: 'expectedVersion', rowColumn: 'version' },
  createChooser: { titleKey: label('chooser.title'), descriptionKey: label('chooser.description'), options: OPERATING_PRESETS.map(p => ({ key: p.key, requiresFeatures: [p.definition.family === 'project' ? 'projects' : 'manufacturing', ...(p.definition.capture === 'field_tickets' ? ['fieldTickets'] : [])], iconKey: p.definition.family === 'production' ? 'building' : 'receipt', labelKey: label(`presets.${p.key}.name`), descriptionKey: label(`presets.${p.key}.description`), values: { code: p.key, name: p.name, definition: p.definition } })) },
  columns: [{ key: 'code', kind: 'code', labelKey: label('fields.code') }, { key: 'name', kind: 'text', labelKey: label('fields.name') }],
  formSections: [{ titleKey: label('sections.basics'), fields: ['code', 'name', 'isActive'] }, { titleKey: label('sections.composition'), descriptionKey: label('compositionHelp'), fields: ['definition'] }, { titleKey: label('sections.publish'), fields: ['reason'] }],
  fields: [
    field('code', 'text', { required: true, lockedOnEdit: true }), field('name', 'text', { required: true }), field('isActive','boolean',{labelKey:'fields.isActive',booleanStyle:'switch'}),
    field('definition', 'object', { required: true, fullWidth: true, fields: [
      field('family', 'select', { required: true, lockedOnEdit: true, options: options(['project', 'production']) }),
      field('capture', 'select', { required: true, scopedOptions: { scopeField:'family',byValue:{project:options(['job','activities','tasks','field_tickets']),production:options(['operations','batch'])} } }),
      field('physicalModel', 'select', { required: true, scopedOptions: {scopeField:'family',byValue:{project:options(['none']),production:options(['discrete','process'])}} }),
      field('demand', 'select', { required: true, scopedOptions: {scopeField:'family',byValue:{project:options(['none']),production:options(['make_to_order','make_to_stock'])}} }),
      field('terminology', 'object', { required: true, fields: [field('singular', 'text', { required: true }), field('plural', 'text', { required: true })] }),
      field('presentation', 'object', { required: true, fields: [
        ...['showSite', 'showForeman', 'showCustomerPo', 'showMaterials', 'showReadiness'].map(key => field(key, 'boolean', { booleanStyle: 'switch' })),
        field('defaultView', 'select', { required: true, options: options(['list', 'board']) }),
      ] }),
    ] }),
    field('reason', 'textarea', { required: true, resetOnEdit: true, fullWidth: true }),
  ],
}, {
  key: 'operating-profile-scopes', table: 'operating_profile_scopes', groupKey: 'projects', iconKey: 'building',
  orgScoped: true, actorCols: true, orderBy: 'family, department_id nulls first', hasActive: false, allowDelete: false,
  featureKeysAny: ['projects', 'manufacturing'], importVia: 'none', drawerSize: 'xl',
  mutationPath: '/api/operating-profile-scopes',
  mutationCreateKeys: ['departmentId', 'family', 'profileIds', 'defaultProfileId', 'reason'],
  mutationUpdateKeys: ['departmentId', 'family', 'profileIds', 'defaultProfileId', 'reason', 'expectedRevision'],
  mutationRevision: { requestKey: 'expectedRevision', rowColumn: 'revision' },
  columns: [
    { key: 'departmentId', kind: 'ref', ref: 'departments', labelKey: label('fields.departmentId') },
    { key: 'family', kind: 'text', labelKey: label('fields.family') },
    { key: 'defaultProfileId', kind: 'ref', ref: 'operating-profiles', labelKey: label('fields.defaultProfileId') },
  ],
  fields: [
    field('departmentId', 'ref', { ref: 'departments', lockedOnEdit: true, helpTextKey: label('scopeHelp') }),
    field('family', 'select', { required: true, lockedOnEdit: true, options: options(['project', 'production']) }),
    field('profileIds', 'multiref', { required: true, ref: 'operating-profiles', refScopeField:'family' }),
    field('defaultProfileId', 'ref', { ref: 'operating-profiles',refScopeField:'family' }),
    field('reason', 'textarea', { required: true, resetOnEdit: true, fullWidth: true }),
  ],
}]


OPERATING_PROFILE_ENTITIES.push({
  key:'operating-profile-versions',table:'operating_profile_versions',groupKey:'projects',iconKey:'layers',orgScoped:true,
  orderBy:'version desc',hasActive:false,allowCreate:false,allowDelete:false,readOnly:true,featureKeysAny:['projects','manufacturing'],
  parentRecords:[{entityKey:'operating-profiles',fieldKey:'profileId'}],
  columns:[{key:'version',kind:'number',labelKey:label('fields.version')},{key:'publishedAt',kind:'date',labelKey:label('fields.publishedAt')},{key:'reason',kind:'text',labelKey:label('fields.reason')}],
  fields:[field('profileId','ref',{ref:'operating-profiles'}),field('version','integer'),field('publishedAt','text'),field('reason','textarea'),OPERATING_PROFILE_ENTITIES[0]!.fields.find(field=>field.key==='definition')!],
})
