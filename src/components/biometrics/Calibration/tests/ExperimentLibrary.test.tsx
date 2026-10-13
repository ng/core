import { render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ExperimentLibrary } from '../ExperimentLibrary'
vi.mock('../BacktestSubmission', () => ({ BacktestSubmission: () => <p>Backtest form</p> }))
const mock = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { biometricTuning: { listExperiments: { useQuery: mock.list } } } }))
const experiment = (id: string, mode: string) => ({ id, datasetId: 'dataset-id', holdoutAccesses: 0, protocolHash: `${id}-hash`, protocol: { mode } })
const i18n = setupI18n({ locale: 'en', messages: {} })
beforeEach(() => {
  vi.clearAllMocks()
  mock.list.mockReturnValue({ data: { items: [experiment('comparison-id', 'comparison'), experiment('stage-id', 'stage_replay'), experiment('signal-id', 'signal_replay')], nextCursor: null } })
})
it('labels every experiment mode the builder can create', () => {
  render(<I18nProvider i18n={i18n}><ExperimentLibrary side="left" /></I18nProvider>)
  expect(mock.list).toHaveBeenCalledWith({ side: 'left', beforeCreatedAtMs: undefined, beforeId: undefined })
  expect(screen.getByText('Compare stored readings')).toBeTruthy()
  expect(screen.getByText('Replay sleep stages')).toBeTruthy()
  expect(screen.getByText('Replay retained waveforms')).toBeTruthy()
})
