import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const unit = vi.hoisted(() => ({ value: 'F' as 'F' | 'C' }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: unit.value }) }))

import { CurveCard, formatTempRange, formatWindow, stripIndexes } from '../CurveCard'
import type { ScheduleGroup } from '@/src/lib/scheduleGrouping'

afterEach(() => {
  cleanup()
  unit.value = 'F'
})

const weekday: ScheduleGroup = {
  key: 'wk',
  days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  setPoints: [
    { time: '23:15', temperature: 83 },
    { time: '00:30', temperature: 79 },
    { time: '03:00', temperature: 80 },
    { time: '07:00', temperature: 84 },
  ],
}

describe('formatters', () => {
  it('formats the window from chronological first/last set points', () => {
    expect(formatWindow(weekday.setPoints)).toBe('11:15 PM → 7:00 AM')
    expect(formatWindow([{ time: '22:00', temperature: 80 }])).toBeNull()
  })

  it('formats the temperature range in the user unit', () => {
    expect(formatTempRange(weekday.setPoints, 'F')).toBe('79–84°F')
    expect(formatTempRange(weekday.setPoints, 'F', false)).toBe('79–84°')
    expect(formatTempRange([{ temperature: 80 }], 'C')).toBe('27°C')
    expect(formatTempRange([], 'F')).toBe('')
  })
})

describe('CurveCard (featured)', () => {
  it('shows the active badge, window, and a set-point strip with power on/next/off', () => {
    const s = render(
      <CurveCard featured isActive group={weekday} onEdit={vi.fn()} onDelete={vi.fn()} nextEvent={{ time: '12:30 AM', temperature: 79 }} />,
    )
    expect(s.getByText('Mon–Fri')).toBeTruthy()
    expect(s.getAllByText('ACTIVE').length).toBeGreaterThan(0)
    expect(s.getAllByText('11:15 PM → 7:00 AM · 79–84°F').length).toBeGreaterThan(0)
    expect(s.getByText('Power on')).toBeTruthy()
    expect(s.getByText('Next')).toBeTruthy()
    expect(s.getByText('Power off')).toBeTruthy()
    expect(s.getByText('Off')).toBeTruthy()
    expect(s.getByTestId('curve-card-featured').className).toContain('border-ok-line')
  })

  it('omits active styling and the next line when not active', () => {
    const s = render(<CurveCard featured group={weekday} onEdit={vi.fn()} onDelete={vi.fn()} nextEvent={{ time: '12:30 AM', temperature: 79 }} />)
    expect(s.queryByText('ACTIVE')).toBeNull()
    expect(s.queryByText('Next')).toBeNull()
    expect(s.getByTestId('curve-card-featured').className).not.toContain('border-ok-line')
  })

  it('edits and deletes via the header icons', () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    const s = render(<CurveCard featured isActive group={weekday} onEdit={onEdit} onDelete={onDelete} />)
    fireEvent.click(s.getByRole('button', { name: 'Edit Mon–Fri' }))
    fireEvent.click(s.getByRole('button', { name: 'Delete Mon–Fri' }))
    expect(onEdit).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledOnce()
  })
})

describe('CurveCard (compact)', () => {
  it('opens the editor when the card is tapped, but delete does not also edit', () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    const s = render(<CurveCard group={{ ...weekday, days: ['saturday', 'sunday'] }} onEdit={onEdit} onDelete={onDelete} />)
    expect(s.getByText('11:15 PM → 7:00 AM')).toBeTruthy()
    expect(s.getByText('79–84°')).toBeTruthy()
    fireEvent.click(s.getByText('Sat, Sun'))
    expect(onEdit).toHaveBeenCalledOnce()
    fireEvent.click(s.getByRole('button', { name: 'Delete Sat, Sun' }))
    expect(onDelete).toHaveBeenCalledOnce()
    expect(onEdit).toHaveBeenCalledOnce()
  })

  it('renders paused curves dashed with PAUSED and no set points', () => {
    const s = render(<CurveCard featured group={{ key: 'p', days: ['wednesday'], setPoints: weekday.setPoints, allDisabled: true }} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(s.getByText('PAUSED')).toBeTruthy()
    expect(s.getByText('No set points active')).toBeTruthy()
    expect(s.getByText('Schedule paused')).toBeTruthy()
    expect(s.queryByTestId('curve-card-featured')).toBeNull()
  })
})

describe('stripIndexes', () => {
  it('shows every point when there are five or fewer', () => {
    expect(stripIndexes(3)).toEqual([0, 1, 2])
    expect(stripIndexes(5, 2)).toEqual([0, 1, 2, 3, 4])
  })

  it('keeps power on/off and starts the middle at the next set point', () => {
    expect(stripIndexes(20, 7)).toEqual([0, 7, 8, 9, 19])
    expect(stripIndexes(20, 18)).toEqual([0, 16, 17, 18, 19])
    expect(stripIndexes(20, 1)).toEqual([0, 1, 2, 3, 19])
  })

  it('spaces the middle evenly without an upcoming point', () => {
    expect(stripIndexes(9)).toEqual([0, 2, 4, 6, 8])
    expect(stripIndexes(9, 0)).toEqual([0, 2, 4, 6, 8])
    expect(stripIndexes(9, 8)).toEqual([0, 2, 4, 6, 8])
  })
})
