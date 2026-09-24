import 'server-only'

import type { getTranslations } from 'next-intl/server'
import { listInterviewerPools, listUpcomingInterviews } from '@openbooks/engine/src/hrm/recruiting/scheduling.ts'
import {
  listOffersWithSignature,
  listOfferVersions,
  offerSignatureState,
} from '@openbooks/engine/src/hrm/recruiting/offers-signing.ts'
import {
  listPostingEvents,
  listPostings,
} from '@openbooks/engine/src/hrm/recruiting/postings.ts'
import {
  listPoolMembers,
  listTalentPools,
  rediscoverForRequisition,
} from '@openbooks/engine/src/hrm/recruiting/pools.ts'
import {
  listKitAttributes,
  listKitQuestions,
  listKits,
  loadKit,
} from '@openbooks/engine/src/hrm/recruiting/kits.ts'
import {
  readScorecardsForInterview,
  scorecardSummary,
} from '@openbooks/engine/src/hrm/recruiting/scorecards.ts'
import { listCandidateConsents } from '@openbooks/engine/src/hrm/recruiting/retention.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessTimeZone } from '@openbooks/engine/src/platform/business-date.ts'
import { sql } from 'drizzle-orm'
import type { Authz } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'

/**
 * Recruiting depth tabs (HR-18): Interviews, Offers, Postings, and Pools
 * ride the /hrm/recruiting route as `?tab=` sub-tabs beside the existing
 * Openings table. Every loader resolves through the canonical depth
 * services (blind rule, signature state, disposition log included) — the
 * page renders data, never queries. Each tab renders only while its
 * sub-switch is on; a tab param naming a switched-off surface falls back
 * to Openings, so feature-off tabs are absent, not errors.
 */

export const DEPTH_TABS = ['openings', 'interviews', 'offers', 'postings', 'pools'] as const
export type DepthTab = (typeof DEPTH_TABS)[number]

const TAB_FEATURE: Record<Exclude<DepthTab, 'openings'>, string> = {
  interviews: 'hrmStructuredInterviews',
  offers: 'hrmOfferSigning',
  postings: 'hrmJobBoards',
  pools: 'hrmTalentPool',
}

type T = Awaited<ReturnType<typeof getTranslations>>

export interface DepthTabOption {
  value: string
  label: string
  href: string
}

export async function depthTabOptions(authz: Authz, t: T, status: string | null): Promise<DepthTabOption[]> {
  const options: DepthTabOption[] = [
    { value: 'openings', label: t('recruiting.tabs.openings'), href: hrefForTab('openings', status) },
  ]
  for (const tab of ['interviews', 'offers', 'postings', 'pools'] as const) {
    if (await isFeatureEnabled(authz.user.orgId, TAB_FEATURE[tab])) {
      options.push({ value: tab, label: t(`recruiting.tabs.${tab}`), href: hrefForTab(tab, status) })
    }
  }
  return options
}

export async function resolveDepthTab(authz: Authz, tab: unknown): Promise<DepthTab> {
  if (typeof tab !== 'string' || !(DEPTH_TABS as readonly string[]).includes(tab)) return 'openings'
  if (tab === 'openings') return 'openings'
  if (await isFeatureEnabled(authz.user.orgId, TAB_FEATURE[tab as Exclude<DepthTab, 'openings'>])) {
    return tab as DepthTab
  }
  return 'openings'
}

function hrefForTab(tab: DepthTab, status: string | null): string {
  const params = new URLSearchParams()
  if (tab !== 'openings') params.set('tab', tab)
  if (status) params.set('status', status)
  const query = params.toString()
  return query ? `/hrm/recruiting?${query}` : '/hrm/recruiting'
}

export function hrefForDepth(tab: DepthTab, selection: { interview?: string; offer?: string; posting?: string; pool?: string } | null): string {
  const params = new URLSearchParams()
  params.set('tab', tab)
  if (selection?.interview) params.set('interview', selection.interview)
  if (selection?.offer) params.set('offer', selection.offer)
  if (selection?.posting) params.set('posting', selection.posting)
  if (selection?.pool) params.set('pool', selection.pool)
  return `/hrm/recruiting?${params.toString()}`
}

/** Badge variant for depth-table chip columns (scorecards, signature, status). */
export type DepthBadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'

export interface InterviewTabRow {
  id: string
  candidate: string
  requisition: string
  kind: string
  when: string
  slots: string
  scorecards: string
  scorecardsVariant: DepthBadgeVariant
  href: string
}

export async function loadInterviewsTab(authz: Authz, t: T, tab: DepthTab): Promise<InterviewTabRow[]> {
  const sittings = await listUpcomingInterviews({ orgId: authz.user.orgId, actorId: authz.user.id })
  return sittings.map((sitting) => {
    const complete = sitting.scorecardsTotal > 0 && sitting.scorecardsSubmitted === sitting.scorecardsTotal
    return {
      id: sitting.id,
      candidate: sitting.candidateName,
      requisition: sitting.requisitionTitle,
      kind: sitting.kind,
      when: sitting.scheduledAt.slice(0, 16).replace('T', ' '),
      slots:
        sitting.bookedSlots > 0
          ? t('recruiting.depth.bookedSlots', { count: sitting.bookedSlots })
          : t('recruiting.depth.proposedSlots', { count: sitting.proposedSlots }),
      scorecards: t('recruiting.depth.scorecards', {
        submitted: sitting.scorecardsSubmitted,
        total: sitting.scorecardsTotal,
      }),
      scorecardsVariant: complete ? 'success' : sitting.scorecardsSubmitted > 0 ? 'warning' : 'secondary',
      href: hrefForDepth(tab, { interview: sitting.id }),
    }
  })
}

export interface OfferTabRow {
  id: string
  candidate: string
  job: string
  status: string
  signature: string
  signatureVariant: DepthBadgeVariant
  versions: string
  href: string
}

function signatureVariant(signature: string | null): OfferTabRow['signatureVariant'] {
  switch (signature) {
    case 'signed':
      return 'success'
    case 'sent':
    case 'viewed':
      return 'warning'
    case 'declined':
    case 'voided':
      return 'destructive'
    default:
      return 'secondary'
  }
}

export async function loadOffersTab(authz: Authz, t: T, tab: DepthTab): Promise<OfferTabRow[]> {
  const offers = await listOffersWithSignature({ orgId: authz.user.orgId, actorId: authz.user.id })
  return offers.map((offer) => ({
    id: offer.id,
    candidate: offer.candidateName,
    job: offer.jobTitle,
    status: offer.status,
    signature: t(`recruiting.signature.${offer.signatureStatus ?? 'unsigned'}`),
    signatureVariant: signatureVariant(offer.signatureStatus),
    versions: t('recruiting.depth.versions', { count: offer.versionCount }),
    href: hrefForDepth(tab, { offer: offer.id }),
  }))
}

export interface PostingTabRow {
  id: string
  requisitionId: string
  board: string
  status: string
  statusVariant: DepthBadgeVariant
  applies: string
  href: string
}

function postingVariant(status: string): PostingTabRow['statusVariant'] {
  switch (status) {
    case 'published':
      return 'success'
    case 'paused':
      return 'warning'
    case 'error':
      return 'destructive'
    case 'closed':
      return 'default'
    default:
      return 'secondary'
  }
}

export async function loadPostingsTab(authz: Authz, t: T, tab: DepthTab): Promise<PostingTabRow[]> {
  const postings = await listPostings({ orgId: authz.user.orgId, actorId: authz.user.id })
  const titles = new Map<string, string>()
  if (postings.length > 0) {
    const rows = (
      await db.execute<{ id: string; title: string }>(sql`
        select id::text as id, title from hrm_requisitions
         where org_id = ${authz.user.orgId}::uuid`)
    ).rows
    for (const row of rows) titles.set(row.id, row.title)
  }
  return postings.map((posting) => ({
    id: posting.id,
    requisitionId: posting.requisitionId,
    board: posting.boardKey,
    status: t(`recruiting.posting.${posting.status}`),
    statusVariant: postingVariant(posting.status),
    applies: t('recruiting.depth.applies', { count: posting.applyCount }),
    href: hrefForDepth(tab, { posting: posting.id }),
  }))
}

export interface PoolTabRow {
  id: string
  name: string
  members: string
  href: string
}

export async function loadPoolsTab(authz: Authz, t: T, tab: DepthTab): Promise<PoolTabRow[]> {
  const pools = await listTalentPools({ orgId: authz.user.orgId, actorId: authz.user.id })
  return pools.map((pool) => ({
    id: pool.id,
    name: pool.name,
    members: t('recruiting.depth.members', { count: pool.memberCount }),
    href: hrefForDepth(tab, { pool: pool.id }),
  }))
}

export interface InterviewDrawer {
  id: string
  timeZone: string
  closeHref: string
  candidate: string
  requisition: string
  kit: { name: string; instructions: string | null; questions: { question: string; attribute: string | null }[] } | null
  slots: { id: string; startsAt: string; endsAt: string; kind: string }[]
  /** Pools the propose picker can book from (managers only — readers get []). */
  pools: { id: string; name: string; windowCount: number }[]
  mine: { id: string; overall: string | null; submittedAt: string | null } | null
  others: { interviewer: string | null; overall: string | null; submittedAt: string | null }[]
  blinded: boolean
  summary: {
    complete: boolean
    submittedCount: number
    totalCount: number
    missing: readonly string[]
    overallCounts: Record<string, number>
  } | null
  labels: Record<string, string>
}

export async function loadInterviewDrawer(
  authz: Authz,
  t: T,
  tab: DepthTab,
  interviewId: string,
): Promise<InterviewDrawer | null> {
  try {
    const cards = await readScorecardsForInterview({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      interviewId,
    })
    const timeZone = await businessTimeZone(authz.user.orgId)
    const interview = (
      await db.execute<{ candidate: string; requisition: string; kitId: string | null }>(sql`
        select c.display_name as candidate, r.title as requisition, i.kit_id as "kitId"
          from hrm_interviews i
          join hrm_applications a on a.org_id = i.org_id and a.id = i.application_id
          join hrm_candidates c on c.org_id = i.org_id and c.id = a.candidate_id
          join hrm_requisitions r on r.org_id = i.org_id and r.id = a.requisition_id
         where i.org_id = ${authz.user.orgId}::uuid and i.id = ${interviewId}::uuid`)
    ).rows[0]
    if (!interview) return null
    const slotRows = (
      await db.execute<{ id: string; startsAt: string; endsAt: string; kind: string }>(sql`
        select id::text as id, starts_at as "startsAt", ends_at as "endsAt", kind
          from hrm_interview_slots
         where org_id = ${authz.user.orgId}::uuid and interview_id = ${interviewId}::uuid
         order by starts_at`)
    ).rows
    let kit: InterviewDrawer['kit'] = null
    if (interview.kitId) {
      const kitRow = await loadKit(db, authz.user.orgId, interview.kitId)
      if (kitRow) {
        const [attributes, questions] = await Promise.all([
          listKitAttributes(db, authz.user.orgId, kitRow.id),
          listKitQuestions(db, authz.user.orgId, kitRow.id),
        ])
        const names = new Map(attributes.map((attr) => [attr.id, attr.attribute] as const))
        kit = {
          name: kitRow.name,
          instructions: kitRow.instructions,
          questions: questions.map((question) => ({
            question: question.question,
            attribute: question.attributeId ? (names.get(question.attributeId) ?? null) : null,
          })),
        }
      }
    }
    // The blind summary opens to privileged viewers (manager/manage);
    // panelists read it through the same blind rule as the cards.
    let summary: InterviewDrawer['summary'] = null
    try {
      summary = await scorecardSummary({ orgId: authz.user.orgId, actorId: authz.user.id, interviewId })
    } catch {
      summary = null
    }
    // HR-18: pools for the propose picker. listInterviewerPools proves the
    // manage grant itself, so a read-only viewer lands here with [] and
    // the picker stays absent instead of erroring.
    let pools: InterviewDrawer['pools'] = []
    try {
      pools = (
        await listInterviewerPools({ orgId: authz.user.orgId, actorId: authz.user.id })
      ).map((pool) => ({ id: pool.id, name: pool.name, windowCount: pool.availability.length }))
    } catch {
      pools = []
    }
    return {
      id: interviewId,
      timeZone,
      closeHref: hrefForTab(tab, null),
      candidate: interview.candidate,
      requisition: interview.requisition,
      kit,
      slots: slotRows.map((row) => ({
        id: row.id,
        startsAt: row.startsAt.slice(0, 16).replace('T', ' '),
        endsAt: row.endsAt.slice(0, 16).replace('T', ' '),
        kind: t(`recruiting.interviewKind.${row.kind}`),
      })),
      mine: cards.mine
        ? { id: cards.mine.id, overall: translateRating(t, cards.mine.overall), submittedAt: cards.mine.submittedAt }
        : null,
      others: cards.others.map((card) => ({
        interviewer: card.interviewerName,
        overall: translateRating(t, card.overall),
        submittedAt: card.submittedAt,
      })),
      blinded: cards.blinded,
      summary,
      pools,
      labels: {
        kit: t('recruiting.depth.kit'),
        questions: t('recruiting.depth.questions'),
        slots: t('recruiting.depth.slots'),
        proposeFromPool: t('recruiting.depth.proposeFromPool'),
        myScorecard: t('recruiting.depth.myScorecard'),
        others: t('recruiting.depth.others'),
        blinded: t('recruiting.depth.blinded'),
        summary: t('recruiting.depth.summary'),
        missing: t('recruiting.depth.missing'),
        submit: t('recruiting.depth.submitScorecard'),
        failed: t('recruiting.depth.failed'),
        overall: t('recruiting.depth.overall'),
        ratings: t('recruiting.depth.ratings'),
        privateNotes: t('recruiting.depth.privateNotes'),
        sharedNotes: t('recruiting.depth.sharedNotes'),
        ratingStrongNo: t('recruiting.depth.ratingStrongNo'),
        ratingNo: t('recruiting.depth.ratingNo'),
        ratingYes: t('recruiting.depth.ratingYes'),
        ratingStrongYes: t('recruiting.depth.ratingStrongYes'),
        starts: t('recruiting.depth.starts'),
        ends: t('recruiting.depth.ends'),
        timezone: t('recruiting.depth.timezone'),
        invalidTime: t('recruiting.depth.invalidTime'),
        bookingLink: t('recruiting.depth.bookingLink'),
        email: t('recruiting.depth.email'),
        name: t('recruiting.depth.name'),
        reason: t('recruiting.depth.reason'),
      },
    }
  } catch {
    return null
  }
}

function translateRating(t: T, rating: string | null): string | null {
  if (!rating) return null
  const keys: Record<string, string> = {
    strong_no: 'ratingStrongNo',
    no: 'ratingNo',
    yes: 'ratingYes',
    strong_yes: 'ratingStrongYes',
  }
  const key = keys[rating]
  return key ? t(`recruiting.depth.${key}`) : rating
}

export interface OfferDrawerExtra {
  signature: string
  signatureVariant: OfferTabRow['signatureVariant']
  versions: { version: number; createdAt: string }[]
  labels: Record<string, string>
}

export async function loadOfferDrawerExtra(
  authz: Authz,
  t: T,
  offerId: string,
): Promise<OfferDrawerExtra | null> {
  try {
    const [state, versions] = await Promise.all([
      offerSignatureState({ orgId: authz.user.orgId, actorId: authz.user.id, offerId }),
      listOfferVersions({ orgId: authz.user.orgId, actorId: authz.user.id, offerId }),
    ])
    return {
      signature: t(`recruiting.signature.${state.signatureStatus ?? 'unsigned'}`),
      signatureVariant: signatureVariant(state.signatureStatus),
      versions: versions.map((version) => ({ version: version.version, createdAt: version.createdAt })),
      labels: {
        signature: t('recruiting.depth.signatureState'),
        versions: t('recruiting.depth.versionHistory'),
        sendLink: t('recruiting.depth.sendLink'),
        void: t('recruiting.depth.voidSignature'),
        failed: t('recruiting.depth.failed'),
        email: t('recruiting.depth.email'),
        name: t('recruiting.depth.name'),
        reason: t('recruiting.depth.reason'),
      },
    }
  } catch {
    return null
  }
}

export interface PostingDrawerExtra {
  posting: { id: string; boardKey: string; status: string; requisitionId: string }
  events: { kind: string; recordedAt: string }[]
  labels: Record<string, string>
}

export async function loadPostingDrawerExtra(
  authz: Authz,
  t: T,
  postingId: string,
): Promise<PostingDrawerExtra | null> {
  try {
    const [postings, events] = await Promise.all([
      listPostings({ orgId: authz.user.orgId, actorId: authz.user.id }),
      listPostingEvents({ orgId: authz.user.orgId, actorId: authz.user.id, postingId }),
    ])
    const posting = postings.find((row) => row.id === postingId)
    if (!posting) return null
    return {
      posting: {
        id: posting.id,
        boardKey: posting.boardKey,
        status: t(`recruiting.posting.${posting.status}`),
        requisitionId: posting.requisitionId,
      },
      events: events.map((event) => ({
        kind: t(`recruiting.postingEvent.${event.kind}`),
        recordedAt: event.recordedAt.slice(0, 16).replace('T', ' '),
      })),
      labels: {
        events: t('recruiting.depth.dispositionLog'),
        publish: t('recruiting.depth.publish'),
        pause: t('recruiting.depth.pause'),
        close: t('recruiting.depth.close'),
        failed: t('recruiting.depth.failed'),
      },
    }
  } catch {
    return null
  }
}

export interface PoolDrawer {
  id: string
  name: string
  members: { candidateId: string; displayName: string; tags: readonly string[]; note: string | null }[]
  labels: Record<string, string>
}

export async function loadPoolDrawer(authz: Authz, t: T, poolId: string): Promise<PoolDrawer | null> {
  try {
    const [pools, members] = await Promise.all([
      listTalentPools({ orgId: authz.user.orgId, actorId: authz.user.id }),
      listPoolMembers({ orgId: authz.user.orgId, actorId: authz.user.id, poolId }),
    ])
    const pool = pools.find((row) => row.id === poolId)
    if (!pool) return null
    return {
      id: pool.id,
      name: pool.name,
      members: members.map((member) => ({
        candidateId: member.candidateId,
        displayName: member.displayName,
        tags: member.tags,
        note: member.note,
      })),
      labels: {
        members: t('recruiting.depth.poolMembers'),
        match: t('recruiting.depth.matchToOpening'),
        tags: t('recruiting.depth.tagsLabel'),
        failed: t('recruiting.depth.failed'),
        remove: t('recruiting.depth.remove'),
      },
    }
  } catch {
    return null
  }
}

export async function matchPoolToOpening(
  authz: Authz,
  poolId: string,
  requisitionId: string,
  requisitionTags: string[],
): Promise<{ candidateId: string; displayName: string; matchedTags: readonly string[] }[]> {
  const matches = await rediscoverForRequisition({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    poolId,
    requisitionId,
    requisitionTags,
  })
  return matches.map((match) => ({
    candidateId: match.candidateId,
    displayName: match.displayName,
    matchedTags: match.matchedTags,
  }))
}

export interface ConsentStatus {
  consents: { purpose: string; grantedAt: string; expiresAt: string | null; withdrawnAt: string | null; source: string }[]
  earliestExpiry: string | null
  labels: Record<string, string>
}

export async function loadConsentStatus(authz: Authz, t: T, candidateId: string): Promise<ConsentStatus | null> {
  try {
    const status = await listCandidateConsents({ orgId: authz.user.orgId, actorId: authz.user.id, candidateId })
    return {
      consents: status.consents.map((consent) => ({
        purpose: t(`recruiting.consent.${consent.purpose}`),
        grantedAt: consent.grantedAt.slice(0, 10),
        expiresAt: consent.expiresAt ? consent.expiresAt.slice(0, 10) : null,
        withdrawnAt: consent.withdrawnAt ? consent.withdrawnAt.slice(0, 10) : null,
        source: consent.source,
      })),
      earliestExpiry: status.earliestExpiry ? status.earliestExpiry.slice(0, 10) : null,
      labels: {
        title: t('recruiting.depth.consentTitle'),
        retentionDate: t('recruiting.depth.retentionDate'),
      },
    }
  } catch {
    return null
  }
}

export interface KitOption {
  value: string
  label: string
}

export async function loadKitOptions(authz: Authz): Promise<KitOption[]> {
  try {
    const kits = await listKits({ orgId: authz.user.orgId, actorId: authz.user.id })
    return kits.filter((kit) => kit.isActive).map((kit) => ({ value: kit.id, label: kit.name }))
  } catch {
    return []
  }
}
