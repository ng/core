export type SystemTab = 'dashboard' | 'biometrics' | 'calibration' | 'health' | 'logs' | 'pipeline' | 'scheduler' | 'sensors' | 'thermal'

/** Dashboard is the landing page and stays first; the rest are A–Z. */
export const SYSTEM_TABS: ReadonlyArray<{ id: SystemTab, label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'biometrics', label: 'Biometrics' },
  { id: 'calibration', label: 'Calibration' },
  { id: 'health', label: 'Health' },
  { id: 'logs', label: 'Logs' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'scheduler', label: 'Scheduler' },
  { id: 'sensors', label: 'Sensors' },
  { id: 'thermal', label: 'Thermal' },
]

function isSystemTab(v: string | null): v is SystemTab {
  return SYSTEM_TABS.some(t => t.id === v)
}

/**
 * Resolve `?tab=` to a tab — unknown values land on the Dashboard. Legacy
 * `?tab=diagnostics&section=X` links (Diagnostics used to nest these) map to X.
 */
export function resolveSystemTab(raw: string | null, section: string | null = null): SystemTab {
  if (raw === 'diagnostics') return isSystemTab(section) ? section : 'dashboard'
  return isSystemTab(raw) ? raw : 'dashboard'
}
