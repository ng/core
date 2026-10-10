/**
 * Expose a pump stall as a fault on the affected thermostat. A LeakSensor
 * produces Apple Home water-leak alerts even though we have no leak evidence.
 */
import { Characteristic, type Service } from 'hap-nodejs'
import { getPumpStallNotice } from '@/src/hardware/pumpStallNotification'
import type { Side } from '@/src/hardware/types'

const POLL_MS = 5_000

/** Bind read-only fault status and return its polling cleanup. */
export function bindPumpHealth(service: Service, side: Side): () => void {
  const read = () => getPumpStallNotice(side) != null
    ? Characteristic.StatusFault.GENERAL_FAULT
    : Characteristic.StatusFault.NO_FAULT
  let fault = read()
  service.addCharacteristic(Characteristic.StatusFault)
    .updateValue(fault)
    .onGet(read)

  const handle = setInterval(() => {
    const next = read()
    if (next === fault) return
    fault = next
    service.updateCharacteristic(Characteristic.StatusFault, fault)
  }, POLL_MS)
  handle.unref()
  return () => clearInterval(handle)
}
