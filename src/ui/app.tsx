import { render } from 'preact'
import { DashboardShell } from './components/DashboardShell'
import { createEngineDashboardPlugin } from './plugins/engine-plugin'
import { createDashboardConfigFromPlugins } from './runtime/dashboard-plugin'
import './styles.css'

function App() {
  const config = createDashboardConfigFromPlugins({
    brand: 'YELLA',
    plugins: [createEngineDashboardPlugin()],
  })

  return <DashboardShell config={config} />
}

render(<App />, document.getElementById('app')!)
