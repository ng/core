import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
  streamEnabled: [] as boolean[],
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => mocks.params,
  useRouter: () => ({ replace: mocks.replace }),
  usePathname: () => '/en/system',
}))
vi.mock('next/dynamic', () => ({
  default: () => function DynamicStub() {
    return <div data-testid="dynamic-tab" />
  },
}))
vi.mock('@/src/hooks/useSensorStream', () => ({
  useSensorStream: ({ enabled }: { enabled: boolean }) => {
    mocks.streamEnabled.push(enabled)
    return {
      status: 'connected',
      fps: 30,
      lastError: null,
      latestFrames: { capSense2: {}, bedTemp2: {}, frzHealth: {} },
      lastFrameTime: null,
    }
  },
}))
vi.mock('@/src/components/Sensors/SensorsScreen', () => ({
  SensorsScreen: ({ streamEnabled }: { streamEnabled: boolean }) => <div data-testid="sensors-tab">{String(streamEnabled)}</div>,
}))
vi.mock('@/src/components/PullToRefresh/PullToRefresh', () => ({
  PullToRefresh: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { SystemScreen, resolveSystemTab } from '../SystemScreen'

beforeEach(() => {
  mocks.params = new URLSearchParams()
  mocks.replace.mockClear()
  mocks.streamEnabled = []
})

describe('resolveSystemTab', () => {
  it('defaults to sensors for missing or unknown tabs', () => {
    expect(resolveSystemTab(null)).toBe('sensors')
    expect(resolveSystemTab('nope')).toBe('sensors')
  })

  it('resolves every tab for everyone', () => {
    expect(resolveSystemTab('diagnostics')).toBe('diagnostics')
    expect(resolveSystemTab('pipeline')).toBe('pipeline')
    expect(resolveSystemTab('logs')).toBe('logs')
  })
})

describe('SystemScreen', () => {
  it('shows all four tabs with Sensors selected by default', () => {
    render(<SystemScreen />)
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['Sensors', 'Diagnostics', 'Pipeline', 'Logs'])
    expect(screen.getByRole('tab', { name: 'Sensors' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('sensors-tab').textContent).toBe('true')
  })

  it('reads the active tab from ?tab= and writes tab changes to the URL', () => {
    mocks.params = new URLSearchParams('tab=diagnostics&section=thermal')
    render(<SystemScreen />)
    expect(screen.getByRole('tab', { name: 'Diagnostics' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('dynamic-tab')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Sensors' }))
    expect(mocks.replace).toHaveBeenCalledWith('/en/system', { scroll: false })
  })

  it('keeps other params when switching to diagnostics', () => {
    mocks.params = new URLSearchParams('foo=1')
    render(<SystemScreen />)
    fireEvent.click(screen.getByRole('tab', { name: 'Diagnostics' }))
    expect(mocks.replace).toHaveBeenCalledWith('/en/system?foo=1&tab=diagnostics', { scroll: false })
  })

  it('shows live stream stats and Stop pauses the stream', () => {
    render(<SystemScreen />)
    expect(screen.getByTestId('stream-status').textContent).toContain('LIVE')
    expect(screen.getByText('30 fps')).toBeTruthy()
    expect(screen.getByText('3 sensors')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(mocks.streamEnabled.at(-1)).toBe(false)
    expect(screen.getByTestId('stream-status').textContent).toBe('PAUSED')
    expect(screen.getByTestId('sensors-tab').textContent).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(mocks.streamEnabled.at(-1)).toBe(true)
  })
})
