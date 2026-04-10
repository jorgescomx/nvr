import { useState, useEffect } from 'react'
import './index.css'
import Login from './components/Login'
import Dashboard from './components/Dashboard'
import Cameras from './components/Cameras'
import Settings from './components/Settings'
import Recordings from './components/Recordings'

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [activeTab, setActiveTab] = useState('dashboard')
  const [config, setConfig] = useState(null)

  useEffect(() => {
    checkAuth()
  }, [])

  const checkAuth = async () => {
    try {
      const res = await fetch('/api/auth/status')
      if (res.ok) {
        setIsAuthenticated(true)
        loadConfig()
      }
    } catch (e) {
      console.error(e)
    }
  }

  const loadConfig = async () => {
    try {
      const res = await fetch('/api/config')
      if (res.status === 401) return setIsAuthenticated(false)
      if (res.ok) setConfig(await res.json())
    } catch (e) {
      console.error(e)
    }
  }

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    setIsAuthenticated(false)
    setConfig(null)
  }

  if (!isAuthenticated) {
    return <Login onLogin={() => { setIsAuthenticated(true); loadConfig() }} />
  }

  const tabs = ['dashboard', 'cameras', 'recordings', 'settings']

  return (
    <div className="app-container">
      <div className="sidebar">
        <div className="sidebar-header">Core NVR</div>
        <div className="sidebar-nav">
          {tabs.map(tab => (
            <div
              key={tab}
              className={`nav-item ${activeTab === tab ? 'active' : ''}`}
              onClick={() => { setActiveTab(tab); loadConfig() }}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </div>
          ))}
          <div style={{ marginTop: 'auto' }} className="nav-item" onClick={handleLogout}>
            Logout
          </div>
        </div>
      </div>

      <div className="main-content">
        {/* Dashboard uses visibility so iframes stay alive when switching tabs */}
        <div style={{ visibility: activeTab === 'dashboard' ? 'visible' : 'hidden', position: activeTab === 'dashboard' ? 'relative' : 'absolute', top: 0, left: 0, right: 0 }}>
          <Dashboard config={config} />
        </div>
        <div style={{ display: activeTab === 'cameras' ? 'block' : 'none' }}>
          <Cameras config={config} reload={loadConfig} />
        </div>
        <div style={{ display: activeTab === 'recordings' ? 'block' : 'none' }}>
          <Recordings active={activeTab === 'recordings'} />
        </div>
        <div style={{ display: activeTab === 'settings' ? 'block' : 'none' }}>
          <Settings config={config} reload={loadConfig} />
        </div>
      </div>
    </div>
  )
}

export default App
