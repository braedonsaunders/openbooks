import assert from 'node:assert/strict'
import test from 'node:test'
import { translateTalentCode } from './talent-labels.ts'

test('talent enum values render translated loss, readiness, and succession status labels', () => {
  const labels: Record<string, string> = {
    'performance.continuous.talent.lossLevels.high': 'Élevé',
    'performance.continuous.talent.readiness.readyNow': 'Prêt maintenant',
    'performance.continuous.talent.planStatuses.archived': 'Archivé',
  }
  const translate = (key: string) => labels[key] ?? `Missing translation: ${key}`

  assert.equal(translateTalentCode('loss', 'high', translate), 'Élevé')
  assert.equal(translateTalentCode('readiness', 'ready_now', translate), 'Prêt maintenant')
  assert.equal(translateTalentCode('planStatus', 'archived', translate), 'Archivé')
})
