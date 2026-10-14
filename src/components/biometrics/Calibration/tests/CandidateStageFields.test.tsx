import { fireEvent, render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_STAGE_CLASSIFIER, type StageRuleset } from '@/src/lib/sleep-stage-rules'
import { CandidateStageFields } from '../CandidateStageFields'
const onChange = vi.fn()
const i18n = setupI18n({ locale: 'en', messages: {} })
const ruleset: StageRuleset = { ...DEFAULT_STAGE_CLASSIFIER.ruleset, transitions: [{ from: 'wake', to: 'deep', via: 'light' }] }
const element = (overrides: { path: string, value: unknown }[] = []) => <I18nProvider i18n={i18n}><CandidateStageFields ruleset={ruleset} overrides={overrides} onChange={onChange} /></I18nProvider>
beforeEach(() => onChange.mockClear())
it('reports only the changed bound of an outlier range', () => {
  render(element())
  fireEvent.change(screen.getByLabelText('heartRate minimum'), { target: { value: '40' } })
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenLastCalledWith('sleep_stages.ruleset.outliers.heartRate.min', 40)
  fireEvent.change(screen.getByLabelText('hrv maximum'), { target: { value: '500' } })
  expect(onChange).toHaveBeenCalledTimes(2)
  expect(onChange).toHaveBeenLastCalledWith('sleep_stages.ruleset.outliers.hrv.max', 500)
  fireEvent.change(screen.getByLabelText('breathingRate minimum'), { target: { value: String(ruleset.outliers.breathingRate.min) } })
  expect(onChange).toHaveBeenCalledTimes(2)
})
it('routes fallback, thresholds, smoothing and rule edits to candidate paths', () => {
  render(element())
  fireEvent.change(screen.getByLabelText('Fallback stage'), { target: { value: 'deep' } })
  expect(onChange).toHaveBeenLastCalledWith('sleep_stages.ruleset.fallback', 'deep')
  fireEvent.change(screen.getByLabelText('Candidate spike threshold'), { target: { value: '2.5' } })
  expect(onChange).toHaveBeenLastCalledWith('sleep_stages.ruleset.outliers.heartRateSpikeStdDevs', 2.5)
  fireEvent.change(screen.getByLabelText('Candidate low-signal threshold'), { target: { value: '0.4' } })
  expect(onChange).toHaveBeenLastCalledWith('sleep_stages.ruleset.lowSignalBelow', 0.4)
  fireEvent.click(screen.getByRole('switch', { name: 'Smooth isolated epochs' }))
  expect(onChange).toHaveBeenLastCalledWith('sleep_stages.ruleset.smoothIsolatedEpochs', !ruleset.smoothIsolatedEpochs)
  fireEvent.click(screen.getByRole('button', { name: 'Remove candidate rule 1' }))
  expect(onChange).toHaveBeenLastCalledWith('sleep_stages.ruleset.rules', ruleset.rules.slice(1))
  fireEvent.click(screen.getByRole('button', { name: 'Candidate rule' }))
  expect(onChange).toHaveBeenLastCalledWith('sleep_stages.ruleset.rules', [...ruleset.rules, expect.objectContaining({ stage: 'wake' })])
  fireEvent.click(screen.getByRole('button', { name: 'Remove candidate low-signal rule 1' }))
  expect(onChange).toHaveBeenLastCalledWith('sleep_stages.ruleset.lowSignalRules', ruleset.lowSignalRules.slice(1))
  fireEvent.click(screen.getByRole('button', { name: 'Candidate low-signal rule' }))
  expect(onChange).toHaveBeenLastCalledWith('sleep_stages.ruleset.lowSignalRules', [...ruleset.lowSignalRules, expect.objectContaining({ stage: 'wake' })])
})
it('opens and closes the transitions editor and forwards transition edits', () => {
  render(element())
  fireEvent.click(screen.getByRole('button', { name: 'Transition 1 from' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove transition 1' }))
  expect(onChange).toHaveBeenLastCalledWith('sleep_stages.ruleset.transitions', [])
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(screen.queryByRole('button', { name: 'Remove transition 1' })).toBeNull()
})
it('lists only stage overrides and removes them by path', () => {
  const result = render(element([{ path: 'heart_rate.trackingToleranceBpm', value: 18 }]))
  expect(screen.getByText('Inherited default')).toBeTruthy()
  result.rerender(element([{ path: 'sleep_stages.ruleset.fallback', value: 'deep' }]))
  expect(screen.queryByText('Inherited default')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Remove stage override' }))
  expect(onChange).toHaveBeenLastCalledWith('sleep_stages.ruleset.fallback', undefined)
})
