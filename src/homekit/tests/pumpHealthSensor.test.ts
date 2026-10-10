import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic, Service } from 'hap-nodejs'
import {
  clearPumpStallNotice,
  resetPumpStallNotifications,
  setPumpStallNotice,
} from '@/src/hardware/pumpStallNotification'
import { bindPumpHealth } from '../accessories/pumpHealthSensor'

describe('thermostat pump fault', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetPumpStallNotifications()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetPumpStallNotifications()
  })

  it.each(['left', 'right'] as const)('reports a pre-existing %s stall without creating a leak sensor', async (side) => {
    setPumpStallNotice(side, { alertId: 1, trippedAt: 0, rpm: 0, restore: null })
    const service = new Service.Thermostat(`Bed ${side}`, side)
    const stop = bindPumpHealth(service, side)
    expect(service.UUID).toBe(Service.Thermostat.UUID)
    expect(service.testCharacteristic(Characteristic.LeakDetected)).toBe(false)
    expect(await service.getCharacteristic(Characteristic.StatusFault).handleGetRequest())
      .toBe(Characteristic.StatusFault.GENERAL_FAULT)
    expect(service.getCharacteristic(Characteristic.StatusFault).props.perms).not.toContain('pw')
    stop()
  })

  it('publishes side-specific faults and clears them when the notice is resolved', async () => {
    const left = new Service.Thermostat('Left', 'left')
    const right = new Service.Thermostat('Right', 'right')
    const stopLeft = bindPumpHealth(left, 'left')
    const stopRight = bindPumpHealth(right, 'right')
    const update = vi.spyOn(right, 'updateCharacteristic')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(update).not.toHaveBeenCalled()
    setPumpStallNotice('right', { alertId: 1, trippedAt: 0, rpm: 0, restore: null })
    // GET is live even before the next notification poll.
    expect(await right.getCharacteristic(Characteristic.StatusFault).handleGetRequest()).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(update).toHaveBeenCalledExactlyOnceWith(Characteristic.StatusFault, 1)
    expect(await left.getCharacteristic(Characteristic.StatusFault).handleGetRequest()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(update).toHaveBeenCalledTimes(1)
    clearPumpStallNotice('right')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(update).toHaveBeenLastCalledWith(Characteristic.StatusFault, 0)
    expect(await right.getCharacteristic(Characteristic.StatusFault).handleGetRequest()).toBe(0)
    stopLeft()
    stopRight()
  })

  it('stops publishing after cleanup', async () => {
    const service = new Service.Thermostat('Left', 'left')
    const stop = bindPumpHealth(service, 'left')
    const update = vi.spyOn(service, 'updateCharacteristic')
    stop()
    setPumpStallNotice('left', { alertId: 1, trippedAt: 0, rpm: 0, restore: null })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(update).not.toHaveBeenCalled()
  })
})
