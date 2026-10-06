import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { DB, setupHarness, withHarness, seedEmployment } from '@openbooks/engine/testing/hrm'
import { db } from '@openbooks/engine/platform/database'
import {
  createTrainingCourse,
  transitionTrainingCourse,
  createTrainingSession,
  transitionTrainingSession,
  inviteTrainingParticipant,
  completeTrainingParticipant,
} from '@openbooks/engine/hrm/training'

const state = { orgId: '', actorId: '' }
Object.assign(globalThis, { __ownTrainingActor: state })
registerHooks({
  resolve(specifier, context, next) {
    const virtual = (source: string) => ({
      shortCircuit: true as const,
      url: 'data:text/javascript,' + encodeURIComponent(source),
    })
    if (specifier === '@/lib/feature-gates' && context.parentURL?.includes('/lib/api/route'))
      return virtual(
        `export async function guardFeaturePermission(){const s=globalThis.__ownTrainingActor;return {user:{orgId:s.orgId,id:s.actorId},allowedSubsidiaryIds:null}}`,
      )
    if (specifier === '@/lib/analytics/preview-invalidation')
      return virtual('export async function invalidateAnalyticsPreviews(){}')
    return next(specifier, context)
  },
})
const { GET: list } = await import('./route')
const { GET: read, POST: respond } = await import('./participants/[participantId]/route')
const { POST: feedback } = await import('./participants/[participantId]/feedback/route')
const spec = {
  features: ['hrm', 'hrmCertifications', 'hrmTraining'],
  users: [
    {
      key: 'authorId',
      name: 'Course author',
      handle: 'me_training_author',
      permissions: ['hrm.certifications.read', 'hrm.certifications.manage'],
      link: true,
    },
    {
      key: 'reviewerId',
      name: 'Course reviewer',
      handle: 'me_training_reviewer',
      permissions: ['hrm.certifications.read', 'hrm.certifications.manage'],
      link: true,
    },
    {
      key: 'employeeId',
      name: 'Participant',
      handle: 'me_training_employee',
      permissions: ['hrm.self.read', 'hrm.self.request'],
      link: true,
      partyKey: 'employeePartyId',
    },
    {
      key: 'peerId',
      name: 'Peer participant',
      handle: 'me_training_peer',
      permissions: ['hrm.self.read', 'hrm.self.request'],
      link: true,
      partyKey: 'peerPartyId',
    },
  ],
} as const
const request = (body: unknown, key?: string) =>
  new Request('http://training.test/api/me/training', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  })

test(
  'employee training API reads and responds only to the linked employee and cannot acquire staff authority',
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(spec),
      async (f) => {
        const actor = { orgId: f.org.orgId, actorId: f.authorId },
          own = await seedEmployment(f.org.orgId, f.org.subsidiaryId, {
            workerPartyId: f.employeePartyId,
            from: '2026-01-01',
          }),
          peer = await seedEmployment(f.org.orgId, f.org.subsidiaryId, {
            workerPartyId: f.peerPartyId,
            from: '2026-01-01',
          })
        const course = await createTrainingCourse({
          ...actor,
          id: randomUUID(),
          subsidiaryId: f.org.subsidiaryId,
          code: 'SAFETY',
          version: 1,
          name: 'Safety',
          description: null,
          effectiveFrom: '2026-01-01',
          effectiveTo: null,
          qualificationTypeId: null,
          minimumAttendancePercent: 90,
          passingScore: null,
          reason: 'Required attendance',
        })
        await transitionTrainingCourse({
          ...actor,
          actorId: f.reviewerId,
          courseId: course.id,
          expectedRevision: course.revision,
          action: 'approve',
          reason: 'Independent approval',
        })
        const draft = await createTrainingSession({
          ...actor,
          id: randomUUID(),
          courseId: course.id,
          name: 'January safety',
          location: 'Training room',
          startsAt: '2026-01-09T10:00:00Z',
          endsAt: '2026-01-09T11:00:00Z',
          timeZone: 'America/Toronto',
          capacity: 2,
          reason: 'Published schedule',
        })
        const session = await transitionTrainingSession({
          ...actor,
          sessionId: draft.id,
          expectedRevision: draft.revision,
          action: 'schedule',
          reason: 'Open invitations',
        })
        const invite = await inviteTrainingParticipant({
          ...actor,
          id: randomUUID(),
          sessionId: session.id,
          employmentId: own.employmentId,
          reason: 'Safety invitation',
        })
        const other = await inviteTrainingParticipant({
          ...actor,
          id: randomUUID(),
          sessionId: session.id,
          employmentId: peer.employmentId,
          reason: 'Peer invitation',
        })
        state.orgId = f.org.orgId
        state.actorId = f.employeeId
        const ownContext = { params: Promise.resolve({ participantId: invite.id }) },
          peerContext = { params: Promise.resolve({ participantId: other.id }) }
        const rows = await list(new Request('http://training.test'))
        assert.equal(rows.status, 200)
        assert.deepEqual(
          (await rows.json()).map((row: { id: string }) => row.id),
          [invite.id],
        )
        assert.equal((await read(new Request('http://training.test'), peerContext)).status, 404)
        const body = { action: 'accept', expectedRevision: invite.revision, reason: 'I will attend' }
        assert.equal((await respond(request({ ...body, audience: 'staff' }), ownContext)).status, 422)
        assert.equal((await respond(request(body), peerContext)).status, 404)
        assert.equal(
          (await respond(request({ ...body, action: 'cancel' }), ownContext)).status,
          422,
          'Employee controls cannot cancel an administrative invitation',
        )
        const accepted = await respond(request(body), ownContext)
        assert.equal(accepted.status, 200)
        const attendee = await accepted.json()
        assert.equal(attendee.status, 'accepted')
        const retry = await respond(request(body), ownContext)
        assert.equal(retry.status, 200)
        assert.equal((await retry.json()).revision, attendee.revision)
        assert.equal(
          (
            await db.execute<{ status: string }>(
              sql`select status from hrm_training_participants where org_id=${f.org.orgId} and id=${other.id}`,
            )
          ).rows[0]!.status,
          'invited',
        )
        await transitionTrainingSession({
          ...actor,
          sessionId: session.id,
          expectedRevision: session.revision,
          action: 'start',
          reason: 'Instructor started delivery',
        })
        await completeTrainingParticipant({
          ...actor,
          participantId: invite.id,
          expectedRevision: attendee.revision,
          attendanceSeconds: 3600,
          score: null,
          evidenceFileId: null,
          existingQualificationId: null,
          notes: null,
          reason: 'Attendance confirmed',
        })
        const comment = { rating: 4, comments: 'Clear instruction', supersedesId: null, reason: 'My course feedback' },
          key = randomUUID()
        assert.equal((await feedback(request(comment, key), peerContext)).status, 404)
        const first = await feedback(request(comment, key), ownContext)
        assert.equal(first.status, 201)
        const saved = await first.json()
        assert.equal(saved.createdBy, f.employeeId)
        const replay = await feedback(request(comment, key), ownContext)
        assert.equal(replay.status, 201)
        assert.equal((await replay.json()).id, saved.id)
        const changed = await feedback(request({ ...comment, rating: 5 }, key), ownContext)
        assert.equal(changed.status, 422)
        assert.match((await changed.json()).error, /different content.*preserved/)
        assert.equal(
          (await db.execute(sql`select id from hrm_training_feedback where org_id=${f.org.orgId}`)).rows.length,
          1,
        )
      },
    )
  },
)
