import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ webgl: true, load: vi.fn(), mount: vi.fn(), update: vi.fn(), dispose: vi.fn() }))
vi.mock('@/src/components/Base/loadThree', () => ({ hasWebGL: () => m.webgl, loadThree: m.load }))
vi.mock('../thermalScene', () => ({ mountThermalScene: m.mount }))
import ThermalCanvas from '../ThermalCanvas'
const states = { left: { zones: [20, 22, 24] as [number, number, number], direction: -1 as const, strength: 0.5 }, right: { zones: [30, 32, 34] as [number, number, number], direction: 1 as const, strength: 0.5 } }
beforeEach(() => {
  vi.clearAllMocks()
  m.webgl = true
  m.load.mockResolvedValue({})
  m.mount.mockReturnValue({ update: m.update, dispose: m.dispose })
})
afterEach(cleanup)
describe('ThermalCanvas lifecycle', () => {
  it('keeps a flat overview when WebGL or the loader is unavailable', async () => {
    m.webgl = false
    const first = render(<ThermalCanvas states={states} focus={null} />)
    expect(first.getByText('Surface overview')).toBeTruthy()
    expect(m.load).not.toHaveBeenCalled()
    first.unmount()
    m.webgl = true
    m.load.mockResolvedValue(null)
    const second = render(<ThermalCanvas states={states} focus={null} />)
    await act(async () => {})
    expect(second.getByText('Surface overview')).toBeTruthy()
    expect(m.mount).not.toHaveBeenCalled()
  })
  it('updates without rebuilding the scene and releases GPU resources on unmount', async () => {
    const view = render(<ThermalCanvas states={states} focus={null} />)
    await act(async () => {})
    expect(m.mount).toHaveBeenCalledTimes(1)
    view.rerender(<ThermalCanvas states={states} focus="right" />)
    expect(m.update).toHaveBeenLastCalledWith(states, 'right')
    expect(m.mount).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(m.dispose).toHaveBeenCalledTimes(1)
  })
  it('releases a lost context and selects the fallback', async () => {
    const view = render(<ThermalCanvas states={states} focus={null} />)
    await act(async () => {})
    act(() => m.mount.mock.lastCall?.[2]())
    expect(view.getByText('Surface overview')).toBeTruthy()
    expect(m.dispose).toHaveBeenCalledTimes(1)
  })
  it('does not mount a late library after the card has been closed', async () => {
    let resolve: (value: object) => void = () => {}
    m.load.mockReturnValue(new Promise<object>((r) => {
      resolve = r
    }))
    const view = render(<ThermalCanvas states={states} focus={null} />)
    view.unmount()
    await act(async () => resolve({}))
    expect(m.mount).not.toHaveBeenCalled()
  })
})
