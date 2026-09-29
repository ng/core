import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  thermal: undefined as unknown,
  scheduler: undefined as unknown,
}))

vi.mock('next/dynamic', () => ({
  default: () => function DynamicStub() {
    return <div data-testid="chart" />
  },
}))
vi.mock('@/src/hooks/useSide', () => ({ useSide: () => ({ side: 'left' }) }))
vi.mock('@/src/hooks/useSideNames', () => ({
  useSideNames: () => ({ sideName: (s: 'left' | 'right') => (s === 'left' ? 'Jon' : 'Right') }),
}))
vi.mock('@/src/hooks/useWeekNavigator', () => ({ useWeekNavigator: () => ({ weekStart: new Date(0), weekEnd: new Date(1) }) }))
vi.mock('@/src/hooks/useTrendBuffer', () => ({ useTrendBuffer: () => [] }))
vi.mock('@/src/components/status/HealthStatusCard', () => ({ HealthStatusCard: () => null }))
vi.mock('@/src/components/status/SystemInfoCard', () => ({ SystemInfoCard: () => null }))
vi.mock('@/src/components/status/InternetToggleCard', () => ({ InternetToggleCard: () => null }))
vi.mock('@/src/components/status/UpdateCard', () => ({ UpdateCard: () => null }))
vi.mock('@/src/utils/trpc', () => {
  const query = (key: string) => ({
    useQuery: () => {
      if (key === 'health.thermal') return { data: mocks.thermal, isLoading: false, isFetching: false, error: null, dataUpdatedAt: 1 }
      if (key === 'health.scheduler') return { data: mocks.scheduler, isLoading: false }
      return { data: undefined, isLoading: false, isFetching: false, error: null }
    },
    useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  })
  const router = (prefix: string): unknown => new Proxy({}, {
    get: (_t, k: string) => (k === 'useQuery' || k === 'useMutation' ? query(prefix)[k] : router(prefix ? `${prefix}.${k}` : k)),
  })
  return { trpc: new Proxy({}, { get: (_t, k: string) => (k === 'useUtils' ? () => ({}) : router(k)) }) }
})

import { DiagnosticsConsole } from '../DiagnosticsConsole'

const side = (s: 'left' | 'right', over: Record<string, unknown> = {}) => ({
  side: s,
  verdict: 'delivering',
  isPowered: true,
  targetTempF: 76,
  currentTempF: 80.1,
  pumpRpm: 2410,
  readingAgeSec: 2,
  waterTempF: 78.1,
  bedSurfaceTempF: 79.6,
  guardBlocked: false,
  isAlarmVibrating: false,
  poweredOnAt: null,
  note: null,
  ...over,
})

beforeEach(() => {
  mocks.thermal = {
    pumpStallProtectionEnabled: true,
    heatsinkTempF: 94.2,
    ambientTempF: 76,
    sides: [side('left'), side('right', { targetTempF: 82, currentTempF: 81 })],
  }
  mocks.scheduler = {
    enabled: true,
    healthy: true,
    jobCounts: { total: 42 },
    upcomingJobs: [
      { id: 'a', type: 'temperature', side: 'left', nextRun: new Date(Date.now() + 3_600_000).toISOString(), targetTempF: 79 },
      { id: 'b', type: 'power_off', side: 'both', nextRun: new Date(Date.now() + 7_200_000).toISOString() },
    ],
  }
})

describe('DiagnosticsConsole', () => {
  it('renders the Dashboard with metrics, per-side thermal cards and next jobs', () => {
    render(<DiagnosticsConsole section="dashboard" onJump={vi.fn()} />)

    expect(screen.getByText('armed')).toBeTruthy()
    expect(screen.getByText('94.2°F')).toBeTruthy()
    expect(screen.getByText('42 jobs')).toBeTruthy()

    const left = screen.getByTestId('thermal-left')
    expect(within(left).getByText('Jon · left')).toBeTruthy()
    expect(within(left).getByText('COOLING')).toBeTruthy()
    expect(within(left).getByText('2,410')).toBeTruthy()
    const right = screen.getByTestId('thermal-right')
    expect(within(right).getByText('Right side')).toBeTruthy()
    expect(within(right).getByText('WARMING')).toBeTruthy()

    expect(screen.getByText('Temperature')).toBeTruthy()
    expect(screen.getByText('Jon · 79°F')).toBeTruthy()
    expect(screen.getByText('Power off')).toBeTruthy()
    expect(screen.getByText('Both')).toBeTruthy()
  })

  it('shows a stalled side as STALLED', () => {
    mocks.thermal = { ...(mocks.thermal as object), sides: [side('left', { verdict: 'stalled', note: 'pump stalled' })] }
    render(<DiagnosticsConsole section="dashboard" onJump={vi.fn()} />)
    expect(within(screen.getByTestId('thermal-left')).getByText('STALLED')).toBeTruthy()
    expect(screen.getByText('pump stalled')).toBeTruthy()
  })

  it('jumps from the Dashboard thermal card to Thermal', () => {
    const onJump = vi.fn()
    render(<DiagnosticsConsole section="dashboard" onJump={onJump} />)
    fireEvent.click(screen.getByTestId('thermal-left'))
    expect(onJump).toHaveBeenCalledWith('thermal')
  })
})

describe('DiagnosticsConsole calibration', () => {
  it('shows a row per sensor with Recalibrate as a secondary action', () => {
    render(<DiagnosticsConsole section="calibration" onJump={vi.fn()} />)
    for (const t of ['piezo', 'capacitance', 'temperature']) {
      const row = screen.getByTestId(`cal-${t}`)
      expect(within(row).getByRole('meter', { name: 'Calibration validity left' })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: /Calibrate all/ })).toBeTruthy()
    expect(screen.getByText('waiting for left piezo…')).toBeTruthy()
  })

  it('puts the vibration test under Health', () => {
    render(<DiagnosticsConsole section="health" onJump={vi.fn()} />)
    expect(screen.getByText('Test vibration')).toBeTruthy()
  })
})
