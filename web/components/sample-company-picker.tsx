'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Database, Sparkles } from 'lucide-react'
import { Button, Card, Label, Select } from '@openbooks/ui'
import { enterOrg } from '../lib/sandbox-session'
import { readApiErrorMessage } from '../lib/api-error'

interface SampleCompanyProfile {
  industryKey: string
  profileId: string
  companyName: string
  focus: string[]
  templateReady: boolean
  existingOrgId: string | null
}

interface SampleCompanyRefusal {
  code?: string
  stage?: string
  message?: string
}

// The provisioning API reports failures by pipeline stage with a stable
// code. The picker renders the matching localized copy so the
// operator reads the failure in their own locale; an unknown code falls
// back to the server message, then to the generic localized copy.
export const SAMPLE_COMPANY_FAILURE_COPY: Record<string, string> = {
  'sample-company-template-failed': 'import.sample.createFailedTemplate',
  'sample-company-clone-failed': 'import.sample.createFailedClone',
  'sample-company-finalize-failed': 'import.sample.createFailedFinalize',
  'sample-company-numbering-failed': 'import.sample.createFailedNumbering',
}

async function readSampleCompanyRefusal(res: Response): Promise<SampleCompanyRefusal> {
  try {
    const body: unknown = await res.json()
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const record = body as Record<string, unknown>
      return {
        code: typeof record.error === 'string' ? record.error : undefined,
        stage: typeof record.stage === 'string' ? record.stage : undefined,
        message: typeof record.message === 'string' ? record.message : undefined,
      }
    }
  } catch {
    // Non-JSON error body (proxy page, empty 502): fall through to the
    // generic copy rather than surfacing a SyntaxError.
  }
  return {}
}

export function SampleCompanyPicker() {
  const t = useTranslations('data')
  const [sampleProfiles, setSampleProfiles] = useState<SampleCompanyProfile[]>([])
  const [sampleIndustry, setSampleIndustry] = useState('')
  const [sampleBusy, setSampleBusy] = useState(false)
  const [sampleError, setSampleError] = useState<SampleCompanyRefusal | null>(null)
  useEffect(() => {
    // The settings widget mounts after the route shell, so resolve its anchor
    // once the picker exists instead of relying on the initial navigation.
    if (window.location.hash === '#sample-companies') {
      document.getElementById('sample-companies')?.scrollIntoView({ block: 'start' })
    }
  }, [])
  const sampleErrorText = (refusal: SampleCompanyRefusal): string => {
    const copyKey = refusal.code ? SAMPLE_COMPANY_FAILURE_COPY[refusal.code] : undefined
    if (copyKey) return t(copyKey)
    if (refusal.message && refusal.message.trim() !== '') return refusal.message
    return t('import.sample.createFailed')
  }

  useEffect(() => {
    fetch('/api/data/sample-companies')
      .then(async (r) => {
        if (!r.ok) throw new Error(await readApiErrorMessage(r, t('import.sample.error')))
        return r.json()
      })
      .then((d) => {
        const profiles = (d.profiles ?? []) as SampleCompanyProfile[]
        setSampleProfiles(profiles)
        setSampleIndustry((current) => current || profiles[0]?.industryKey || '')
      })
      .catch((e) => {
        toast.error((e as Error).message)
      })
  }, [t])

  const selectedSample = useMemo(
    () => sampleProfiles.find((profile) => profile.industryKey === sampleIndustry) ?? null,
    [sampleIndustry, sampleProfiles],
  )

  const createOrOpenSample = async () => {
    if (!selectedSample) return
    setSampleBusy(true)
    // A retry starts clean, but the chosen company and profile stay selected
    // below: a failed attempt either created nothing (template/clone) or left
    // a resumable company the server continues from, so retry is safe.
    setSampleError(null)
    let orgId = selectedSample.existingOrgId
    try {
      if (!orgId) {
        const response = await fetch('/api/data/sample-companies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ industry: selectedSample.industryKey }),
        })
        if (!response.ok) {
          const refusal = await readSampleCompanyRefusal(response)
          setSampleError(refusal)
          throw new Error(sampleErrorText(refusal))
        }
        const data = (await response.json()) as { orgId?: unknown; created?: unknown }
        if (typeof data.orgId !== 'string') {
          const refusal: SampleCompanyRefusal = {}
          setSampleError(refusal)
          throw new Error(sampleErrorText(refusal))
        }
        orgId = data.orgId
        toast.success(data.created ? t('import.sample.created') : t('import.sample.ready'))
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('import.sample.error'))
      setSampleBusy(false)
      return
    }
    if (!orgId) {
      toast.error(t('import.sample.error'))
      setSampleBusy(false)
      return
    }
    // Entering resolves access and navigates: a refusal must release the
    // button instead of leaving it on "Preparing" forever.
    try {
      await enterOrg(orgId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('import.sample.error'))
    } finally {
      setSampleBusy(false)
    }
  }

  return (
    <Card id="sample-companies" className="scroll-mt-6">
      <div className="flex items-start gap-3 border-b border-border p-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-teal-600 text-white shadow-sm">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <h2 className="font-semibold text-foreground">{t('import.sample.title')}</h2>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{t('import.sample.description')}</p>
        </div>
      </div>
      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor="sample-industry">{t('import.sample.industry')}</Label>
          <Select id="sample-industry" aria-describedby={sampleError ? "sample-company-error" : undefined} disabled={sampleBusy} value={sampleIndustry} onChange={(event) => setSampleIndustry(event.target.value)}>
            {sampleProfiles.map((profile) => (
              <option key={profile.industryKey} value={profile.industryKey}>{profile.companyName}</option>
            ))}
          </Select>
          {selectedSample && (
            <p className="text-xs text-muted-foreground">
              {selectedSample.focus.join(' · ')}
              {!selectedSample.templateReady && !selectedSample.existingOrgId ? ` · ${t('import.sample.firstGeneration')}` : ''}
            </p>
          )}
          {sampleError && (
            <p
              id="sample-company-error"
              role="alert"
              className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-relaxed text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
            >
              {sampleErrorText(sampleError)}
            </p>
          )}
        </div>
        <Button
          type="button"
          onClick={createOrOpenSample}
          disabled={!selectedSample || sampleBusy}
          className="sm:min-w-44"
        >
          <Database className="mr-2 h-4 w-4" />
          {sampleBusy
            ? t('import.sample.preparing')
            : selectedSample?.existingOrgId
              ? t('import.sample.open')
              : t('import.sample.create')}
        </Button>
      </div>
      <p className="px-4 pb-4 text-xs leading-relaxed text-muted-foreground">{t('import.sample.safety')}</p>
    </Card>
  )
}
