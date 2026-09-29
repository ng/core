import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { formatOffset, TempControl } from '../TempControl'

describe('formatOffset', () => {
  it.each([
    [80, '0'],
    [83, '+3'],
    [76, '−4'],
    [55, '−25'],
    [110, '+30'],
    [75.6, '−4'],
  ])('%s°F → %s', (f, out) => {
    expect(formatOffset(f)).toBe(out)
  })
})

describe('TempControl display', () => {
  it('shows degrees with the change from the bed by default', () => {
    render(<TempControl targetF={76} bedF={80} />)
    expect(screen.getByTestId('temp-numeral').textContent).toBe('76°')
    expect(screen.getByText('−4 · bed 80°F')).toBeTruthy()
  })

  it('shows the offset from 80°F with degrees underneath in offset mode', () => {
    render(<TempControl display="offset" targetF={76} bedF={82} />)
    expect(screen.getByTestId('temp-numeral').textContent).toBe('−4')
    expect(screen.getByText('76°F · bed 82°F')).toBeTruthy()
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('−4 (76°F), cooling')
  })

  it('labels the slider scale in offsets', () => {
    render(<TempControl variant="slider" display="offset" targetF={84} bedF={null} />)
    expect(screen.getByTestId('temp-numeral').textContent).toBe('+4')
    for (const mark of ['+30', '0', '−25']) expect(screen.getByText(mark)).toBeTruthy()
    expect(screen.getByText('84°F · bed —')).toBeTruthy()
  })

  it('shows Celsius underneath while the offset stays in °F steps', () => {
    render(<TempControl display="offset" targetF={76} bedF={null} unit="C" />)
    expect(screen.getByTestId('temp-numeral').textContent).toBe('−4')
    expect(screen.getByTestId('temp-numeral').nextElementSibling?.textContent).toMatch(/^2\d°C · bed —$/)
  })
})
