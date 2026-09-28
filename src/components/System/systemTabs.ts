export type SystemTab = 'sensors' | 'diagnostics' | 'pipeline' | 'logs'

export const SYSTEM_TABS: ReadonlyArray<{ id: SystemTab, label: string, dev?: boolean }> = [
  { id: 'sensors', label: 'Sensors' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'pipeline', label: 'Pipeline', dev: true },
  { id: 'logs', label: 'Logs', dev: true },
]

/** Resolve `?tab=` to a visible tab — developer-only tabs fall back to Sensors. */
export function resolveSystemTab(raw: string | null, developer: boolean): SystemTab {
  const tab = SYSTEM_TABS.find(t => t.id === raw)
  if (!tab || (tab.dev && !developer)) return 'sensors'
  return tab.id
}
