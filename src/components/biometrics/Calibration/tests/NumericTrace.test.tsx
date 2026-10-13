import { fireEvent, render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { NumericTrace } from '../NumericTrace'
const mock = vi.hoisted(() => ({ query: vi.fn(), settings: vi.fn() }))
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => '24h' }))
vi.mock('../ReferenceOverlay', () => ({ ReferenceOverlay: ({ metric, points }: { metric: string, points: unknown[] }) => <p>{`Overlay ${metric} with ${points.length} points`}</p> }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { settings: { getAll: { useQuery: mock.settings } }, biometricTuning: { getBacktestNumericTrace: { useQuery: mock.query } } } }))
const item = { cohortId: 'night', configHash: 'config', side: 'left', sourceSide: 'right', timestampMs: 1791673200000,
  heartRate: 60, breathingRate: null, hrvIndex: null, qualityScore: 0, flags: null, limitations: ['unknown_context'] }
const page = { jobId: 'job', contentHash: 'hash', configuration: 'default', side: 'left', offset: 0, items: [item, { ...item, heartRate: null, timestampMs: item.timestampMs + 60000 }], totalItems: 4, clockOffsetMs: 60000, nextCursor: { offset: 2, contentHash: 'hash' } }
const nights = [{ cohortId: 'night', evaluations: [{ label: 'default' as const, configHash: 'config', windows: [] }, { label: 'candidate' as const, configHash: 'candidate', windows: [] }] }]
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = (rows = nights) => <I18nProvider i18n={i18n}><NumericTrace id="job" hash="hash" nights={rows} /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.settings.mockReturnValue({ data: { device: { timezone: 'UTC' } } })
  mock.query.mockReturnValue({ data: page })
})
it('shows exact timestamps, missing values and routing without interpolating gaps', () => {
  const rendered = render(view())
  expect(mock.query.mock.lastCall?.[0]).toEqual({ id: 'job', expectedContentHash: 'hash', cohortId: 'night', configuration: 'default', offset: 0, limit: 200 })
  expect(screen.getByRole('img').querySelectorAll('circle')).toHaveLength(1)
  expect(screen.getByRole('img').querySelectorAll('line,path')).toHaveLength(0)
  expect(screen.getByText('Missing')).toBeTruthy()
  expect(screen.getAllByText('Right')).toHaveLength(2)
  expect(rendered.container.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(item.timestampMs).toISOString())
  fireEvent.change(screen.getByLabelText('Numeric trace metric'), { target: { value: 'breathingRate' } })
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByText('No values for this metric on the current page.')).toBeTruthy()
})
it('pages by the returned hash cursor and resets on configuration change', () => {
  mock.query.mockImplementation(input => ({ data: { ...page, offset: input.offset, configuration: input.configuration,
    items: page.items.map(row => ({ ...row, configHash: input.configuration === 'candidate' ? 'candidate' : 'config' })), nextCursor: null } }))
  mock.query.mockReturnValueOnce({ data: page })
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Next numeric page' }))
  expect(mock.query.mock.lastCall?.[0].offset).toBe(2)
  fireEvent.click(screen.getByRole('button', { name: 'Previous numeric page' }))
  expect(mock.query.mock.lastCall?.[0].offset).toBe(0)
  fireEvent.change(screen.getByLabelText('Numeric trace configuration'), { target: { value: 'candidate' } })
  expect(mock.query.mock.lastCall?.[0]).toMatchObject({ offset: 0, configuration: 'candidate' })
})
it('rejects stale or wrong-side rows and does not follow invalid cursors', () => {
  mock.query.mockReturnValue({ data: { ...page, items: [{ ...item, side: 'right' }] } })
  const rendered = render(view())
  expect(screen.getByText('Numeric trace identity does not match the selected report.')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
  mock.query.mockReturnValue({ data: { ...page, nextCursor: { offset: 0, contentHash: 'hash' } } })
  rendered.rerender(view())
  expect(screen.getByRole('button', { name: 'Next numeric page' }).hasAttribute('disabled')).toBe(true)
  mock.query.mockReturnValue({ error: { message: 'Report released' } })
  rendered.rerender(view())
  expect(screen.getByText('Report released')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
})
it('falls back to UTC for unusable timezones and lists exact flags and limitations', () => {
  mock.settings.mockReturnValue({ data: { device: { timezone: 'Not/AZone' } } })
  mock.query.mockReturnValue({ data: { ...page, items: [
    { ...item, sourceSide: 'left', flags: ['clipped', 'gap'], limitations: [] },
    { ...item, timestampMs: item.timestampMs + 60000, flags: [], limitations: ['unknown_context'] },
  ] } })
  render(view())
  expect(screen.getByText('Original timestamps are shown in UTC. Reference scoring adds the frozen offset of 60000 ms.')).toBeTruthy()
  expect(screen.getByText('Left')).toBeTruthy()
  expect(screen.getByText('clipped, gap')).toBeTruthy()
  expect(screen.getAllByText('None')).toHaveLength(2)
  expect(screen.getByText('unknown_context')).toBeTruthy()
})
it('uses UTC while device settings are unavailable', () => {
  mock.settings.mockReturnValue({})
  render(view())
  expect(screen.getByText(/Original timestamps are shown in UTC/)).toBeTruthy()
})
it('describes empty and flat pages without inventing a range', () => {
  mock.query.mockReturnValue({ data: { ...page, items: [], totalItems: 0, nextCursor: null } })
  const rendered = render(view())
  expect(screen.getByText('Recomputed readings 0–0 of 0')).toBeTruthy()
  expect(rendered.container.querySelector('time')).toBeNull()
  mock.query.mockReturnValue({ data: { ...page, items: [item, { ...item, timestampMs: item.timestampMs + 60000 }] } })
  rendered.rerender(view())
  const circles = screen.getByRole('img').querySelectorAll('circle')
  expect(circles).toHaveLength(2)
  expect(Array.from(circles).map(circle => circle.getAttribute('cy'))).toEqual(['95', '95'])
})
it('overlays frozen references for the selected metric only on request', () => {
  render(view())
  expect(screen.queryByText(/^Overlay/)).toBeNull()
  const toggle = screen.getByRole('button', { name: 'Compare frozen references' })
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('Overlay heart_rate with 1 points')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Numeric trace metric'), { target: { value: 'breathingRate' } })
  expect(screen.getByText('Overlay breathing_rate with 0 points')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Numeric trace metric'), { target: { value: 'hrvIndex' } })
  expect(screen.getByText('Overlay window_ibi_variability_v1 with 0 points')).toBeTruthy()
  fireEvent.click(toggle)
  expect(screen.queryByText(/^Overlay/)).toBeNull()
})
it('waits for the trace and explains missing configurations', () => {
  mock.query.mockReturnValue({})
  const rendered = render(view())
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByText('No evaluated configuration is available.')).toBeNull()
  rendered.rerender(view([]))
  expect(screen.getByText('No evaluated configuration is available.')).toBeTruthy()
  rendered.rerender(view([{ cohortId: 'night', evaluations: [] }]))
  expect(screen.getByText('No evaluated configuration is available.')).toBeTruthy()
})
it('switches nights and re-reads the trace for the chosen cohort', () => {
  mock.query.mockImplementation(input => ({ data: { ...page, items: page.items.map(row => ({ ...row, cohortId: input.cohortId })) } }))
  render(view([...nights, { cohortId: 'second', evaluations: nights[0].evaluations }]))
  fireEvent.change(screen.getByLabelText('Numeric trace night'), { target: { value: 'second' } })
  expect(mock.query.mock.lastCall?.[0]).toMatchObject({ cohortId: 'second', offset: 0 })
})
it('falls back to the first evaluated configuration when defaults were not evaluated', () => {
  render(view([{ cohortId: 'night', evaluations: [{ label: 'candidate', configHash: 'candidate', windows: [] }] }]))
  expect(mock.query.mock.lastCall?.[0]).toMatchObject({ configuration: 'candidate' })
  expect((screen.getByLabelText('Numeric trace configuration') as HTMLSelectElement).value).toBe('candidate')
})
