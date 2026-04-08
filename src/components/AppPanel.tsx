const PROXY_PATH = '/plugins/signalk-portainer/'

const panelStyle: React.CSSProperties = {
  width: '100%',
  height: 'calc(100vh - 64px)',
  borderWidth: 0,
}

const AppPanel: React.FC = () => {
  return (
    <iframe
      src={PROXY_PATH}
      style={panelStyle}
      title="Portainer CE"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      referrerPolicy="no-referrer"
    />
  )
}

export default AppPanel
