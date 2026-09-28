import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  saveCurve: vi.fn(),
  detectCurveConflicts: vi.fn(),
  isMutating: false,
  allSchedules: undefined as unknown,
}))
vi.mock('@/src/hooks/useSchedule', () => ({
  useSchedule: () => ({
    saveCurve: m.saveCurve,
    detectCurveConflicts: m.detectCurveConflicts,
    isMutating: m.isMutating,
    allSchedules: m.allSchedules,
  }),
}))
vi.mock('@/src/providers/SideProvider', () => ({ useSide: () => ({ selectedSide: 'left' }) }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Jon', rightName: 'Heidi' }) }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))

import { CurveEditor } from '../CurveEditor'

const INITIAL = [
  { time: '07:00', temperature: 84 },
  { time: '23:15', temperature: 83 },
  { time: '00:30', temperature: 79 },
]

beforeEach(() => {
  m.saveCurve.mockReset().mockResolvedValue(undefined)
  m.detectCurveConflicts.mockReset().mockReturnValue([])
  m.isMutating = false
  m.allSchedules = undefined
})
afterEach(cleanup)

const saveCurveButton = (s: ReturnType<typeof render>) => s.getByRole('button', { name: 'Save curve' }) as HTMLButtonElement
const rows = (s: ReturnType<typeof render>) => s.queryAllByTestId('set-point-row')

describe('CurveEditor', () => {
  it('creates a curve from a preset for the picked days', async () => {
    const onClose = vi.fn()
    const s = render(<CurveEditor onClose={onClose} />)
    expect(s.getAllByText('New curve').length).toBeGreaterThan(0)
    expect(s.getByText('Start from a preset or add set points manually')).toBeTruthy()
    expect(saveCurveButton(s).disabled).toBe(true)

    fireEvent.click(s.getByRole('button', { name: 'Mon' }))
    fireEvent.click(s.getByRole('button', { name: 'Tue' }))
    fireEvent.click(s.getByRole('button', { name: /Balanced/ }))
    expect(s.getByRole('button', { name: /Balanced/ }).getAttribute('aria-pressed')).toBe('true')
    expect(rows(s).length).toBeGreaterThan(2)
    expect(s.getByText('Jon · Mon, Tue')).toBeTruthy()
    expect(saveCurveButton(s).disabled).toBe(false)

    fireEvent.click(saveCurveButton(s))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(m.detectCurveConflicts).toHaveBeenCalledWith(['monday', 'tuesday'], [])
    const arg = m.saveCurve.mock.calls[0][0]
    expect(arg.targetDays).toEqual(['monday', 'tuesday'])
    expect(arg.originalDays).toEqual([])
    expect(arg.setPoints).toHaveLength(rows(s).length)
    for (const sp of arg.setPoints) {
      expect(sp.temperature).toBeGreaterThanOrEqual(55)
      expect(sp.temperature).toBeLessThanOrEqual(110)
    }
  })

  it('lists set points chronologically with power on/off labels and edits them', async () => {
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
    expect(s.getAllByText('Edit curve').length).toBeGreaterThan(0)
    const list = rows(s)
    expect(list.map(r => within(r).getByRole('button', { name: /Edit set point/ }).textContent)).toEqual(['11:15 PM', '12:30 AM', '7:00 AM'])
    expect(within(list[0]).getByText('Power on')).toBeTruthy()
    expect(within(list[2]).getByText('Power off')).toBeTruthy()
    expect(within(list[1]).queryByText(/Power/)).toBeNull()

    fireEvent.click(s.getByRole('button', { name: 'Increase temperature at 11:15 PM' }))
    fireEvent.click(s.getByRole('button', { name: 'Delete set point 12:30 AM' }))
    expect(rows(s)).toHaveLength(2)

    fireEvent.click(saveCurveButton(s))
    await waitFor(() => expect(m.saveCurve).toHaveBeenCalled())
    expect(m.saveCurve.mock.calls[0][0]).toEqual({
      targetDays: ['monday'],
      setPoints: [{ time: '07:00', temperature: 84 }, { time: '23:15', temperature: 84 }],
      originalDays: ['monday'],
    })
  })

  it('adds a set point through the set-point dialog', () => {
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
    fireEvent.click(s.getByRole('button', { name: 'Add set point' }))
    const dialog = s.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '03:00' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add set point' }))
    expect(s.queryByRole('dialog')).toBeNull()
    expect(rows(s).map(r => within(r).getByRole('button', { name: /Edit set point/ }).textContent))
      .toEqual(['11:15 PM', '12:30 AM', '3:00 AM', '7:00 AM'])
  })

  it('asks before moving days that belong to another curve', async () => {
    m.detectCurveConflicts.mockReturnValue(['saturday'])
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
    fireEvent.click(s.getByRole('button', { name: 'Sat' }))
    fireEvent.click(saveCurveButton(s))
    const dialog = await waitFor(() => s.getByRole('dialog'))
    expect(within(dialog).getByText(/Sat is already part of another curve/)).toBeTruthy()
    expect(m.saveCurve).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move & save' }))
    await waitFor(() => expect(m.saveCurve).toHaveBeenCalled())
    expect(m.saveCurve.mock.calls[0][0].targetDays).toEqual(['monday', 'saturday'])
  })

  it('notes days that another curve already covers', () => {
    m.allSchedules = { temperature: [
      { dayOfWeek: 'saturday', enabled: true },
      { dayOfWeek: 'sunday', enabled: true },
      { dayOfWeek: 'monday', enabled: true },
      { dayOfWeek: 'friday', enabled: false },
    ] }
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
    expect(s.getByText('Sat, Sun use another curve')).toBeTruthy()
  })

  it('shows save failures inline', async () => {
    m.saveCurve.mockRejectedValue(new Error('scheduler reload failed'))
    const onClose = vi.fn()
    const s = render(<CurveEditor onClose={onClose} initialDays={['monday']} initialSetPoints={INITIAL} />)
    fireEvent.click(saveCurveButton(s))
    await waitFor(() => expect(s.getByText('scheduler reload failed')).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('cancels without saving', () => {
    const onClose = vi.fn()
    const s = render(<CurveEditor onClose={onClose} initialDays={['monday']} initialSetPoints={INITIAL} />)
    fireEvent.click(s.getAllByRole('button', { name: 'Cancel' })[0])
    expect(onClose).toHaveBeenCalled()
    expect(m.saveCurve).not.toHaveBeenCalled()
  })

  it('keeps coolest at least 2° below warmest', () => {
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={[{ time: '22:00', temperature: 80 }, { time: '06:00', temperature: 82 }]} />)
    fireEvent.click(s.getByRole('button', { name: 'Increase coolest temperature' }))
    const coolest = s.getByRole('group', { name: 'coolest temperature' })
    expect(coolest.textContent).toContain('80°')
    fireEvent.click(s.getByRole('button', { name: 'Decrease warmest temperature' }))
    expect(s.getByRole('group', { name: 'warmest temperature' }).textContent).toContain('82°')
  })
})
