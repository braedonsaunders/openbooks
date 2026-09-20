import { NextResponse } from 'next/server'
import { listEntryRulesInEffect, matchLine, selectRule } from '@openbooks/engine/src/allocations/match.ts'
import type { LineCoordinate, RuleInEffect } from '@openbooks/engine/src/allocations/types.ts'
import { resolveAccountGroups } from '@openbooks/engine/src/records/account-groups.ts'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const APPLY_POLICIES = ['automatic', 'suggest', 'manual'] as const
type ApplyPolicyParam = (typeof APPLY_POLICIES)[number]
const UUID_PARAMS = ['accountId', 'departmentId', 'locationId', 'classId', 'projectId', 'subsidiaryId'] as const
type UuidParam = (typeof UUID_PARAMS)[number]

function refused(): NextResponse {
  // Feature-off and out-of-scope read the same: the entry UI hides, and the
  // server refuses regardless of UI (design §5 invariant 6).
  return NextResponse.json({ error: 'not_found' }, { status: 404 })
}

function invalid(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 })
}

function toCandidate(candidate: RuleInEffect, recommended: boolean): {
  ruleId: string
  ruleKey: string
  ruleName: string
  applyPolicy: string
  versionId: string
  recommended: boolean
} {
  return {
    ruleId: candidate.rule.id,
    ruleKey: candidate.rule.key,
    ruleName: candidate.rule.name,
    applyPolicy: candidate.version.applyPolicy,
    versionId: candidate.version.id,
    recommended,
  }
}

/**
 * GET /api/allocations/entry-candidates — entry-mode rules in effect for the
 * universal transaction editor (shard A9; matching owned by A4).
 *
 * Query: documentKind, accountId, departmentId, locationId, classId,
 * projectId, subsidiaryId, documentDate (YYYY-MM-DD, default today UTC),
 * policy (automatic|suggest|manual).
 *
 * With `accountId` the response holds the rules whose version matches that
 * line coordinate, most specific first (the selectRule ordering in
 * engine/src/allocations/match.ts), with the winner flagged `recommended`.
 * Without it — the header-level "Apply distributions" presence check — every
 * entry rule in effect is returned with its policy and no matching runs.
 *
 * A named kind no rule in effect covers answers `{ rules: [] }` without
 * consulting the feature gates, so editors for out-of-domain kinds never
 * 404; kinds with candidates still refuse when entry is off.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const gate = await guardPermission('allocations.read')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const query = new URL(request.url).searchParams
  const param = (name: string): string | undefined => {
    const raw = query.get(name)?.trim() ?? ''
    return raw === '' ? undefined : raw
  }

  const documentKind = param('documentKind')
  const rawDate = param('documentDate') ?? new Date().toISOString().slice(0, 10)
  if (!DATE_RE.test(rawDate)) return invalid('invalid_documentDate')
  const documentDate = rawDate

  const ids = {} as Record<UuidParam, string | undefined>
  for (const name of UUID_PARAMS) {
    const value = param(name)
    if (value === undefined) continue
    if (!isUuid(value)) return invalid(`invalid_${name}`)
    ids[name] = value
  }

  const rawPolicy = param('policy')
  if (rawPolicy !== undefined && !(APPLY_POLICIES as readonly string[]).includes(rawPolicy)) {
    return invalid('invalid_policy')
  }
  const policy = rawPolicy as ApplyPolicyParam | undefined

  const allowed = gate.allowedSubsidiaryIds
  if (ids.subsidiaryId !== undefined && allowed !== null && !allowed.has(ids.subsidiaryId)) {
    return refused()
  }

  const inEffect = await listEntryRulesInEffect({ orgId: user.orgId, mode: 'entry', asOf: documentDate })
  const inPolicy = policy === undefined ? inEffect : inEffect.filter((c) => c.version.applyPolicy === policy)

  // A kind no entry rule covers has no candidates whatever the gate says:
  // answer the empty set instead of refusing, so draft editors for
  // out-of-domain kinds (checks, vendor bills, deposits…) never litter
  // the console with 404s. Kinds with candidates still pass through the
  // feature gates below, which keep refusing when entry is off.
  if (
    documentKind !== undefined &&
    inPolicy.length > 0 &&
    !inPolicy.some((candidate) => {
      const kinds = candidate.version.documentKinds
      return !kinds || kinds.length === 0 || kinds.includes(documentKind)
    })
  ) {
    return NextResponse.json({ rules: [] })
  }

  if (!(await isFeatureEnabled(user.orgId, 'allocations'))) return refused()
  if (!(await isFeatureEnabled(user.orgId, 'allocationsAtEntry'))) return refused()

  if (ids.accountId === undefined) {
    return NextResponse.json({ rules: inPolicy.map((candidate) => toCandidate(candidate, false)) })
  }

  // Account-group scopes resolve against the pool primitive
  // (engine/src/records/account-groups.ts); preload every dimension the candidates
  // name so the matcher's synchronous resolver never sees a miss.
  const dimensions = new Set<string>()
  for (const candidate of inPolicy) {
    const scope = candidate.version.accountScope
    if (scope.kind === 'account_group') dimensions.add(scope.dimension)
  }
  const membersByDimension = new Map<string, Map<string, Set<string>>>()
  for (const dimension of dimensions) {
    const resolved = await resolveAccountGroups(dimension, user.orgId)
    const byKey = new Map<string, Set<string>>()
    for (const [accountId, ref] of resolved.byAccount) {
      const members = byKey.get(ref.key) ?? new Set<string>()
      members.add(accountId)
      byKey.set(ref.key, members)
    }
    membersByDimension.set(dimension, byKey)
  }
  const resolveAccountGroup = (dimension: string, groupKey: string): Set<string> =>
    membersByDimension.get(dimension)?.get(groupKey) ?? new Set<string>()

  const line: LineCoordinate = {
    documentKind: documentKind ?? null,
    accountId: ids.accountId,
    subsidiaryId: ids.subsidiaryId ?? null,
    departmentId: ids.departmentId ?? null,
    locationId: ids.locationId ?? null,
    classId: ids.classId ?? null,
    projectId: ids.projectId ?? null,
    amount: '0',
  }

  // Same precedence as selectRule (specificity, sort_order, key) so the
  // picker's order always agrees with the engine's winner.
  const matched = inPolicy
    .map((candidate) => ({ candidate, result: matchLine(candidate.version, line, resolveAccountGroup) }))
    .filter((entry) => entry.result.matched)
    .sort((a, b) => {
      if (a.result.specificity !== b.result.specificity) return b.result.specificity - a.result.specificity
      if (a.candidate.rule.sortOrder !== b.candidate.rule.sortOrder) {
        return a.candidate.rule.sortOrder - b.candidate.rule.sortOrder
      }
      return a.candidate.rule.key < b.candidate.rule.key ? -1 : a.candidate.rule.key > b.candidate.rule.key ? 1 : 0
    })
  const winner = selectRule(
    matched.map((entry) => entry.candidate),
    line,
    { resolveAccountGroup },
  )
  return NextResponse.json({
    rules: matched.map((entry) => toCandidate(entry.candidate, winner !== null && entry.candidate.rule.key === winner.rule.key)),
  })
}
