import type { SetupEntity } from './types'

/** Time-off programs edit the native bank and its scoped rules in Benefits. */
export function benefitEntitlementPresentation(entity: SetupEntity, creating = false): SetupEntity {
  const offer = ['code', 'name', 'unit', 'systemKey', 'direction']
  const accrual = ['accrualMethod', 'accrualValue', 'accrualComponentId', 'capBehavior']
  const delivery = ['payoutComponentId', 'depositComponentId', 'allowNegativeBalance', 'liabilityAccountId', 'isActive']
  return {
    ...entity,
    singularTitleKey: 'benefitBuilder.timeOff.title',
    formDescriptionKey: 'benefitBuilder.timeOff.description',
    createDestination: { rowParam: 'program' },
    creationSteps: creating ? [
      { key: 'offer', titleKey: 'benefitBuilder.offer', descriptionKey: 'benefitBuilder.timeOff.offer', fields: offer },
      { key: 'accrual', titleKey: 'benefitBuilder.timeOff.accrual', descriptionKey: 'benefitBuilder.timeOff.accrualHint', fields: accrual },
      { key: 'delivery', titleKey: 'benefitBuilder.delivery', descriptionKey: 'benefitBuilder.timeOff.deliveryHint', fields: delivery },
    ] : undefined,
    formSections: creating ? undefined : [
      { titleKey: 'benefitBuilder.offer', fields: offer },
      { titleKey: 'benefitBuilder.timeOff.accrual', descriptionKey: 'benefitBuilder.timeOff.accrualHint', fields: accrual },
      { titleKey: 'benefitBuilder.delivery', descriptionKey: 'benefitBuilder.timeOff.deliveryHint', fields: delivery },
    ],
    fields: entity.fields.map(field => {
      if (field.key === 'direction' && creating) return { ...field, defaultValue: 'accrue', hidden: true }
      if (field.key === 'isActive' && creating) return { ...field, defaultValue: false, hidden: true }
      if (field.key === 'systemKey') return { ...field, lockedOnEdit: true, labelKey: 'benefitBuilder.timeOff.purpose', helpTextKey: 'benefitBuilder.timeOff.purposeHint' }
      return field
    }),
  }
}
