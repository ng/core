'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { Badge } from '@/src/components/ds/core'
import { Toggle } from '@/src/components/ds/forms'
import { resolveSection, SECTIONS } from '@/src/components/Settings/sections'
import { resolveSystemTab, SYSTEM_TABS } from '@/src/components/System/systemTabs'
import { usePrefs } from '@/src/providers/PrefsProvider'
import { trpc } from '@/src/utils/trpc'
import { activeNavId, langFromPath, NAV_ITEMS, type NavId } from './navItems'

const noopSubscribe = () => () => {}

const POD_NAMES: Record<string, string> = { H00: 'Pod 3', I00: 'Pod 4', J00: 'Pod 5' }

/** Desktop navigation rail (≥ 900px). */
export function Sidebar({ className }: { className?: string }) {
  const pathname = usePathname()
  const lang = langFromPath(pathname)
  const active = activeNavId(pathname)
  const { developer, setDeveloper } = usePrefs()

  const status = trpc.device.getStatus.useQuery({}, { staleTime: 10_000, refetchInterval: 30_000 })
  const health = trpc.health.system.useQuery({}, { staleTime: 10_000, refetchInterval: 30_000 })
  const version = trpc.system.getVersion.useQuery({}, { staleTime: 60_000 })

  const podName = status.data?.podVersion ? POD_NAMES[status.data.podVersion] ?? status.data.podVersion : 'Pod'
  const healthy = health.data ? health.data.status === 'ok' : undefined
  const statusDot = healthy === undefined ? undefined : healthy ? 'var(--status-ok)' : 'var(--status-warn)'
  const host = useSyncExternalStore(noopSubscribe, () => window.location.hostname, () => '')
  const commit = version.data?.commitHash && version.data.commitHash !== 'unknown' ? version.data.commitHash.slice(0, 7) : null

  return (
    <nav
      aria-label="Main"
      className={cn('sticky top-0 flex h-dvh w-[224px] shrink-0 flex-col gap-7 border-r border-line px-3.5 py-6', className)}
    >
      <Link href={`/${lang}`} className="flex items-center gap-2 px-2.5 font-mono text-sm text-fg no-underline hover:no-underline">
        {/* eslint-disable-next-line @next/next/no-img-element -- static 128px asset, no optimizer needed on the pod */}
        <img src="/logo.png" alt="" width={22} height={22} className="size-[22px] rounded-[6px]" />
        sleepypod
      </Link>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {NAV_ITEMS.map((n) => {
          const on = n.id === active
          const group = n.id === 'settings' || n.id === 'system'
          const Chevron = on ? ChevronDown : ChevronRight
          return (
            <div key={n.id} className="flex flex-col gap-0.5">
              <Link
                href={`/${lang}${n.href === '/' ? '' : n.href}`}
                aria-current={on && !group ? 'page' : undefined}
                aria-expanded={group ? on : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-ctl px-2.5 py-[9px] text-sm no-underline transition-colors hover:no-underline',
                  on ? (group ? 'text-fg hover:bg-active' : 'bg-active text-fg') : 'text-fg-2 hover:bg-active',
                )}
              >
                <n.icon size={16} />
                {n.label}
                {group && <Chevron size={14} className="ml-auto text-fg-3" />}
              </Link>
              {group && on && (
                <Suspense fallback={null}>
                  <SubTree group={n.id as 'settings' | 'system'} lang={lang} statusDot={statusDot} developer={developer} />
                </Suspense>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-auto flex flex-col gap-3.5 px-2.5">
        <div className={cn('flex items-center justify-between text-[13px]', developer ? 'text-fg' : 'text-fg-2')}>
          Developer
          <Toggle on={developer} onChange={setDeveloper} label="Developer mode" />
        </div>
        <div className="flex flex-col gap-1 border-t border-line pt-3.5 font-mono text-xs text-fg-2">
          <div className="flex items-center gap-2 text-fg">
            <span className={cn('size-1.5 rounded-full', healthy === undefined ? 'bg-fg-3' : healthy ? 'bg-ok' : 'bg-warn')} />
            {podName}
            {healthy !== undefined && (
              <span className="text-fg-2">
                {'· '}
                {healthy ? 'healthy' : 'degraded'}
              </span>
            )}
          </div>
          <div className="truncate whitespace-nowrap">
            {[host, commit].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>
    </nav>
  )
}

/**
 * Sections nested under their parent (Settings, System), indented along a
 * hairline without icons. Only the current group is expanded.
 */
function SubTree({ group, lang, statusDot, developer }: {
  group: Extract<NavId, 'settings' | 'system'>
  lang: string
  statusDot?: string
  developer: boolean
}) {
  const searchParams = useSearchParams()
  const items = group === 'settings'
    ? SECTIONS.map(sec => ({
        id: sec.id as string,
        label: sec.label as string,
        href: `/${lang}/settings?section=${sec.id}`,
        dot: sec.id === 'status' ? statusDot : undefined,
        dev: false,
      }))
    : SYSTEM_TABS.filter(t => !t.dev || developer).map(t => ({
        id: t.id as string,
        label: t.label,
        href: t.id === 'sensors' ? `/${lang}/system` : `/${lang}/system?tab=${t.id}`,
        dot: undefined as string | undefined,
        dev: !!t.dev,
      }))
  const current = group === 'settings'
    ? resolveSection(searchParams.get('section'), searchParams.get('tab')) ?? 'status'
    : resolveSystemTab(searchParams.get('tab'), developer)

  return (
    <div className="mb-1 ml-[17px] flex flex-col gap-0.5 border-l border-line pl-2">
      {items.map((it) => {
        const on = it.id === current
        return (
          <Link
            key={it.id}
            href={it.href}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-ctl px-2.5 py-[7px] text-sm no-underline transition-colors hover:no-underline',
              on ? 'bg-active text-fg' : 'text-fg-2 hover:bg-active',
            )}
          >
            {it.label}
            {it.dev && <Badge>DEV</Badge>}
            {it.dot && <span className="ml-auto size-1.5 rounded-full" style={{ background: it.dot }} />}
          </Link>
        )
      })}
    </div>
  )
}
