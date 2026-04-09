import React from 'react'

const PLUGIN_PATH = '/plugins/signalk-web-proxy'

// Height in pixels of the SignalK admin UI top navigation bar.
// The panel fills the remaining viewport height below it.
const ADMIN_HEADER_HEIGHT = 64

interface AppInfo {
  index: number
  name: string
}

const msgStyle: React.CSSProperties = {
  padding: '16px',
  fontFamily: 'sans-serif',
}

const AppPanel: React.FC = () => {
  const [apps, setApps] = React.useState<AppInfo[]>([])
  const [selected, setSelected] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    fetch(`${PLUGIN_PATH}/apps`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${String(r.status)}`)
        return r.json() as Promise<AppInfo[]>
      })
      .then((data) => {
        setApps(data)
        // Auto-select the only app so the iframe loads immediately
        if (data.length === 1) setSelected(data[0]?.index ?? 0)
      })
      .catch(() => {
        // Leave apps empty — the empty-state message will be shown
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div style={msgStyle}>Loading…</div>
  }

  if (apps.length === 0) {
    return (
      <div style={msgStyle}>
        No web applications configured. Add applications in the plugin settings.
      </div>
    )
  }

  const selectedApp = apps.find((a) => a.index === selected) ?? null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: `calc(100vh - ${ADMIN_HEADER_HEIGHT}px)`,
      }}
    >
      {apps.length > 1 && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #ddd' }}>
          <select
            value={selected ?? ''}
            onChange={(e) => setSelected(Number(e.target.value))}
            aria-label="Select application"
          >
            <option value="" disabled>
              Select an application…
            </option>
            {apps.map((appItem) => (
              <option key={appItem.index} value={appItem.index}>
                {appItem.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {selectedApp !== null ? (
        <iframe
          key={selected}
          src={`${PLUGIN_PATH}/proxy/${selected}/`}
          style={{ flex: 1, width: '100%', borderWidth: 0 }}
          title={selectedApp.name}
          // allow-same-origin lets cookie/session auth work in proxied apps (e.g. Portainer).
          // Trade-off: proxied content runs at the SignalK admin origin. Only proxy trusted apps.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div style={msgStyle}>Select an application above.</div>
      )}
    </div>
  )
}

export default AppPanel
