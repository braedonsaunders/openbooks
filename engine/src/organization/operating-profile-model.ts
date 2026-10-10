import { featureEnabled, type FeatureState } from './feature-registry.ts'

export type WorkFamily = 'project' | 'production'
export type WorkCapture = 'job' | 'activities' | 'tasks' | 'field_tickets' | 'operations' | 'batch'
export interface OperatingProfileDefinition {
  family: WorkFamily
  capture: WorkCapture
  physicalModel: 'none' | 'discrete' | 'process'
  demand: 'none' | 'make_to_order' | 'make_to_stock'
  terminology: { singular: string; plural: string }
  presentation: {
    showSite: boolean
    showForeman: boolean
    showCustomerPo: boolean
    showMaterials: boolean
    showReadiness: boolean
    defaultView: 'list' | 'board'
  }
}

/** Starting compositions, not industry classifications or financial policies. */
export const OPERATING_PRESETS = [
  { key: 'shop_jobs', name: 'Shop jobs', description: 'Customer jobs, readiness and time. Add activities when useful.', definition: {
    family: 'project', capture: 'job', physicalModel: 'none', demand: 'none',
    terminology: { singular: 'Job', plural: 'Jobs' }, presentation: { showSite: false, showForeman: false, showCustomerPo: true, showMaterials: true, showReadiness: true, defaultView: 'board' },
  } },
  { key: 'field_work', name: 'Field work', description: 'Site work with optional field tickets, crews and project planning.', definition: {
    family: 'project', capture: 'field_tickets', physicalModel: 'none', demand: 'none',
    terminology: { singular: 'Project', plural: 'Projects' }, presentation: { showSite: true, showForeman: true, showCustomerPo: true, showMaterials: true, showReadiness: false, defaultView: 'list' },
  } },
  { key: 'professional_services', name: 'Professional services', description: 'Engagements, time and deliverables without construction fields.', definition: {
    family: 'project', capture: 'job', physicalModel: 'none', demand: 'none',
    terminology: { singular: 'Engagement', plural: 'Engagements' }, presentation: { showSite: false, showForeman: false, showCustomerPo: false, showMaterials: false, showReadiness: false, defaultView: 'list' },
  } },
  { key: 'discrete_production', name: 'Discrete production', description: 'Repeatable products with bills of material and routed operations.', definition: {
    family: 'production', capture: 'operations', physicalModel: 'discrete', demand: 'make_to_stock',
    terminology: { singular: 'Production order', plural: 'Production orders' }, presentation: { showSite: false, showForeman: false, showCustomerPo: false, showMaterials: true, showReadiness: true, defaultView: 'board' },
  } },
  { key: 'custom_production', name: 'Custom production', description: 'Made-to-order products with controlled materials and revisions.', definition: {
    family: 'production', capture: 'operations', physicalModel: 'discrete', demand: 'make_to_order',
    terminology: { singular: 'Production job', plural: 'Production jobs' }, presentation: { showSite: false, showForeman: false, showCustomerPo: true, showMaterials: true, showReadiness: true, defaultView: 'board' },
  } },
  { key: 'batch_process', name: 'Batch and process production', description: 'Recipes, batches, measured yields and traceable outputs.', definition: {
    family: 'production', capture: 'batch', physicalModel: 'process', demand: 'make_to_stock',
    terminology: { singular: 'Batch', plural: 'Batches' }, presentation: { showSite: false, showForeman: false, showCustomerPo: false, showMaterials: true, showReadiness: true, defaultView: 'board' },
  } },
] as const satisfies readonly { key: string; name: string; description: string; definition: OperatingProfileDefinition }[]

export function operatingProfileAvailable(definition: OperatingProfileDefinition, features: FeatureState): boolean {
  return featureEnabled(features, definition.family === 'project' ? 'projects' : 'manufacturing') &&
    (definition.capture !== 'field_tickets' || featureEnabled(features, 'fieldTickets'))
}

/** Validate stored and imported compositions at the native boundary. */
export function validateOperatingProfile(value: unknown): OperatingProfileDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose an operating profile definition.')
  const d = value as OperatingProfileDefinition
  const allowed = ['family', 'capture', 'physicalModel', 'demand', 'terminology', 'presentation']
  if (Object.keys(d).some(k => !allowed.includes(k)) || !['project', 'production'].includes(d.family) ||
    !['job', 'activities', 'tasks', 'field_tickets', 'operations', 'batch'].includes(d.capture) ||
    !['none', 'discrete', 'process'].includes(d.physicalModel) || !['none', 'make_to_order', 'make_to_stock'].includes(d.demand)) {
    throw new Error('Choose supported work, capture and production styles.')
  }
  if (d.family === 'project' ? (['operations', 'batch'].includes(d.capture) || d.physicalModel !== 'none' || d.demand !== 'none') :
    (!['operations', 'batch'].includes(d.capture) || d.physicalModel === 'none' || d.demand === 'none' || (d.capture === 'batch') !== (d.physicalModel === 'process'))) {
    throw new Error('Project and production styles must use their own native work records.')
  }
  if (!d.terminology || Object.keys(d.terminology).some(k => !['singular', 'plural'].includes(k)) ||
    !['singular', 'plural'].every(k => typeof d.terminology[k as keyof typeof d.terminology] === 'string' && d.terminology[k as keyof typeof d.terminology].trim().length > 0 && d.terminology[k as keyof typeof d.terminology].length <= 60)) {
    throw new Error('Provide singular and plural work names of at most 60 characters.')
  }
  const p = d.presentation
  if (!p || Object.keys(p).some(k => !['showSite', 'showForeman', 'showCustomerPo', 'showMaterials', 'showReadiness', 'defaultView'].includes(k)) ||
    !['showSite', 'showForeman', 'showCustomerPo', 'showMaterials', 'showReadiness'].every(k => typeof p[k as keyof typeof p] === 'boolean') ||
    !['list', 'board'].includes(p.defaultView)) throw new Error('Choose the visible details and a supported default view.')
  return JSON.parse(JSON.stringify(d)) as OperatingProfileDefinition
}
