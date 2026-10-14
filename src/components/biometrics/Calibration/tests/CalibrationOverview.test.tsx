import { render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { CalibrationOverview } from '../CalibrationOverview'
const mock = vi.hoisted(() => ({ overview: { data: undefined as unknown, error: null as Error | null }, activation: { data: undefined as unknown, error: null as Error | null } }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { biometricTuning: {
  getProfileOverview: { useQuery: () => mock.overview },
  getActivationStatus: { useQuery: () => mock.activation },
} } }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const element = () => <I18nProvider i18n={i18n}><CalibrationOverview side="left" /></I18nProvider>
beforeEach(() => {
  mock.overview = { data: { desired: { isDefault: true, hash: 'hash', binding: { generation: 1 }, warning: null },
    runtimeHealth: { state: 'current', components: [{ component: 'heart_rate', state: 'current' }, { component: 'custom', state: 'failed' }] },
    stageView: { provenance: { warning: 'Recomputed stages' } },
    sensorCalibration: [{ id: 'a', sensorType: 'piezo', status: 'ok', freshness: 'current' }, { id: 'b', sensorType: 'cap', status: 'ok', freshness: 'expired' }, { id: 'c', sensorType: 'temp', status: 'ok', freshness: 'other' }],
    limitations: ['Limited to one night'] }, error: null }
  mock.activation = { data: undefined, error: new Error('Activation unavailable') }
})
it('shows the error or skeleton before data arrives', () => {
  mock.overview = { data: undefined, error: new Error('Overview unavailable') }
  const result = render(element())
  expect(screen.getByText('Overview unavailable')).toBeTruthy()
  mock.overview = { data: undefined, error: null }
  result.rerender(element())
  expect(screen.queryByText('Overview unavailable')).toBeNull()
  expect(screen.queryByText('Saved profile')).toBeNull()
})
it('falls back to raw component names, activation errors and sensor freshness labels', () => {
  render(element())
  expect(screen.getByText('System defaults')).toBeTruthy()
  expect(screen.getByText('Not reported')).toBeTruthy()
  expect(screen.getByText('Activation unavailable')).toBeTruthy()
  expect(screen.getByText('Heart rate')).toBeTruthy()
  expect(screen.getByText('custom')).toBeTruthy()
  expect(screen.getByText('Failed')).toBeTruthy()
  expect(screen.getByText('Recomputed stages')).toBeTruthy()
  expect(screen.getByText('Expired')).toBeTruthy()
  expect(screen.getByText('Freshness unknown')).toBeTruthy()
  expect(screen.getAllByText('Current')).toHaveLength(3)
  expect(screen.getByText('Limited to one night')).toBeTruthy()
  expect(screen.getByText('Generation 1')).toBeTruthy()
})
