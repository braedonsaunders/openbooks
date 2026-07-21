export interface LaborRateTemplate {
  id: string
  titleKey: string
  descriptionKey: string
  code: string
  name: string
  classes: { code: string; name: string }[]
  timeTypes: { name: string; costMultiplier: string; billMultiplier: string; billable: boolean }[]
  lines: {
    code: string
    name: string
    lane: 'direct_cost' | 'bill' | 'transfer' | 'planning_cost' | 'planning_bill'
    method: 'fixed' | 'at_cost' | 'markup_on_cost' | 'margin_on_cost'
    amount?: string
    percent?: string
    laborClassCode?: string
    priority?: number
  }[]
  components: {
    code: string
    name: string
    lane: 'cost' | 'bill' | 'transfer'
    method: 'fixed_per_hour' | 'percent_of_base_direct' | 'percent_of_direct' | 'percent_of_subtotal'
    value: string
    sequence: number
  }[]
}

/** Guided starters only. Applying one creates ordinary tenant-owned draft
 * configuration; the runtime never branches on a template id. */
export const LABOR_RATE_TEMPLATES: LaborRateTemplate[] = [
  {
    id: 'professional-services',
    titleKey: 'templates.professionalServices.title',
    descriptionKey: 'templates.professionalServices.description',
    code: 'PRO_SERVICES',
    name: 'Professional Services',
    classes: [
      { code: 'CONSULTANT', name: 'Consultant' },
      { code: 'SENIOR', name: 'Senior Consultant' },
      { code: 'PRINCIPAL', name: 'Principal' },
    ],
    timeTypes: [],
    lines: [
      { code: 'COST_CONSULTANT', name: 'Consultant standard cost', lane: 'direct_cost', method: 'fixed', amount: '55', laborClassCode: 'CONSULTANT' },
      { code: 'COST_SENIOR', name: 'Senior standard cost', lane: 'direct_cost', method: 'fixed', amount: '78', laborClassCode: 'SENIOR' },
      { code: 'COST_PRINCIPAL', name: 'Principal standard cost', lane: 'direct_cost', method: 'fixed', amount: '105', laborClassCode: 'PRINCIPAL' },
      { code: 'BILL_CONSULTANT', name: 'Consultant bill rate', lane: 'bill', method: 'fixed', amount: '145', laborClassCode: 'CONSULTANT' },
      { code: 'BILL_SENIOR', name: 'Senior bill rate', lane: 'bill', method: 'fixed', amount: '195', laborClassCode: 'SENIOR' },
      { code: 'BILL_PRINCIPAL', name: 'Principal bill rate', lane: 'bill', method: 'fixed', amount: '265', laborClassCode: 'PRINCIPAL' },
    ],
    components: [{ code: 'SHARED_OVERHEAD', name: 'Shared services overhead', lane: 'cost', method: 'percent_of_direct', value: '18', sequence: 10 }],
  },
  {
    id: 'construction-union',
    titleKey: 'templates.constructionUnion.title',
    descriptionKey: 'templates.constructionUnion.description',
    code: 'CONSTRUCTION_UNION',
    name: 'Construction and Union Labor',
    classes: [
      { code: 'APPRENTICE', name: 'Apprentice' },
      { code: 'JOURNEY', name: 'Journey Worker' },
      { code: 'FOREPERSON', name: 'Foreperson' },
    ],
    timeTypes: [
      { name: 'Overtime (1.5×)', costMultiplier: '1.5', billMultiplier: '1.5', billable: true },
      { name: 'Double time (2×)', costMultiplier: '2', billMultiplier: '2', billable: true },
    ],
    lines: [
      { code: 'BASE_APPRENTICE', name: 'Apprentice base wage', lane: 'direct_cost', method: 'fixed', amount: '30', laborClassCode: 'APPRENTICE' },
      { code: 'BASE_JOURNEY', name: 'Journey base wage', lane: 'direct_cost', method: 'fixed', amount: '42', laborClassCode: 'JOURNEY' },
      { code: 'BASE_FOREPERSON', name: 'Foreperson base wage', lane: 'direct_cost', method: 'fixed', amount: '52', laborClassCode: 'FOREPERSON' },
      { code: 'COST_PLUS_BILL', name: 'Burdened cost plus markup', lane: 'bill', method: 'markup_on_cost', percent: '25' },
    ],
    components: [
      { code: 'PAYROLL_TAX', name: 'Employer payroll taxes', lane: 'cost', method: 'percent_of_direct', value: '12', sequence: 10 },
      { code: 'HEALTH_WELFARE', name: 'Health and welfare', lane: 'cost', method: 'percent_of_direct', value: '18', sequence: 20 },
      { code: 'PENSION', name: 'Pension contribution', lane: 'cost', method: 'percent_of_direct', value: '10', sequence: 30 },
      { code: 'WORKER_COMP', name: 'Workers compensation', lane: 'cost', method: 'percent_of_subtotal', value: '6', sequence: 40 },
    ],
  },
  {
    id: 'field-service-equipment',
    titleKey: 'templates.fieldServiceEquipment.title',
    descriptionKey: 'templates.fieldServiceEquipment.description',
    code: 'FIELD_SERVICE',
    name: 'Field Service and Equipment Operators',
    classes: [
      { code: 'OPERATOR', name: 'Equipment Operator' },
      { code: 'TECHNICIAN', name: 'Field Technician' },
    ],
    timeTypes: [{ name: 'Emergency callout', costMultiplier: '1.5', billMultiplier: '1.5', billable: true }],
    lines: [
      { code: 'COST_OPERATOR', name: 'Operator standard cost', lane: 'direct_cost', method: 'fixed', amount: '38', laborClassCode: 'OPERATOR' },
      { code: 'COST_TECH', name: 'Technician standard cost', lane: 'direct_cost', method: 'fixed', amount: '45', laborClassCode: 'TECHNICIAN' },
      { code: 'BILL_OPERATOR', name: 'Operator bill rate', lane: 'bill', method: 'fixed', amount: '95', laborClassCode: 'OPERATOR' },
      { code: 'BILL_TECH', name: 'Technician bill rate', lane: 'bill', method: 'fixed', amount: '120', laborClassCode: 'TECHNICIAN' },
      { code: 'TRANSFER_AT_COST', name: 'Internal transfer at burdened cost', lane: 'transfer', method: 'at_cost' },
    ],
    components: [
      { code: 'FIELD_OVERHEAD', name: 'Field operations overhead', lane: 'cost', method: 'percent_of_direct', value: '22', sequence: 10 },
      { code: 'PPE_TOOLING', name: 'PPE and small tools', lane: 'cost', method: 'fixed_per_hour', value: '4.5', sequence: 20 },
    ],
  },
  {
    id: 'blended-crew',
    titleKey: 'templates.blendedCrew.title',
    descriptionKey: 'templates.blendedCrew.description',
    code: 'BLENDED_CREW',
    name: 'Blended Crew Cost Plus',
    classes: [],
    timeTypes: [],
    lines: [
      { code: 'BLENDED_COST', name: 'Blended crew standard cost', lane: 'direct_cost', method: 'fixed', amount: '48' },
      { code: 'BILL_MARGIN', name: 'Target margin billing', lane: 'bill', method: 'margin_on_cost', percent: '35' },
      { code: 'PLAN_COST', name: 'Planning cost', lane: 'planning_cost', method: 'fixed', amount: '52' },
      { code: 'PLAN_BILL', name: 'Planning bill rate', lane: 'planning_bill', method: 'fixed', amount: '135' },
    ],
    components: [{ code: 'CREW_OVERHEAD', name: 'Crew overhead', lane: 'cost', method: 'percent_of_direct', value: '20', sequence: 10 }],
  },
]

export const LABOR_RATE_TEMPLATE_BY_ID = new Map(LABOR_RATE_TEMPLATES.map((template) => [template.id, template]))
