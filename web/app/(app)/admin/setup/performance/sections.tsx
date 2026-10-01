import Link from 'next/link'
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from '@openbooks/ui'
import { FeedbackSettingsShell } from '../../../hrm/performance/continuous-sections'
import type { PerformanceSetupData } from './view'

/** Same Company Setup composition as the review-form configuration workspace. */
export function PerformanceSetupSection({ data }: { data: PerformanceSetupData }) {
  return <div className="space-y-6">
    <PageHeader title={data.title} description={data.description} />
    {data.canManageSetup ? <Card>
      <CardHeader><CardTitle>{data.formsTitle}</CardTitle><CardDescription>{data.formsDescription}</CardDescription></CardHeader>
      <CardContent><Button asChild variant="outline"><Link href="/admin/setup/review-templates">{data.formsTitle}</Link></Button></CardContent>
    </Card> : null}
    <Card><CardContent className="pt-6"><FeedbackSettingsShell settings={data.settings} /></CardContent></Card>
  </div>
}
