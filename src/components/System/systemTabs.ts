export type SystemTab = 'sensors' | 'diagnostics' | 'pipeline' | 'logs'

export const SYSTEM_TABS: ReadonlyArray<{ id: SystemTab, label: string }> = [
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'logs', label: 'Logs' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'sensors', label: 'Sensors' },
]

/** Resolve `?tab=` to a tab — unknown values fall back to Sensors. */
export function resolveSystemTab(raw: string | null): SystemTab {
  return SYSTEM_TABS.find(t => t.id === raw)?.id ?? 'sensors'
}
