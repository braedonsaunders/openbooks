import Link from 'next/link'
import { Settings2 } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { GreetingText } from './_greeting-text'
import { Button, PageHeader } from '@openbooks/ui'

export async function DashboardHeader({
  greeting,
  name,
}: {
  greeting: string
  name: string | null
}) {
  const t = await getTranslations('dashboard')
  return (
    <PageHeader title={t('title')}
      titleContent={<GreetingText name={name} serverGreeting={greeting} />}
      description={t('header.description')}
      actions={<Button variant="outline" asChild><Link href="/dashboard/customize">
        <Settings2 size={14} />
        <span>{t('header.customize')}</span>
      </Link></Button>} />
  )
}
