import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ usePathname: () => '/en/autopilot' }))

import { StatusPanel, type RuleStatus } from '../StatusPanel'

const rule: RuleStatus = {
  id: 7,
  name: 'Ambient demo',
  enabled: true,
  dryRun: true,
  side: null,
  cooldownMin: 30,
  lastOutcome: 'skipped',
  lastFiredAt: null,
  firesToday: 0,
}

describe('StatusPanel rule cards', () => {
  it('link to the rule page while the dry-run toggle still works on its own', () => {
    const onDry = vi.fn()
    render(<StatusPanel globalEnabled onKill={vi.fn()} rules={[rule]} runs={[]} loading={false} onDry={onDry} />)
    expect(screen.getByRole('link', { name: 'Ambient demo' }).getAttribute('href')).toBe('/en/autopilot/7')
    fireEvent.click(screen.getByLabelText('Dry-run'))
    expect(onDry).toHaveBeenCalledWith(7, false)
  })
})
