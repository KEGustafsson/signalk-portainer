import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import AppPanel from '../src/components/AppPanel'

describe('AppPanel', () => {
  it('renders an iframe element', () => {
    render(<AppPanel />)
    const iframe = screen.getByTitle('Portainer CE')
    expect(iframe).toBeInTheDocument()
    expect(iframe.tagName).toBe('IFRAME')
  })

  it('points to the correct proxy path', () => {
    render(<AppPanel />)
    const iframe = screen.getByTitle('Portainer CE')
    expect(iframe).toHaveAttribute('src', '/plugins/signalk-portainer/proxy/')
  })

  it('has no border', () => {
    render(<AppPanel />)
    const iframe = screen.getByTitle('Portainer CE')
    expect(iframe).toHaveStyle({ borderWidth: '0' })
  })

  it('fills the available width', () => {
    render(<AppPanel />)
    const iframe = screen.getByTitle('Portainer CE')
    expect(iframe).toHaveStyle({ width: '100%' })
  })

  it('has a title attribute for accessibility', () => {
    render(<AppPanel />)
    const iframe = screen.getByTitle('Portainer CE')
    expect(iframe).toHaveAttribute('title', 'Portainer CE')
  })

  it('has sandbox attribute for iframe security', () => {
    render(<AppPanel />)
    const iframe = screen.getByTitle('Portainer CE')
    expect(iframe).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups',
    )
  })

  it('has referrerPolicy attribute for privacy', () => {
    render(<AppPanel />)
    const iframe = screen.getByTitle('Portainer CE')
    expect(iframe).toHaveAttribute('referrerPolicy', 'no-referrer')
  })
})
