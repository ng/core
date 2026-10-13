import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ReplaySessionPicker } from '../ReplaySessionPicker'
const mock = vi.hoisted(() => ({ sessions: vi.fn(), capability: vi.fn(), settings: vi.fn(), comparison: true }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  settings: { getAll: { useQuery: mock.settings } },
  biometricTuning: { listSessions: { useQuery: mock.sessions }, getSessionCapabilities: { useQuery: mock.capability } },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
function Harness({ initial = [] }: { initial?: number[] }) {
  const [selected, setSelected] = useState<number[]>(initial)
  return <I18nProvider i18n={i18n}><ReplaySessionPicker side="left" selected={selected} onChange={setSelected} /></I18nProvider>
}
beforeEach(() => {
  vi.clearAllMocks()
  mock.comparison = true
  mock.settings.mockReturnValue({ data: { device: { timezone: 'UTC' } } })
  mock.sessions.mockReturnValue({ data: { items: [{ id: 7, startMs: 1791673200000, endMs: 1791702000000 }], nextCursor: { startMs: 1791673200000, id: 7 } } })
  mock.capability.mockImplementation(() => ({ data: { comparison: mock.comparison, stageReplay: mock.comparison, processed: { vitals: { count: mock.comparison ? 20 : 0 }, movement: { count: 5 }, legacyUnknownProvenanceCount: 20 }, referenceMetrics: [], limitations: ['Raw context missing'] } }))
})
it('loads capabilities on demand and selects an inspected night with explicit limitations', () => {
  render(<Harness />)
  expect(mock.capability).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect session 7' }))
  expect(mock.capability).toHaveBeenCalledWith({ side: 'left', id: 7 })
  expect(screen.getByText(/Signal replay unavailable/)).toBeTruthy()
  expect(screen.getByText('No overlapping reference records.')).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include this session' }))
  expect(screen.getByText('Selected sessions: 1 / 60')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Remove session 7' }))
  expect(screen.getByText('Selected sessions: 0 / 60')).toBeTruthy()
})
it('does not offer processed replay when no stored vitals are available', () => {
  mock.comparison = false
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Inspect session 7' }))
  expect(screen.getByText('No stored vitals for comparison')).toBeTruthy()
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
})
it('paginates using the complete stable session cursor', () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Older nights' }))
  expect(mock.sessions).toHaveBeenLastCalledWith({ side: 'left', beforeStartMs: 1791673200000, beforeId: 7 })
  fireEvent.click(screen.getByRole('button', { name: 'Newest nights' }))
  expect(mock.sessions).toHaveBeenLastCalledWith({ side: 'left', beforeStartMs: undefined, beforeId: undefined })
})
it('shows listing loading, failures and empty nights', () => {
  mock.sessions.mockReturnValue({})
  const rendered = render(<Harness />)
  expect(screen.queryByRole('button', { name: /Inspect session/ })).toBeNull()
  mock.sessions.mockReturnValue({ error: { message: 'Nights unavailable' } })
  rendered.rerender(<Harness />)
  expect(screen.getByText('Nights unavailable')).toBeTruthy()
  mock.sessions.mockReturnValue({ data: { items: [], nextCursor: null } })
  rendered.rerender(<Harness />)
  expect(screen.getByText('No recorded nights for this side.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Older nights' })).toBeNull()
})
it('falls back to UTC when the device timezone is unknown or unusable', () => {
  mock.settings.mockReturnValue({})
  const rendered = render(<Harness />)
  expect(screen.getByText('Times shown in UTC')).toBeTruthy()
  mock.settings.mockReturnValue({ data: { device: { timezone: 'Not/AZone' } } })
  rendered.rerender(<Harness />)
  expect(screen.getByText('Times shown in UTC')).toBeTruthy()
  mock.settings.mockReturnValue({ data: { device: { timezone: 'America/New_York' } } })
  rendered.rerender(<Harness />)
  expect(screen.getByText('Times shown in America/New_York')).toBeTruthy()
})
it('collapses an inspected session and shows capability loading and failures', () => {
  mock.capability.mockReturnValue({})
  const rendered = render(<Harness />)
  const inspect = screen.getByRole('button', { name: 'Inspect session 7' })
  fireEvent.click(inspect)
  expect(screen.queryByRole('checkbox')).toBeNull()
  mock.capability.mockReturnValue({ error: { message: 'Capabilities unavailable' } })
  rendered.rerender(<Harness />)
  expect(screen.getByText('Capabilities unavailable')).toBeTruthy()
  fireEvent.click(inspect)
  expect(screen.queryByText('Capabilities unavailable')).toBeNull()
  expect(inspect.getAttribute('aria-expanded')).toBe('false')
})
it('lists overlapping reference metrics and lets a selected session be removed from the inspector', () => {
  mock.capability.mockReturnValue({ data: { comparison: true, stageReplay: false, processed: { vitals: { count: 20 }, movement: { count: 5 }, legacyUnknownProvenanceCount: 0 }, referenceMetrics: [{ metric: 'heart_rate', count: 3 }], limitations: [] } })
  render(<Harness initial={[7]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Inspect session 7' }))
  expect(screen.getByText('heart_rate: 3')).toBeTruthy()
  expect(screen.getByText('Stage replay unavailable')).toBeTruthy()
  const box = screen.getByRole('checkbox', { name: 'Include this session' }) as HTMLInputElement
  expect(box.checked).toBe(true)
  fireEvent.click(box)
  expect(screen.getByText('Selected sessions: 0 / 60')).toBeTruthy()
  expect(box.checked).toBe(false)
})
it('blocks further selection once sixty sessions are chosen', () => {
  render(<Harness initial={Array.from({ length: 60 }, (_, index) => index + 100)} />)
  expect(screen.getByText('Selected sessions: 60 / 60')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect session 7' }))
  expect((screen.getByRole('checkbox', { name: 'Include this session' }) as HTMLInputElement).disabled).toBe(true)
})
