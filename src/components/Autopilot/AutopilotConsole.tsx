/**
 * Autopilot console — hosts the Automations list, the Rule editor (modal), and
 * the Diagnostics/status panel. The view lives in `?view=`; desktop switches it
 * from the sidebar, phones from a segmented switch. Renders inside the
 * AppShell's <main>. Owns all tRPC data + mutations.
 */
'use client'

import { useCallback, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { trpc } from '@/src/utils/trpc'
import { PageHeader, SegmentedControl, StatusDot } from '@/src/components/ds'
import { AutomationsList, type ListItem } from './AutomationsList'
import { RuleEditor } from './RuleEditor'
import { StatusPanel } from './StatusPanel'
import { type BuilderRule, blankRule, fromAST, toAST } from './builderModel'
import { AUTOPILOT_VIEWS, resolveAutopilotView, type AutopilotView } from './autopilotViews'

export function AutopilotConsole() {
  const utils = trpc.useUtils()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const view = resolveAutopilotView(searchParams.get('view'))
  const setView = useCallback((next: AutopilotView) => {
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'automations') params.delete('view')
    else params.set('view', next)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])
  const [editing, setEditing] = useState<BuilderRule | null>(null)

  const listQ = trpc.automations.list.useQuery({})
  const statusQ = trpc.automations.status.useQuery({}, { refetchInterval: 15000 })
  const runsQ = trpc.automations.runs.useQuery({ limit: 100 }, { refetchInterval: 15000 })

  const invalidate = () => {
    void utils.automations.list.invalidate()
    void utils.automations.status.invalidate()
    void utils.automations.runs.invalidate()
  }

  const createM = trpc.automations.create.useMutation({ onSuccess: invalidate })
  const updateM = trpc.automations.update.useMutation({ onSuccess: invalidate })
  const setEnabledM = trpc.automations.setEnabled.useMutation({ onSuccess: invalidate })
  const setDryRunM = trpc.automations.setDryRun.useMutation({ onSuccess: invalidate })
  const killM = trpc.automations.setKillSwitch.useMutation({ onSuccess: () => {
    void utils.automations.status.invalidate()
    void utils.automations.getKillSwitch.invalidate()
  } })

  // Build list items from the rule rows + the status map (last-fired/today).
  const items: ListItem[] = useMemo(() => {
    const rows = listQ.data ?? []
    const statusById = new Map((statusQ.data?.rules ?? []).map(s => [s.id, s]))
    return rows.map((row) => {
      const builder = fromAST(row)
      const s = statusById.get(row.id)
      const lastFired = s?.lastFiredAt ? agoShort(s.lastFiredAt) : 'never'
      return {
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        mode: row.dryRun ? 'dryrun' : 'active',
        side: (row.side ?? 'both') as ListItem['side'],
        builder,
        lastFired,
        firesToday: s?.firesToday ?? 0,
      }
    })
  }, [listQ.data, statusQ.data])

  const saving = createM.isPending || updateM.isPending

  const save = (rule: BuilderRule) => {
    const ast = toAST(rule)
    if (rule.id != null) updateM.mutate({ id: rule.id, ...ast }, { onSuccess: () => setEditing(null) })
    else createM.mutate(ast, { onSuccess: () => setEditing(null) })
  }

  const killed = statusQ.data ? !statusQ.data.globalEnabled : false
  const activeCount = items.filter(i => i.enabled && i.mode === 'active').length

  return (
    <>
      <span className="-mb-2 hidden font-mono text-[13px] text-fg-2 min-[900px]:block">Autopilot /</span>
      <PageHeader
        title={(
          <>
            <span className="min-[900px]:hidden">Autopilot</span>
            <span className="hidden min-[900px]:inline">{AUTOPILOT_VIEWS.find(v => v.id === view)?.label}</span>
          </>
        )}
        right={(
          <>
            <StatusDot
              tone={killed ? 'danger' : 'ok'}
              mono
              label={killed ? 'HALTED' : `RUNNING · ${activeCount} ACTIVE`}
            />
            <SegmentedControl
              ariaLabel="Autopilot view"
              size="sm"
              className="min-[900px]:hidden"
              value={view}
              onChange={setView}
              options={[
                { value: 'automations', label: (
                  <>
                    Automations
                    <span className="font-mono text-fg-3">{items.length}</span>
                  </>
                ) },
                { value: 'diagnostics', label: 'Diagnostics' },
              ]}
            />
          </>
        )}
      />

      {view === 'automations' && (
        <AutomationsList
          items={items}
          loading={listQ.isLoading}
          onToggle={(id, enabled) => setEnabledM.mutate({ id, enabled })}
          onOpen={a => setEditing(a.builder)}
          onNew={() => setEditing(blankRule())}
        />
      )}
      {view === 'diagnostics' && (
        <StatusPanel
          globalEnabled={statusQ.data?.globalEnabled ?? true}
          onKill={enabled => killM.mutate({ enabled })}
          rules={statusQ.data?.rules ?? []}
          runs={runsQ.data ?? []}
          loading={statusQ.isLoading}
          onDry={(id, dryRun) => setDryRunM.mutate({ id, dryRun })}
        />
      )}

      {editing && <RuleEditor automation={editing} onClose={() => setEditing(null)} onSave={save} saving={saving} />}
    </>
  )
}

function agoShort(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d)
  const ms = Date.now() - date.getTime()
  if (ms < 60_000) return 'now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
