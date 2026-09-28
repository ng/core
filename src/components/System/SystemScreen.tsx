'use client'

import { useCallback, useState } from 'react'
import dynamic from 'next/dynamic'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useSensorStream } from '@/src/hooks/useSensorStream'
import { usePrefs } from '@/src/providers/PrefsProvider'
import { Badge, PageHeader } from '@/src/components/ds'
import { PullToRefresh } from '@/src/components/PullToRefresh/PullToRefresh'
import { ConnectionStatusBar } from '@/src/components/Sensors/ConnectionStatusBar'
import { SensorsScreen } from '@/src/components/Sensors/SensorsScreen'
import { cn } from '@/lib/utils'
import { resolveSystemTab, SYSTEM_TABS, type SystemTab } from './systemTabs'

function TabLoading() {
  return <div role="status" className="h-64 animate-pulse rounded-card border border-line bg-surface" />
}

const DiagnosticsConsole = dynamic(
  () => import('@/src/components/diagnostics/DiagnosticsConsole').then(m => m.DiagnosticsConsole),
  { loading: TabLoading },
)
const PipelineTab = dynamic(
  () => import('@/src/components/Sensors/PipelineTab').then(m => m.PipelineTab),
  { ssr: false, loading: TabLoading },
)
const SystemLogViewer = dynamic(
  () => import('@/src/components/status/SystemLogViewer').then(m => m.SystemLogViewer),
  { loading: TabLoading },
)

export { resolveSystemTab, type SystemTab } from './systemTabs'

/** System = Sensors + Diagnostics (+ Pipeline / Logs in developer mode). */
export function SystemScreen() {
  const { developer } = usePrefs()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const tab = resolveSystemTab(searchParams.get('tab'), developer)

  const [streamEnabled, setStreamEnabled] = useState(true)
  const stream = useSensorStream({ enabled: streamEnabled })
  const sensorCount = Object.keys(stream.latestFrames).length

  const selectTab = useCallback((next: SystemTab) => {
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'sensors') params.delete('tab')
    else params.set('tab', next)
    if (next !== 'diagnostics') params.delete('section')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  /** Pull-to-refresh: toggle stream off/on to force a reconnect. */
  const handleRefresh = useCallback(async () => {
    setStreamEnabled(false)
    await new Promise(resolve => setTimeout(resolve, 300))
    setStreamEnabled(true)
  }, [])

  const visibleTabs = SYSTEM_TABS.filter(t => !t.dev || developer)

  return (
    <PullToRefresh onRefresh={handleRefresh} enabled={streamEnabled}>
      <div className="flex flex-col gap-3.5 min-[900px]:gap-[18px]">
        <span className="-mb-2 hidden font-mono text-[13px] text-fg-2 min-[900px]:block">System /</span>
        <PageHeader
          title={(
            <>
              <span className="min-[900px]:hidden">System</span>
              <span className="hidden min-[900px]:inline">{SYSTEM_TABS.find(t => t.id === tab)?.label ?? 'Sensors'}</span>
            </>
          )}
          className="gap-y-3.5"
          middle={(
            <div
              role="tablist"
              aria-label="System sections"
              className="order-last grid basis-full grid-flow-col auto-cols-fr rounded-card border border-line p-1 min-[900px]:hidden"
            >
              {visibleTabs.map((t) => {
                const on = t.id === tab
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => selectTab(t.id)}
                    className={cn(
                      'flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-seg border-0 px-2.5 py-2 text-[13px] transition-colors min-[900px]:rounded-[7px] min-[900px]:px-3 min-[900px]:py-1.5',
                      on ? 'bg-active font-medium text-fg min-[900px]:font-normal' : 'bg-transparent text-fg-2 hover:text-fg',
                      visibleTabs.length === 2 && 'text-sm min-[900px]:text-[13px]',
                    )}
                  >
                    {t.label}
                    {t.dev && <Badge className="hidden min-[900px]:inline">DEV</Badge>}
                  </button>
                )
              })}
            </div>
          )}
          right={(
            <ConnectionStatusBar
              status={stream.status}
              fps={stream.fps}
              lastError={stream.lastError}
              sensorCount={sensorCount}
              lastFrameTime={stream.lastFrameTime}
              paused={!streamEnabled}
              onToggle={() => setStreamEnabled(v => !v)}
            />
          )}
        />

        {tab === 'sensors' && <SensorsScreen streamEnabled={streamEnabled} />}
        {tab === 'diagnostics' && <DiagnosticsConsole />}
        {tab === 'pipeline' && <PipelineTab />}
        {tab === 'logs' && <SystemLogViewer />}
      </div>
    </PullToRefresh>
  )
}
