import { ModuleHomeTabs } from '@/components/module-home/tabs'
import { useTranslations } from 'next-intl'

/** Sub-navigation between the Cards library and the Dashboards grid. */
export function InsightsTabs({ active }: { active: 'cards' | 'dashboards' }) {
  const t = useTranslations('insights.tabs')
  const tabs = [
    { key: 'cards', label: t('cards'), href: '/insights' },
    { key: 'dashboards', label: t('dashboards'), href: '/insights/dashboards' },
  ] as const
  return <ModuleHomeTabs tabs={tabs.map((tab) => ({ ...tab, active: tab.key === active }))} />
}
