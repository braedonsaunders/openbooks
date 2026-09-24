export type TalentCodeKind = 'loss' | 'readiness' | 'planStatus'

const talentCodeKeys = {
  loss: {
    low: 'lossLevels.low',
    medium: 'lossLevels.medium',
    high: 'lossLevels.high',
  },
  readiness: {
    ready_now: 'readiness.readyNow',
    one_to_two_years: 'readiness.oneToTwoYears',
    three_plus: 'readiness.threePlusYears',
  },
  planStatus: {
    draft: 'planStatuses.draft',
    active: 'planStatuses.active',
    archived: 'planStatuses.archived',
  },
} as const

export function translateTalentCode<K extends TalentCodeKind>(
  kind: K,
  value: keyof (typeof talentCodeKeys)[K],
  translate: (key: string) => string,
): string {
  return translate(`performance.continuous.talent.${talentCodeKeys[kind][value]}`)
}
