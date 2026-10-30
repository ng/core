import { setupI18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { SECTIONS } from '@/src/components/Settings/sections'
import { SYSTEM_TABS } from '@/src/components/System/systemTabs'
import { buildSearchEntries, createSearch } from '../searchIndex'

const i18n = setupI18n({ locale: 'en', messages: { en: {} } })
i18n.activate('en')
const entries = buildSearchEntries(i18n, { hasBase: false })
const search = createSearch(entries)
const top = (q: string) => search(q)[0]

describe('search index', () => {
  it('indexes every page, sub-view and section, hiding Base until one is configured', () => {
    const ids = new Set(entries.map(e => e.id))
    expect(ids.has('nav:base')).toBe(false)
    expect(buildSearchEntries(i18n, { hasBase: true }).some(e => e.id === 'nav:base')).toBe(true)
    for (const sec of SECTIONS) expect(ids.has(`settings:${sec.id}`)).toBe(true)
    for (const tab of SYSTEM_TABS) expect(ids.has(`system:${tab.id}`)).toBe(true)
    for (const id of ['sleep:nights', 'sleep:biometrics', 'autopilot:automations', 'autopilot:diagnostics']) expect(ids.has(id)).toBe(true)
    expect(new Set(entries.map(e => e.id)).size).toBe(entries.length)
  })

  it.each(['firewall', 'internet', 'wifi', 'Wi-Fi'])('ranks Settings › Network first for "%s"', (q) => {
    const hit = top(q)
    expect(hit.href).toBe('/settings?section=network')
    expect([...hit.crumbs, hit.title].slice(0, 2)).toEqual(['Settings', 'Network'])
  })

  it('ranks Settings › Biometric calibration first for "calibration"', () => {
    const hits = search('calibration')
    expect(hits[0].id).toBe('settings:biometric-calibration')
    expect(hits.map(h => h.id)).toContain('system:calibration')
  })

  it('finds controls by heading and by synonym, linking to their section', () => {
    expect(top('pump stall')).toMatchObject({ title: 'Pump stall protection', crumbs: ['Settings', 'Device'], href: '/settings?section=device' })
    expect(top('home assistant').href).toBe('/settings?section=mqtt')
    expect(top('vacation')).toMatchObject({ title: 'Away mode', href: '/settings?section=sides' })
    expect(top('dark mode')).toMatchObject({ title: 'Theme', href: '/settings?section=appearance' })
  })

  it('matches the token being typed as a prefix', () => {
    expect(top('calib').href).toBe('/settings?section=biometric-calibration')
    expect(top('homek').title).toBe('HomeKit')
    expect(top('sched').href).toBe('/schedule')
  })

  it('links sub-views to their query-string routes', () => {
    expect(top('biometrics').href).toBe('/sleep?view=biometrics')
    expect(entries.find(e => e.id === 'system:dashboard')?.href).toBe('/system')
    expect(entries.find(e => e.id === 'system:logs')?.href).toBe('/system?tab=logs')
    expect(entries.find(e => e.id === 'autopilot:diagnostics')?.href).toBe('/autopilot?view=diagnostics')
  })

  it('returns nothing for an empty query', () => {
    expect(search('')).toEqual([])
  })
})
