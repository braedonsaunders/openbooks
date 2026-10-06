import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { DB, setupHarness, withHarness, seedEmployment } from '@openbooks/engine/testing/hrm'
import { db } from '@openbooks/engine/platform/database'
import { sql } from 'drizzle-orm'

const state = { orgId: '', actorId: '' }
Object.assign(globalThis, { __trainingRouteActor: state })
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent(source),
})
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/lib/feature-gates' && context.parentURL?.includes('/lib/api/route'))
      return virtual(
        `export async function guardFeaturePermission(){const s=globalThis.__trainingRouteActor;return {user:{orgId:s.orgId,id:s.actorId},allowedSubsidiaryIds:null}}`,
      )
    if (specifier === '@/lib/analytics/preview-invalidation')
      return virtual('export async function invalidateAnalyticsPreviews(){}')
    return next(specifier, context)
  },
})
const { POST: create } = await import('./courses/route')
const { POST: transition, GET: read } = await import('./courses/[courseId]/route')
const spec = {
  features: ['hrm', 'hrmCertifications', 'hrmTraining'],
  users: [
    {
      key: 'authorId',
      name: 'Training author',
      handle: 'route_author',
      permissions: ['hrm.certifications.read', 'hrm.certifications.manage'],
      link: true,
    },
    {
      key: 'reviewerId',
      name: 'Training reviewer',
      handle: 'route_reviewer',
      permissions: ['hrm.certifications.read', 'hrm.certifications.manage'],
      link: true,
    },
  ],
} as const
const request = (body: unknown, key?: string) =>
  new Request('http://training.test/api/hrm/training/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  })
const payload = (subsidiaryId: string) => ({
  subsidiaryId,
  code: 'SAFETY',
  version: 1,
  name: 'Safety course',
  description: null,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  qualificationTypeId: null,
  minimumAttendancePercent: 90,
  passingScore: 70,
  reason: 'Declared attendance policy',
})

// Only the HTTP principal and unrelated cache invalidation are isolated;
// parsing, permissions in the native command, transactions and storage are real.
test(
  'native create boundary preserves named refusals, actor ownership and idempotent writes',
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(spec),
      async (f) => {
        state.orgId = f.org.orgId
        state.actorId = f.authorId
        const body = payload(f.org.subsidiaryId),
          key = randomUUID()
        const missing = await create(request(body))
        assert.equal(missing.status, 400)
        assert.match((await missing.json()).error, /UUID Idempotency-Key.*reopen/)
        const malformed = await create(request({ ...body, minimumAttendancePercent: 101 }, key))
        assert.equal(malformed.status, 422)
        assert.match((await malformed.json()).error, /Minimum attendance percentage.*0 to 100.*enter a value/)
        assert.equal(
          (await db.execute(sql`select id from hrm_training_courses where org_id=${f.org.orgId}`)).rows.length,
          0,
        )
        const saved = await create(request(body, key))
        assert.equal(saved.status, 201)
        const row = await saved.json()
        assert.equal(row.createdBy, f.authorId)
        assert.equal(row.status, 'draft')
        const retry = await create(request(body, key))
        assert.equal(retry.status, 201)
        assert.equal((await retry.json()).id, row.id)
        const changed = await create(request({ ...body, name: 'Changed policy' }, key))
        assert.equal(changed.status, 422)
        assert.match((await changed.json()).error, /different content.*existing record is preserved/)
        assert.equal(
          (await db.execute(sql`select id from hrm_training_courses where org_id=${f.org.orgId}`)).rows.length,
          1,
        )
      },
    )
  },
)
test(
  'course approval refusal reaches the HTTP caller and a stale revision cannot change approved policy',
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(spec),
      async (f) => {
        state.orgId = f.org.orgId
        state.actorId = f.authorId
        const saved = await create(request(payload(f.org.subsidiaryId), randomUUID()))
        const row = await saved.json()
        const context = { params: Promise.resolve({ courseId: row.id }) }
        const body = { action: 'approve', expectedRevision: row.revision, reason: 'Independent review' }
        const refused = await transition(request(body), context)
        assert.equal(refused.status, 422)
        assert.match((await refused.json()).error, /someone other than the author/)
        state.actorId = f.reviewerId
        const approved = await transition(request(body), context)
        assert.equal(approved.status, 200)
        const stale = await transition(request({ ...body, action: 'retire' }), context)
        assert.equal(stale.status, 422)
        assert.match((await stale.json()).error, /revision changed.*reload/)
        const current = await read(new Request('http://training.test'), context)
        assert.equal(current.status, 200)
        assert.equal((await current.json()).course.status, 'approved')
        const missing = await read(new Request('http://training.test'), {
          params: Promise.resolve({ courseId: randomUUID() }),
        })
        assert.equal(missing.status, 404)
      },
    )
  },
)

test(
  'participant boundary raises actual assessment and employment refusals without saving a partial result',
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(spec),
      async (f) => {
        state.orgId = f.org.orgId
        state.actorId = f.authorId
        const saved = await create(request(payload(f.org.subsidiaryId), randomUUID()))
        const row = await saved.json()
        state.actorId = f.reviewerId
        assert.equal(
          (
            await transition(
              request({ action: 'approve', expectedRevision: row.revision, reason: 'Reviewed delivery policy' }),
              { params: Promise.resolve({ courseId: row.id }) },
            )
          ).status,
          200,
        )
        state.actorId = f.authorId
        const { POST: createSession } = await import('./courses/[courseId]/sessions/route')
        const { POST: sessionAction } = await import('./sessions/[sessionId]/route')
        const { POST: invite } = await import('./sessions/[sessionId]/participants/route')
        const { POST: result } = await import('./participants/[participantId]/result/route')
        const sessionResponse = await createSession(
          request(
            {
              name: 'Safety delivery',
              location: 'Training room',
              timeZone: 'America/Toronto',
              startsAt: '2026-01-09T10:00:00Z',
              endsAt: '2026-01-09T11:00:00Z',
              capacity: 5,
              reason: 'Scheduled delivery',
            },
            randomUUID(),
          ),
          { params: Promise.resolve({ courseId: row.id }) },
        )
        assert.equal(sessionResponse.status, 201)
        const delivery = await sessionResponse.json(),
          sessionContext = { params: Promise.resolve({ sessionId: delivery.id }) }
        const scheduled = await sessionAction(
          request({ action: 'schedule', expectedRevision: delivery.revision, reason: 'Published delivery' }),
          sessionContext,
        )
        assert.equal(scheduled.status, 200)
        const subject = await seedEmployment(f.org.orgId, f.org.subsidiaryId, { from: '2026-01-01' })
        const hidden = await invite(
          request({ employmentId: randomUUID(), reason: 'Required safety training' }, randomUUID()),
          sessionContext,
        )
        assert.equal(hidden.status, 404)
        assert.equal(
          (await db.execute(sql`select id from hrm_training_participants where org_id=${f.org.orgId}`)).rows.length,
          0,
        )
        const invited = await invite(
          request({ employmentId: subject.employmentId, reason: 'Required safety training' }, randomUUID()),
          sessionContext,
        )
        assert.equal(invited.status, 201)
        const participant = await invited.json()
        const started = await sessionAction(
          request({
            action: 'start',
            expectedRevision: (await scheduled.json()).revision,
            reason: 'Instructor started session',
          }),
          sessionContext,
        )
        assert.equal(started.status, 200)
        const participantContext = { params: Promise.resolve({ participantId: participant.id }) }
        const body = {
          expectedRevision: participant.revision,
          attendanceSeconds: 3600,
          score: null,
          evidenceFileId: null,
          existingQualificationId: null,
          notes: null,
          reason: 'Instructor assessment',
        }
        const refused = await result(request(body), participantContext)
        assert.equal(refused.status, 422)
        assert.match((await refused.json()).error, /requires an assessment score.*record the score/)
        assert.equal(
          (
            await db.execute<{ status: string }>(
              sql`select status from hrm_training_participants where org_id=${f.org.orgId} and id=${participant.id}`,
            )
          ).rows[0]!.status,
          'invited',
        )
        const completed = await result(request({ ...body, score: 80 }), participantContext)
        assert.equal(completed.status, 200)
        assert.equal((await completed.json()).status, 'completed')
      },
    )
  },
)
