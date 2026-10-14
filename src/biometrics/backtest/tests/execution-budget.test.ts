// @vitest-environment node
import { expect, it } from 'vitest'
import { replayBudgetSchema } from '../execution-budget'

const budget = { jobWallMs: 3600000, waveformWallMs: 600000, waveformCpuSeconds: 300 }
it('accepts nested ceilings and rejects budgets that cannot fit inside the job', () => {
  expect(replayBudgetSchema.parse(budget)).toEqual(budget)
  expect(() => replayBudgetSchema.parse({ ...budget, waveformWallMs: budget.jobWallMs + 1000 })).toThrow('fit within the job budget')
  expect(() => replayBudgetSchema.parse({ ...budget, waveformCpuSeconds: 601 })).toThrow('fit within the job budget')
  expect(() => replayBudgetSchema.parse({ ...budget, jobWallMs: 999 })).toThrow()
  expect(() => replayBudgetSchema.parse({ ...budget, extra: true })).toThrow()
})
