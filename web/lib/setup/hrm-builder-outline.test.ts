import assert from 'node:assert/strict'
import test from 'node:test'
import {
  moveQuestion,
  outlineOrder,
  pipelineIssues,
  reviewTemplateIssues,
  stageKeyFor,
  type PipelineStageNode,
  type ReviewSectionNode,
} from './hrm-builder-outline'

const question = (id: string, sectionId: string, required = false) => ({
  id, sectionId, position: 0, prompt: id, answerKind: 'rating' as const, required,
})
const section = (id: string, questions: ReturnType<typeof question>[], kind: ReviewSectionNode['kind'] = 'competency'): ReviewSectionNode => ({
  id, position: 0, title: id, kind, weight: null, competencyId: null, questions,
})
const stage = (id: string, kind: PipelineStageNode['kind']): PipelineStageNode => ({
  id, position: 0, key: id, name: id, kind, isTerminal: kind === 'hired' || kind === 'rejected',
  activeApplications: 0, totalApplications: 0, kits: [],
})

test('a question dragged into another section moves there and takes its section id', () => {
  const outline = [section('a', [question('q1', 'a'), question('q2', 'a')]), section('b', [question('q3', 'b')])]
  const next = moveQuestion(outline, 'q1', 'b', 1)
  assert.deepEqual(outlineOrder(next), { sections: [{ id: 'a', questionIds: ['q2'] }, { id: 'b', questionIds: ['q3', 'q1'] }] })
  assert.equal(next[1]!.questions[1]!.sectionId, 'b')
  // Within one section it reorders; a move onto its own place is a no-op.
  assert.deepEqual(outlineOrder(moveQuestion(outline, 'q2', 'a', 0)).sections[0]!.questionIds, ['q2', 'q1'])
  assert.equal(moveQuestion(outline, 'q1', 'a', 0), outline)
})

test('the review builder names what the performance service will refuse', () => {
  const optional = [section('a', [question('q1', 'a')]), section('g', [], 'goals'), section('e', [])]
  const template = { id: 't', name: 't', isActive: false, scaleMin: '1', scaleMax: '5', scaleLabels: [], cycleCount: 0, sections: optional }
  assert.deepEqual(reviewTemplateIssues(template), [
    { issue: 'inactive' },
    { issue: 'noRequiredQuestion' },
    // A goals section may ask nothing (it renders the cycle's goals); any other empty section is flagged.
    { issue: 'emptySection', sectionId: 'e' },
  ])
  const ready = { ...template, isActive: true, sections: [section('a', [question('q1', 'a', true)])] }
  assert.deepEqual(reviewTemplateIssues(ready), [])
})

test('the pipeline builder names what the recruiting service will refuse', () => {
  assert.deepEqual(pipelineIssues({ isActive: true, stages: [] }), ['noStages'])
  assert.deepEqual(pipelineIssues({ isActive: true, stages: [stage('applied', 'screening'), stage('offer', 'offer')] }), ['noHiredStage'])
  assert.deepEqual(
    pipelineIssues({ isActive: true, stages: [stage('rejected', 'rejected'), stage('hired', 'hired'), stage('hired2', 'hired')] }),
    ['multipleHiredStages', 'terminalFirstStage'],
  )
  assert.deepEqual(pipelineIssues({ isActive: true, stages: [stage('applied', 'screening'), stage('hired', 'hired')] }), [])
})

test('stage keys derive from the name and stay unique within the pipeline', () => {
  assert.equal(stageKeyFor('Phone Screen', []), 'phone_screen')
  assert.equal(stageKeyFor('Entretien téléphonique', []), 'entretien_telephonique')
  assert.equal(stageKeyFor('Interview', ['interview', 'interview_2']), 'interview_3')
  assert.equal(stageKeyFor('面接', []), 'stage')
})
