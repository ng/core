import { biometricsDb } from '@/src/db'
import { buildFlashReport, readFlash, recordFlashSample, type FlashReport } from '@/src/lib/flashHealth'

const SAMPLE_INTERVAL_MS = 3_600_000

let timer: NodeJS.Timeout | null = null

async function sampleOnce(): Promise<void> {
  const reading = await readFlash()
  if (reading) recordFlashSample(biometricsDb as never, reading, Date.now())
}

/** System → Storage's flash report, or null when the pod's eMMC isn't visible. */
export async function getFlashReport(): Promise<FlashReport | null> {
  const reading = await readFlash()
  return reading && buildFlashReport(biometricsDb as never, reading, Date.now())
}

/**
 * Record the eMMC's sectors-written counter hourly so System → Storage can
 * average writes per day across reboots. A row an hour is the whole cost.
 */
export function startFlashSampler(initialDelayMs = 60_000): void {
  if (timer) return
  const tick = () => {
    sampleOnce().catch((err) => {
      console.warn('[flash] sample failed:', err instanceof Error ? err.message : err)
    })
  }
  timer = setTimeout(() => {
    tick()
    timer = setInterval(tick, SAMPLE_INTERVAL_MS)
    timer.unref()
  }, initialDelayMs)
  timer.unref()
}

export function stopFlashSampler(): void {
  if (timer) {
    clearTimeout(timer)
    clearInterval(timer)
    timer = null
  }
}
