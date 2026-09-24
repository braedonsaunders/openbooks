import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { fromUnits, toUnits } from '../../../../../../../engine/src/money/money.ts'
import {
  getRuleDetail,
  getRuleVersion,
  matchLine,
  type AccountGroupResolver,
} from '../../../../../../../engine/src/allocations/index.ts'
import { resolveAccountGroups } from '../../../../../../../engine/src/records/account-groups.ts'
import { guardAllocations } from '../../../../../../lib/allocations-gate'
import { allocationErrorResponse, requireRuleId } from '../../../_lib.ts'

export const runtime = 'nodejs'

/**
 * Test tab endpoint. Entry/post rules: a pasted sample line coordinate comes
 * back with the match verdict (A4's `matchLine`) and the explode preview.
 * Period rules do not match lines — the response carries the Runs deep link
 * A8's tab renders the preview behind.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardAllocations('allocations.read')
  if (gate instanceof NextResponse) return gate
  const id = requireRuleId((await params).id)
  if (id instanceof NextResponse) return id
  const parsed = await parseJsonBody(req, jsonObject)
  if (!parsed.ok) return parsed.response
  const body = parsed.data as { versionId?: unknown; line?: unknown; periodId?: unknown }
  try {
    const { rule, versions } = await getRuleDetail(gate.user.orgId, id, gate.allowedSubsidiaryIds)
    if (rule.mode === 'period') {
      const period = typeof body.periodId === 'string' ? body.periodId : ''
      return NextResponse.json({
        kind: 'period',
        ruleId: id,
        runsUrl: `/admin/setup/allocations?tab=runs&rule=${encodeURIComponent(id)}${period === '' ? '' : `&period=${encodeURIComponent(period)}`}`,
      })
    }
    const rawLine = typeof body.line === 'object' && body.line !== null && !Array.isArray(body.line)
      ? (body.line as Record<string, unknown>)
      : null
    if (!rawLine || typeof rawLine['accountId'] !== 'string' || rawLine['accountId'] === '') {
      return NextResponse.json({ error: 'A sample line with an account is required to test entry/post rules.' }, { status: 400 })
    }
    const requestedVersion = typeof body.versionId === 'string' ? body.versionId : undefined
    const newestFirst = [...versions].reverse()
    const entry = requestedVersion != null
      ? versions.find((v) => v.version.id === requestedVersion)
      : (versions.find((v) => v.version.id === rule.currentVersionId)
        ?? newestFirst.find((v) => v.version.status === 'published')
        ?? newestFirst[0])
    if (!entry) {
      return NextResponse.json({ error: 'Rule has no version to test.', code: 'INVALID' }, { status: 422 })
    }
    const { version, targets } = await getRuleVersion(gate.user.orgId, entry.version.id, gate.allowedSubsidiaryIds)
    const line = {
      accountId: rawLine['accountId'] as string,
      documentKind: typeof rawLine['documentKind'] === 'string' ? (rawLine['documentKind'] as string) : null,
      departmentId: asId(rawLine['departmentId']),
      locationId: asId(rawLine['locationId']),
      classId: asId(rawLine['classId']),
      projectId: asId(rawLine['projectId']),
      subsidiaryId: asId(rawLine['subsidiaryId']),
      partyId: asId(rawLine['partyId']),
      itemId: asId(rawLine['itemId']),
      extraDims: asStringMap(rawLine['extraDims']),
      amount: '0',
    }
    let resolveAccountGroup: AccountGroupResolver | undefined
    if (version.accountScope.kind === 'account_group') {
      const resolved = await resolveAccountGroups(version.accountScope.dimension, gate.user.orgId)
      const cache = new Map<string, Set<string>>()
      resolveAccountGroup = (dimension: string, groupKey: string) => {
        const cacheKey = `${dimension}::${groupKey}`
        const cached = cache.get(cacheKey)
        if (cached) return cached
        const group = resolved.groups.find((g) => g.dimension === dimension && g.key === groupKey)
        const members = new Set<string>()
        if (group) {
          for (const [accountId, ref] of resolved.byAccount) {
            if (ref.groupId === group.id) members.add(accountId)
          }
        }
        cache.set(cacheKey, members)
        return members
      }
    }
    const { matched, specificity } = matchLine(version, line, resolveAccountGroup)
    let preview: {
      sequence: number
      label: string | null
      targetAccountId: string | null
      departmentId: string | null
      locationId: string | null
      classId: string | null
      projectId: string | null
      subsidiaryId: string | null
      sharePercent: string | null
      isRemainder: boolean
    }[] = []
    let basisNote: string | null = null
    if (version.targetKind === 'explicit' && version.basisKind === 'fixed_percent') {
      // Display-only shares from the stored percent strings (exact scale-4
      // money helpers — never floats). Drafts may be incomplete; the
      // remainder shows whatever is left, even negative.
      let sum = 0n
      for (const target of targets) {
        if (!target.isRemainder && target.fixedPercent != null) {
          try {
            sum += toUnits(target.fixedPercent)
          } catch {
            // Malformed percents fail publish validation; preview skips them.
          }
        }
      }
      preview = targets.map((target) => ({
        sequence: target.sequence,
        label: target.label ?? null,
        targetAccountId: target.targetAccountId ?? null,
        departmentId: target.departmentId ?? null,
        locationId: target.locationId ?? null,
        classId: target.classId ?? null,
        projectId: target.projectId ?? null,
        subsidiaryId: target.subsidiaryId ?? null,
        sharePercent: target.isRemainder ? fromUnits(1000000n - sum) : (target.fixedPercent ?? null),
        isRemainder: target.isRemainder ?? false,
      }))
    } else if (version.targetKind === 'dynamic') {
      basisNote = 'Dynamic targets resolve at run time from the driver vector.'
    } else {
      basisNote = 'Driver/stepped shares resolve at run time from the driver vector.'
    }
    return NextResponse.json({
      kind: 'match',
      ruleId: id,
      versionId: version.id,
      versionNo: version.versionNo,
      matched,
      specificity,
      preview,
      basisNote,
    })
  } catch (error) {
    return allocationErrorResponse(error)
  }
}

function asId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asStringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}
