'use client'
import { BriefcaseBusiness, Factory, FlaskConical, HardHat, Wrench } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { RecordKindCards } from './record-kind-cards'
import type { OperatingProfileChoice } from '@openbooks/engine/src/organization/operating-profiles.ts'

export function OperatingProfileCards({ choices, value, onChoose }: {
  choices: OperatingProfileChoice[]; value: string | null; onChoose: (choice: OperatingProfileChoice) => void
}) {
  const t = useTranslations('operatingProfiles')
  return <RecordKindCards heading={t('chooseTitle')} description={t('chooseDescription')} options={choices.map(choice => {
    const Icon = choice.definition.family === 'production'
      ? choice.definition.physicalModel === 'process' ? FlaskConical : Factory
      : choice.definition.capture === 'field_tickets' ? HardHat : choice.definition.presentation.showReadiness ? Wrench : BriefcaseBusiness
    const builtin = !choice.profileId && t.has(`presets.${choice.value}.name`)
    return { value: choice.value, label: builtin ? t(`presets.${choice.value}.name`) : choice.name,
      description: (choice.isDefault ? t('default') + ' · ' : '') + (builtin ? t(`presets.${choice.value}.description`) : choice.description || t(`capture.${choice.definition.capture}`)),
      icon: <Icon className="h-5 w-5" aria-hidden />, selected: choice.value === value }
  })} onChoose={selected => { const choice = choices.find(c => c.value === selected); if (choice) onChoose(choice) }} />
}
