import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { StageTrace } from '../StageTrace'
const mock = vi.hoisted(() => ({ query: vi.fn(), settings: vi.fn(), timeFormat: '24h' }))
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => mock.timeFormat }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { settings: { getAll: { useQuery: mock.settings } }, biometricTuning: { getBacktestTrace: { useQuery: mock.query } } } }))
const item = { cohortId: 'night-one', configurationHash: 'config-hash', revisionId: null, windowStartMs: 1791673200000, windowEndMs: 1791673800000, startMs: 1791673200000, endMs: 1791673260000, stage: 'wake' }
const page = { contentHash: 'report-hash', configuration: 'default', items: [item, { ...item, startMs: 1791673320000, endMs: 1791673380000, stage: 'deep' }], totalItems: 4, clockOffsetMs: 60000, nextCursor: { offset: 2, contentHash: 'report-hash' } }
const nights = [{ cohortId: 'night-one', evaluations: [{ label: 'default' as const, configHash: 'config-hash', windows: [] }, { label: 'candidate' as const, configHash: 'candidate-hash', windows: [] }] }]
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = () => <I18nProvider i18n={i18n}><StageTrace id="job-id" hash="report-hash" nights={nights} /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.query.mockReturnValue({ data: page })
  mock.settings.mockReturnValue({ data: { device: { timezone: 'UTC' } } })
  mock.timeFormat = '24h'
})
it('falls back to UTC without device settings or with an invalid timezone', () => {
  mock.settings.mockReturnValue({})
  mock.timeFormat = '12h'
  const rendered = render(view())
  expect(screen.getByText('Times shown in UTC')).toBeTruthy()
  expect(screen.getByText(/[AP]M – /)).toBeTruthy()
  mock.settings.mockReturnValue({ data: { device: { timezone: 'Not/AZone' } } })
  rendered.rerender(view())
  expect(screen.getByText('Times shown in UTC')).toBeTruthy()
  mock.settings.mockReturnValue({ data: { device: { timezone: 'Europe/Paris' } } })
  rendered.rerender(view())
  expect(screen.getByText('Times shown in Europe/Paris')).toBeTruthy()
})
it('waits for the trace, rejects configuration or cohort mismatches and ignores foreign cursors', () => {
  mock.query.mockReturnValue({})
  const rendered = render(view())
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.queryByText('Trace identity does not match the selected report.')).toBeNull()
  mock.query.mockReturnValue({ data: { ...page, configuration: 'candidate' } })
  rendered.rerender(view())
  expect(screen.getByText('Trace identity does not match the selected report.')).toBeTruthy()
  mock.query.mockReturnValue({ data: { ...page, items: [{ ...item, cohortId: 'night-two' }] } })
  rendered.rerender(view())
  expect(screen.getByText('Trace identity does not match the selected report.')).toBeTruthy()
  mock.query.mockReturnValue({ data: { ...page, nextCursor: { offset: 2, contentHash: 'other-hash' } } })
  rendered.rerender(view())
  fireEvent.click(screen.getByRole('button', { name: 'Next trace page' }))
  expect(mock.query.mock.lastCall?.[0].offset).toBe(0)
})
it('steps back to the previous page and switches nights', () => {
  mock.query.mockImplementation(input => ({ data: { ...page, items: page.items.map(entry => ({ ...entry, cohortId: input.cohortId })) } }))
  const twoNights = [...nights, { cohortId: 'night-two', evaluations: [{ label: 'candidate' as const, configHash: 'candidate-hash', windows: [] }] }]
  render(<I18nProvider i18n={i18n}><StageTrace id="job-id" hash="report-hash" nights={twoNights} /></I18nProvider>)
  expect((screen.getByRole('button', { name: 'Previous trace page' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Next trace page' }))
  expect(screen.getByText('Trace intervals 3–4 of 4')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Previous trace page' }))
  expect(screen.getByText('Trace intervals 1–2 of 4')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Trace night'), { target: { value: 'night-two' } })
  expect(mock.query.mock.lastCall?.[0]).toMatchObject({ cohortId: 'night-two', configuration: 'candidate', offset: 0 })
})
it('explains when no night or configuration can be traced', () => {
  const rendered = render(<I18nProvider i18n={i18n}><StageTrace id="job-id" hash="report-hash" nights={[]} /></I18nProvider>)
  expect(screen.getByText('No evaluated configuration is available.')).toBeTruthy()
  expect(mock.query).not.toHaveBeenCalled()
  rendered.rerender(<I18nProvider i18n={i18n}><StageTrace id="job-id" hash="report-hash" nights={[{ cohortId: 'night-one', evaluations: [] }]} /></I18nProvider>)
  expect(screen.getByText('No evaluated configuration is available.')).toBeTruthy()
})
it('pins requests to the report and leaves trace gaps unconnected with original timestamp details', () => {
  const rendered = render(view())
  expect(mock.query).toHaveBeenCalledWith({ id: 'job-id', expectedContentHash: 'report-hash', cohortId: 'night-one', configuration: 'default', offset: 0, limit: 200 }, { staleTime: 60000 })
  const chart = screen.getByRole('img')
  const lines = chart.querySelectorAll('line')
  expect(lines).toHaveLength(2)
  expect(Number(lines[0].getAttribute('x2'))).toBeLessThan(Number(lines[1].getAttribute('x1')))
  expect(screen.getByText(/frozen offset of 60000 ms/)).toBeTruthy()
  fireEvent.click(screen.getByText('Exact trace intervals'))
  expect(rendered.container.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(item.startMs).toISOString())
})
it('uses the returned cursor and resets paging when the selected configuration changes', async () => {
  mock.query.mockImplementation(input => ({ data: { ...page, configuration: input.configuration } }))
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Next trace page' }))
  expect(mock.query.mock.lastCall?.[0].offset).toBe(2)
  fireEvent.change(screen.getByLabelText('Trace configuration'), { target: { value: 'candidate' } })
  await waitFor(() => expect(mock.query.mock.lastCall?.[0]).toMatchObject({ configuration: 'candidate', offset: 0, expectedContentHash: 'report-hash' }))
})
it('does not draw mismatched, expired, or empty trace results', () => {
  mock.query.mockReturnValue({ data: { ...page, contentHash: 'other-hash' } })
  const rendered = render(view())
  expect(screen.getByText('Trace identity does not match the selected report.')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
  mock.query.mockReturnValue({ error: { message: 'Replay report was released' } })
  rendered.rerender(view())
  expect(screen.getByText('Replay report was released')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
  mock.query.mockReturnValue({ data: { ...page, items: [], totalItems: 0, nextCursor: null } })
  rendered.rerender(view())
  expect(screen.getByText('No stage intervals were produced for this selection.')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
})
