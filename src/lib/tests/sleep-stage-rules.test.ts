import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STAGE_CLASSIFIER,
  DEFAULT_STAGE_RULESET,
  describeCondition,
  MOVEMENT_ONLY_STAGE_RULESET,
  resolveStageClassifier,
  STAGE_RULESET_PRESETS,
  stageClassifierSchema,
  stageRulesetSchema,
} from '../sleep-stage-rules'

describe('stage rulesets', () => {
  it('ships presets that pass their own validation', () => {
    for (const preset of Object.values(STAGE_RULESET_PRESETS)) {
      expect(stageRulesetSchema.safeParse(preset.ruleset).success).toBe(true)
    }
  })

  it('rejects an inverted outlier range', () => {
    const bad = { ...DEFAULT_STAGE_RULESET, outliers: { ...DEFAULT_STAGE_RULESET.outliers, hrv: { min: 300, max: 1 } } }
    expect(stageRulesetSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects unknown metrics, operators, stages and extra keys', () => {
    const rule = (when: unknown, stage: unknown = 'wake') => ({ ...DEFAULT_STAGE_RULESET, rules: [{ stage, when: [when] }] })
    expect(stageRulesetSchema.safeParse(rule({ metric: 'spo2', op: '<', value: 1 })).success).toBe(false)
    expect(stageRulesetSchema.safeParse(rule({ metric: 'hrv', op: '==', value: 1 })).success).toBe(false)
    expect(stageRulesetSchema.safeParse(rule({ metric: 'hrv', op: '<', value: 1 }, 'n3')).success).toBe(false)
    expect(stageRulesetSchema.safeParse(rule({ metric: 'hrv', op: '<', value: Number.NaN })).success).toBe(false)
    expect(stageRulesetSchema.safeParse({ ...DEFAULT_STAGE_RULESET, script: 'x' }).success).toBe(false)
  })

  it('caps rule, condition and transition counts', () => {
    const condition = { metric: 'hrv', op: '<', value: 1 }
    expect(stageRulesetSchema.safeParse({ ...DEFAULT_STAGE_RULESET, rules: [{ stage: 'wake', when: Array(9).fill(condition) }] }).success).toBe(false)
    expect(stageRulesetSchema.safeParse({ ...DEFAULT_STAGE_RULESET, rules: Array(33).fill({ stage: 'wake', when: [] }) }).success).toBe(false)
    expect(stageRulesetSchema.safeParse({ ...DEFAULT_STAGE_RULESET, transitions: Array(17).fill({ from: 'wake', to: 'deep', via: 'light' }) }).success).toBe(false)
  })

  it('only accepts known engines', () => {
    expect(stageClassifierSchema.safeParse(DEFAULT_STAGE_CLASSIFIER).success).toBe(true)
    expect(stageClassifierSchema.safeParse({ engine: 'neural', ruleset: DEFAULT_STAGE_RULESET }).success).toBe(false)
  })

  it('movement-only ignores heart signals and never enters low-signal mode', () => {
    expect(MOVEMENT_ONLY_STAGE_RULESET.rules.flatMap(r => r.when.map(c => c.metric))).toEqual(['movement'])
    expect(MOVEMENT_ONLY_STAGE_RULESET.lowSignalBelow).toBe(0)
  })
})

describe('resolveStageClassifier', () => {
  it('uses the defaults for nothing stored or an invalid stored value', () => {
    expect(resolveStageClassifier(null)).toBe(DEFAULT_STAGE_CLASSIFIER)
    expect(resolveStageClassifier(undefined)).toBe(DEFAULT_STAGE_CLASSIFIER)
    expect(resolveStageClassifier({ engine: 'rules', ruleset: { rules: [] } })).toBe(DEFAULT_STAGE_CLASSIFIER)
  })

  it('returns a valid stored classifier', () => {
    const stored = { engine: 'rules', ruleset: MOVEMENT_ONLY_STAGE_RULESET }
    expect(resolveStageClassifier(stored)).toEqual(stored)
  })
})

describe('describeCondition', () => {
  it('labels the metric and appends its unit', () => {
    expect(describeCondition({ metric: 'hrRatio', op: '<', value: 0.92 })).toBe('HR ratio < 0.92')
    expect(describeCondition({ metric: 'heartRate', op: '>=', value: 80 })).toBe('Heart rate >= 80 bpm')
    expect(describeCondition({ metric: 'movement', op: '>', value: 200 })).toBe('Movement > 200')
  })
})
