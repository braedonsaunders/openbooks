import assert from 'node:assert/strict'
import test from 'node:test'

import { SETUP_ENTITY_BY_KEY, SETUP_ENTITIES } from './registry'
import {
  RECRUITING_INTERVIEWER_POOLS_ENTITY,
  RECRUITING_KIT_ATTRIBUTES_ENTITY,
  RECRUITING_KIT_QUESTIONS_ENTITY,
  RECRUITING_KITS_ENTITY,
  RECRUITING_OFFER_TEMPLATES_ENTITY,
  RECRUITING_RETENTION_RULES_ENTITY,
} from './hrm-recruiting'

// HR-18 recruiting-depth Setup (0229): six registry entities, four rehomed
// onto /hrm/recruiting and two nested under their kit. Pure registry-shape
// assertions — the write-path refusals are proved against the DB suite.

const ENTITIES = [
  RECRUITING_KITS_ENTITY,
  RECRUITING_KIT_ATTRIBUTES_ENTITY,
  RECRUITING_KIT_QUESTIONS_ENTITY,
  RECRUITING_INTERVIEWER_POOLS_ENTITY,
  RECRUITING_OFFER_TEMPLATES_ENTITY,
  RECRUITING_RETENTION_RULES_ENTITY,
]

test('recruiting-depth entities register under their documented tables', () => {
  assert.deepEqual(
    ENTITIES.map((entity) => [entity.key, entity.table] as const),
    [
      ['hrm-interview-kits', 'hrm_interview_kits'],
      ['hrm-kit-attributes', 'hrm_scorecard_attributes'],
      ['hrm-kit-questions', 'hrm_interview_kit_questions'],
      ['hrm-interviewer-pools', 'hrm_interviewer_pools'],
      ['hrm-offer-templates', 'hrm_offer_templates'],
      ['hrm-retention-rules', 'hrm_retention_rules'],
    ],
  )
  for (const entity of ENTITIES) {
    assert.equal(SETUP_ENTITY_BY_KEY.get(entity.key), entity, `${entity.key} resolves from the registry`)
  }
})

test('recruiting-depth entities ride the sub-feature switches', () => {
  assert.deepEqual(
    ENTITIES.map((entity) => [entity.key, entity.featureKey] as const),
    [
      ['hrm-interview-kits', 'hrmStructuredInterviews'],
      ['hrm-kit-attributes', 'hrmStructuredInterviews'],
      ['hrm-kit-questions', 'hrmStructuredInterviews'],
      ['hrm-interviewer-pools', 'hrmInterviewScheduling'],
      ['hrm-offer-templates', 'hrmOfferSigning'],
      ['hrm-retention-rules', 'hrmCandidateRetention'],
    ],
  )
})

test('recruiting-depth top-level entities rehome to Recruiting, children nest', () => {
  for (const entity of [
    RECRUITING_KITS_ENTITY,
    RECRUITING_INTERVIEWER_POOLS_ENTITY,
    RECRUITING_OFFER_TEMPLATES_ENTITY,
    RECRUITING_RETENTION_RULES_ENTITY,
  ]) {
    assert.equal(entity.rehomed, true, `${entity.key} never renders on the setup rail`)
    assert.equal(entity.nestedUnder, undefined, `${entity.key} is top-level`)
  }
  assert.equal(RECRUITING_KIT_ATTRIBUTES_ENTITY.nestedUnder, 'hrm-interview-kits')
  assert.equal(RECRUITING_KIT_QUESTIONS_ENTITY.nestedUnder, 'hrm-interview-kits')
})

test('recruiting-depth refs resolve to visible entities', () => {
  for (const entity of ENTITIES) {
    for (const field of entity.fields) {
      if (field.kind !== 'ref' && field.kind !== 'multiref') continue
      assert.ok(
        field.ref === 'employees' || SETUP_ENTITY_BY_KEY.has(field.ref!),
        `${entity.key}.${field.key} refs a resolvable ${field.ref}`,
      )
    }
  }
})

test('recruiting-depth entities carry no multiref', () => {
  // The generic section renders multiref checkboxes with members={[]} and
  // the generic write path drops multiref columns — a multiref here would
  // silently wipe the stored list on every edit. Pool membership rides the
  // interview panel, never this registry.
  for (const entity of ENTITIES) {
    for (const field of entity.fields) {
      assert.notEqual(field.kind, 'multiref', `${entity.key}.${field.key} must not be multiref`)
    }
  }
})

test('recruiting-depth entity keys stay unique in the registry', () => {
  const keys = SETUP_ENTITIES.map((entity) => entity.key)
  assert.equal(new Set(keys).size, keys.length, 'registry keys are unique')
  for (const entity of ENTITIES) {
    assert.ok(keys.includes(entity.key), `${entity.key} is registered`)
  }
})
