import assert from 'node:assert/strict'
import test from 'node:test'
import { TRAINING_COURSES_ENTITY, TRAINING_SESSIONS_ENTITY, TRAINING_PARTICIPANTS_ENTITY } from './hrm-training'
import { setupDomainPayload } from './domain-payload'
import { clearSetupChildren, setupTabParams } from './navigation'
import { courseBody, sessionBody, invitationBody } from '../../app/api/hrm/training/contracts'

const employer = '10000000-0000-4000-8000-000000000001'
const employment = '10000000-0000-4000-8000-000000000002'

test('native training forms preserve explicit policies and route-owned parent identities across strict APIs', () => {
  const cases = [
    [
      TRAINING_COURSES_ENTITY,
      {
        subsidiaryId: employer,
        code: 'SAFETY',
        version: '2',
        name: 'Safety',
        description: '',
        effectiveFrom: '2026-01-01',
        effectiveTo: '',
        qualificationTypeId: '',
        minimumAttendancePercent: '95',
        passingScore: '80',
        reason: 'Approved requirements',
      },
      courseBody,
    ],
    [
      TRAINING_SESSIONS_ENTITY,
      {
        subsidiaryId: employer,
        courseId: employer,
        name: 'Delivery',
        location: 'Training room',
        timeZone: 'America/Toronto',
        startsAt: '2026-11-01T01:30:00-05:00',
        endsAt: '2026-11-01T08:00:00Z',
        capacity: '12',
        reason: 'Instructor schedule',
      },
      sessionBody,
    ],
    [
      TRAINING_PARTICIPANTS_ENTITY,
      { subsidiaryId: employer, sessionId: employer, employmentId: employment, reason: 'Required safety training' },
      invitationBody,
    ],
  ] as const
  for (const [entity, values, schema] of cases) {
    const result = setupDomainPayload(entity, values, 'create')
    assert.ok(result.ok, result.ok ? 'The declared training form must parse' : result.error)
    assert.ok(schema.safeParse(result.body).success, entity.key)
    assert.equal(Object.hasOwn(result.body, 'courseId'), false)
    assert.equal(Object.hasOwn(result.body, 'sessionId'), false)
  }
  const blank = setupDomainPayload(TRAINING_COURSES_ENTITY, { ...cases[0][1], minimumAttendancePercent: '' }, 'create')
  assert.equal(blank.ok, false, 'A missing attendance policy cannot become an implicit default')
})

test('training parent navigation clears selected descendants while preserving the catalog search and employer context', () => {
  assert.equal(TRAINING_COURSES_ENTITY.createDestination?.rowParam, 'course')
  assert.equal(TRAINING_SESSIONS_ENTITY.createDestination?.rowParam, 'childRow')
  assert.equal(TRAINING_PARTICIPANTS_ENTITY.createDestination?.rowParam, 'childChildRow')
  const params = new URLSearchParams({
    course: employer,
    q: 'Safety',
    setupTab: 'sessions',
    childRow: employment,
    childTab: 'participants',
    childChildRow: employer,
    childChildTab: 'review',
  })
  const sessionReview = setupTabParams(params, 'review', 'child')
  assert.equal(sessionReview.get('course'), employer)
  assert.equal(sessionReview.get('childRow'), employment)
  assert.equal(sessionReview.has('childChildRow'), false)
  const courseReview = setupTabParams(params, 'review')
  assert.deepEqual(Object.fromEntries(courseReview), { course: employer, q: 'Safety', setupTab: 'review' })
  clearSetupChildren(params)
  params.delete('course')
  assert.deepEqual(Object.fromEntries(params), { q: 'Safety', setupTab: 'sessions' })
})
