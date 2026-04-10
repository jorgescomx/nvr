import { useState, useEffect, useRef } from 'react'
import './index.css'

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [activeTab, setActiveTab] = useState('dashboard')
  const [config, setConfig] = useState(null)
  
  // Login State
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')

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

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoginError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      })
      if (res.ok) {
        setIsAuthenticated(true)
        loadConfig()
      } else {
        setLoginError('Invalid formatting or credentials.')
      }
    } catch (e) {
      setLoginError('Network Error.')
    }
  }

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    setIsAuthenticated(false)
    setConfig(null)
  }

  if (!isAuthenticated) {
    return (
      <div className="login-wrapper">
        <div className="glass-panel login-box">
          <h1 className="login-title">NVR Login</h1>
          {loginError && <div style={{color: 'var(--danger-color)', marginBottom: '16px'}}>{loginError}</div>}
          <form onSubmit={handleLogin}>
            <div className="form-group">
              <label className="form-label">Username</label>
              <input type="text" className="form-input" value={username} onChange={e => setUsername(e.target.value)} required />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input type="password" className="form-input" value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
            <button type="submit" className="btn">Sign In</button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="app-container">
      <div className="sidebar">
        <div className="sidebar-header">Core NVR</div>
        <div className="sidebar-nav">
          <div className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>
            Dashboard
          </div>
          <div className={`nav-item ${activeTab === 'cameras' ? 'active' : ''}`} onClick={() => setActiveTab('cameras')}>
            Cameras
          </div>
          <div className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>
            Settings
          </div>
          <div style={{marginTop: 'auto'}} className="nav-item" onClick={handleLogout}>
            Logout
          </div>
        </div>
      </div>
      
      <div className="main-content">
        <div style={{ display: activeTab === 'dashboard' ? 'block' : 'none' }}>
            <Dashboard config={config} reload={loadConfig} />
        </div>
        <div style={{ display: activeTab === 'cameras' ? 'block' : 'none' }}>
            <Cameras config={config} reload={loadConfig} />
        </div>
        <div style={{ display: activeTab === 'settings' ? 'block' : 'none' }}>
            <Settings config={config} reload={loadConfig} />
        </div>
      </div>
    </div>
  )
}

function Dashboard({ config, reload }) {
  if (!config || !config.streams || config.streams.length === 0) {
    return (
      <div>
        <h2 className="page-title">Live Dashboard</h2>
        <div className="glass-panel" style={{padding: '40px', textAlign: 'center', color: 'var(--text-muted)'}}>
          No cameras configured yet. Go to the Cameras tab to add one.
        </div>
      </div>
    )
  }

  // Generate default layouts if missing (tile evenly)
  const getLayout = (stream, idx) => {
    if (stream.layout) return stream.layout
    const count = Math.max(1, config.streams.length)
    const cols = Math.ceil(Math.sqrt(count))
    const row = Math.floor(idx / cols)
    const col = idx % cols
    const baseW = 96 / cols
    const baseH = 45 // Fixed percentage height for default tiles so they aren't 100% tall
    return { 
      x: 2 + (col * baseW), 
      y: 2 + (row * baseH), 
      w: baseW - 2, 
      h: baseH - 4 
    }
  }

  const saveLayout = async (streamName, layout) => {
    await fetch(`/api/streams/${streamName}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout })
    })
    reload()
  }

  // Drag to move
  const handleDragStart = (e, stream, idx) => {
    if (e.button !== 0) return
    if (e.target.closest('.resize-handle')) return
    e.preventDefault()
    e.stopPropagation()

    const container = document.querySelector('.widget-canvas')
    const card = e.target.closest('.camera-card')
    if (!container || !card) return

    const containerRect = container.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const offsetX = e.clientX - cardRect.left
    const offsetY = e.clientY - cardRect.top

    const iframes = document.querySelectorAll('.webrtc-iframe')
    iframes.forEach(f => { f.style.pointerEvents = 'none' })

    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:10000;cursor:grabbing;'
    document.body.appendChild(overlay)

    // Ghost
    const ghost = document.createElement('div')
    ghost.style.cssText = `position:fixed;width:${Math.min(280, cardRect.width)}px;height:45px;background:var(--bg-panel);border:2px solid var(--accent-color);border-radius:10px;opacity:0.85;z-index:10001;pointer-events:none;display:flex;align-items:center;padding:0 16px;font-family:Inter,sans-serif;font-weight:600;color:var(--text-main);font-size:14px;box-shadow:0 12px 40px rgba(0,0,0,0.5);backdrop-filter:blur(12px);left:${e.clientX - 20}px;top:${e.clientY - 22}px;`
    ghost.textContent = stream.name
    document.body.appendChild(ghost)

    card.style.opacity = '0.3'

    overlay.onmousemove = (moveEvent) => {
      ghost.style.left = (moveEvent.clientX - 20) + 'px'
      ghost.style.top = (moveEvent.clientY - 22) + 'px'

      // Live-move the card
      const newLeft = moveEvent.clientX - containerRect.left - offsetX
      const newTop = moveEvent.clientY - containerRect.top - offsetY
      const pctX = Math.max(0, Math.min(100 - 5, (newLeft / containerRect.width) * 100))
      const pctY = Math.max(0, Math.min(100 - 5, (newTop / containerRect.height) * 100))
      card.style.left = pctX + '%'
      card.style.top = pctY + '%'
    }

    overlay.onmouseup = async (moveEvent) => {
      if (ghost.parentNode) document.body.removeChild(ghost)
      if (overlay.parentNode) document.body.removeChild(overlay)
      iframes.forEach(f => { f.style.pointerEvents = '' })
      card.style.opacity = ''

      // Calculate final position percentages
      const finalLeft = parseFloat(card.style.left)
      const finalTop = parseFloat(card.style.top)
      const layout = getLayout(stream, idx)

      await saveLayout(stream.name, { ...layout, x: finalLeft, y: finalTop })
    }
  }

  // Resize from corner
  const handleResizeStart = (e, stream, idx) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    const container = document.querySelector('.widget-canvas')
    const card = e.target.closest('.camera-card')
    if (!container || !card) return

    const containerRect = container.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    const startW = card.offsetWidth
    const startH = card.offsetHeight

    const iframes = document.querySelectorAll('.webrtc-iframe')
    iframes.forEach(f => { f.style.pointerEvents = 'none' })

    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:10000;cursor:nwse-resize;'
    document.body.appendChild(overlay)

    card.style.outline = '2px solid var(--accent-color)'
    card.style.transition = 'none'

    // Size indicator
    const indicator = document.createElement('div')
    indicator.style.cssText = 'position:fixed;padding:4px 12px;background:var(--accent-color);color:white;border-radius:6px;font-size:12px;font-weight:600;z-index:10001;pointer-events:none;font-family:Inter,sans-serif;'
    document.body.appendChild(indicator)

    overlay.onmousemove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX
      const deltaY = moveEvent.clientY - startY
      const newW = Math.max(200, startW + deltaX)
      const newH = Math.max(120, startH + deltaY)
      card.style.width = newW + 'px'
      card.style.height = newH + 'px'

      const pctW = ((newW / containerRect.width) * 100).toFixed(1)
      const pctH = ((newH / containerRect.height) * 100).toFixed(1)
      indicator.textContent = `${pctW}% × ${pctH}%`
      indicator.style.left = (moveEvent.clientX + 12) + 'px'
      indicator.style.top = (moveEvent.clientY - 12) + 'px'
    }

    overlay.onmouseup = async () => {
      if (overlay.parentNode) document.body.removeChild(overlay)
      if (indicator.parentNode) document.body.removeChild(indicator)
      iframes.forEach(f => { f.style.pointerEvents = '' })

      const finalW = (card.offsetWidth / containerRect.width) * 100
      const finalH = (card.offsetHeight / containerRect.height) * 100
      const layout = getLayout(stream, idx)

      card.style.width = ''
      card.style.height = ''
      card.style.outline = ''
      card.style.transition = ''

      await saveLayout(stream.name, { ...layout, w: finalW, h: finalH })
    }
  }

  return (
    <div className="dashboard-wrapper">
      <h2 className="page-title">Live Dashboard</h2>
      <div className="widget-canvas">
        {config.streams.map((stream, idx) => {
          const layout = getLayout(stream, idx)
          return (
            <div
              key={stream.name}
              data-camera-index={idx}
              className="glass-panel camera-card widget-card"
              style={{
                left: `${layout.x}%`,
                top: `${layout.y}%`,
                width: `${layout.w}%`,
                height: `${layout.h}%`,
              }}
            >
              <div
                className="camera-header draggable-handle"
                onMouseDown={(e) => handleDragStart(e, stream, idx)}
              >
                <span>{stream.name}</span>
                <div style={{display: 'flex', alignItems: 'center', gap: '12px'}}>
                  {stream.is_recording !== false ? (
                     <span className="camera-status">RECORDING</span>
                  ) : (
                     <span className="camera-status" style={{background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444'}}>NOT RECORDING</span>
                  )}
                </div>
              </div>
              <div className="camera-feed">
                <iframe
                  className="webrtc-iframe"
                  src={`http://${window.location.hostname}:1984/stream.html?src=${stream.name}&mode=webrtc,mse,mp4,mjpeg`}
                  allow="autoplay; fullscreen"
                />
              </div>
              <div
                className="resize-handle"
                onMouseDown={(e) => handleResizeStart(e, stream, idx)}
                title="Drag to resize"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Cameras({ config, reload }) {
  // Add Stream form
  const [newCamName, setNewCamName] = useState('')
  const [newCamIP, setNewCamIP] = useState('')
  const [newCamUser, setNewCamUser] = useState('')
  const [newCamPass, setNewCamPass] = useState('')
  const [newCamPath, setNewCamPath] = useState('/stream2')
  const [newCamTZ, setNewCamTZ] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  
  // Edit Stream modal state
  const [editingStream, setEditingStream] = useState(null)

  const handleAdd = async (e) => {
    e.preventDefault()
    if (!newCamName || !newCamIP) return
    const res = await fetch('/api/streams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        name: newCamName, 
        ip: newCamIP,
        username: newCamUser,
        password: newCamPass,
        path: newCamPath,
        timezone: newCamTZ
      })
    })
    if (res.ok) {
      setNewCamName('')
      setNewCamIP('')
      setNewCamUser('')
      setNewCamPass('')
      reload()
    } else {
      alert("Failed to add camera")
    }
  }

  const handleDelete = async (name) => {
    if(!window.confirm(`Are you sure you want to delete ${name}?`)) return;
    const res = await fetch(`/api/streams/${name}`, { method: 'DELETE' })
    if (res.ok) reload()
  }

  const handleToggleRecord = async (stream) => {
    const is_recording = stream.is_recording !== false ? false : true
    const res = await fetch(`/api/streams/${stream.name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_recording })
    })
    if (res.status === 401) return reload()
    if (res.ok) reload()
  }
  
  const submitEdit = async (e) => {
      e.preventDefault()
      const res = await fetch(`/api/streams/${editingStream.name}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editingStream)
      })
      if(res.ok){
          setEditingStream(null)
          reload()
      } else {
          alert('Failed to update')
      }
  }

  return (
    <div>
      <h2 className="page-title">Manage Cameras</h2>
      
      {editingStream && (
         <div className="glass-panel" style={{marginBottom: '32px', padding: '24px', border: '1px solid var(--accent-color)'}}>
             <h3 style={{marginBottom: '16px'}}>Edit Camera: {editingStream.name}</h3>
             <form onSubmit={submitEdit}>
                 <div style={{display: 'flex', gap: '16px', marginBottom: '16px'}}>
                    <div className="form-group" style={{flex: 1}}>
                      <label className="form-label">IP Address</label>
                      <input type="text" className="form-input" value={editingStream.ip||''} onChange={e => setEditingStream({...editingStream, ip: e.target.value})} required />
                    </div>
                    <div className="form-group" style={{flex: 1}}>
                      <label className="form-label">Stream Path</label>
                      <input type="text" className="form-input" value={editingStream.path||''} onChange={e => setEditingStream({...editingStream, path: e.target.value})} required />
                    </div>
                    <div className="form-group" style={{flex: 1}}>
                      <label className="form-label">Timezone</label>
                      <input type="text" className="form-input" value={editingStream.timezone||'UTC'} onChange={e => setEditingStream({...editingStream, timezone: e.target.value})} required />
                    </div>
                 </div>
                 <div style={{display: 'flex', gap: '16px', marginBottom: '24px'}}>
                     <div className="form-group" style={{flex: 1}}>
                      <label className="form-label">Username</label>
                      <input type="text" className="form-input" value={editingStream.username||''} onChange={e => setEditingStream({...editingStream, username: e.target.value})} />
                    </div>
                    <div className="form-group" style={{flex: 1}}>
                      <label className="form-label">Update Password (Leave blank to keep current)</label>
                      <input type="password" className="form-input" placeholder="••••••••" onChange={e => setEditingStream({...editingStream, password: e.target.value})} />
                    </div>
                 </div>
                 <div style={{display: 'flex', gap: '16px'}}>
                     <button type="submit" className="btn btn-small" style={{width: 'auto'}}>Save Changes</button>
                     <button type="button" className="btn btn-small" style={{width: 'auto', background: 'transparent', border: '1px solid var(--glass-border)'}} onClick={()=>setEditingStream(null)}>Cancel</button>
                 </div>
             </form>
         </div>
      )}
      
      {!editingStream && (
          <div className="glass-panel" style={{marginBottom: '32px', padding: '24px'}}>
            <h3 style={{marginBottom: '16px'}}>Add New Camera</h3>
            <form onSubmit={handleAdd}>
              <div style={{display: 'flex', gap: '16px', marginBottom: '16px'}}>
                <div className="form-group" style={{flex: 1, marginBottom: 0}}>
                  <label className="form-label">Camera Name (No spaces)</label>
                  <input type="text" className="form-input" value={newCamName} onChange={e => setNewCamName(e.target.value.replace(/\s+/g,'_'))} placeholder="e.g. Front_Door" required />
                </div>
                <div className="form-group" style={{flex: 1, marginBottom: 0}}>
                  <label className="form-label">IP Address</label>
                  <input type="text" className="form-input" value={newCamIP} onChange={e => setNewCamIP(e.target.value)} placeholder="192.168.1.100" required />
                </div>
                <div className="form-group" style={{flex: 1, marginBottom: 0}}>
                  <label className="form-label">Stream Path</label>
                  <input type="text" className="form-input" value={newCamPath} onChange={e => setNewCamPath(e.target.value)} placeholder="/stream2" required />
                </div>
                <div className="form-group" style={{flex: 1, marginBottom: 0}}>
                  <label className="form-label">Timezone</label>
                  <input type="text" className="form-input" value={newCamTZ} onChange={e => setNewCamTZ(e.target.value)} placeholder="America/New_York" required />
                </div>
              </div>
              <div style={{display: 'flex', gap: '16px', alignItems: 'flex-end'}}>
                <div className="form-group" style={{flex: 1, marginBottom: 0}}>
                  <label className="form-label">Username (Optional)</label>
                  <input type="text" className="form-input" value={newCamUser} onChange={e => setNewCamUser(e.target.value)} placeholder="admin" />
                </div>
                <div className="form-group" style={{flex: 1, marginBottom: 0}}>
                  <label className="form-label">Password (Optional)</label>
                  <input type="password" className="form-input" value={newCamPass} onChange={e => setNewCamPass(e.target.value)} placeholder="••••••••" />
                </div>
                <button type="submit" className="btn btn-small" style={{height: '42px', flex: 1}}>Add Secure Camera</button>
              </div>
            </form>
          </div>
      )}

      <div className="glass-panel">
        {config?.streams?.map(stream => (
          <div key={stream.name} className="list-item" style={{flexWrap: 'wrap', gap: '12px'}}>
            <div style={{flex: 1, minWidth: '200px'}}>
              <strong>{stream.name}</strong>
              <div style={{fontSize: '0.875rem', color: 'var(--text-muted)', marginTop: '4px'}}>
                 {stream.ip ? `IP: ${stream.ip} • Path: ${stream.path} • TZ: ${stream.timezone||'UTC'}` : `Legacy Mode or Invalid URL`}
              </div>
            </div>
            
            <div style={{display: 'flex', gap: '16px'}}>
                <button 
                  onClick={() => handleToggleRecord(stream)} 
                  className="btn btn-small" 
                  style={{background: stream.is_recording !== false ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)', color: stream.is_recording !== false ? '#4ade80' : '#ef4444', minWidth: '120px'}}
                >
                  {stream.is_recording !== false ? 'Stop Recording' : 'Start Recording'}
                </button>
                <button 
                  onClick={() => setEditingStream({...stream, password: ''})} 
                  className="btn btn-small btn-dark"
                >
                  Edit API
                </button>
                <button onClick={() => handleDelete(stream.name)} className="btn btn-small btn-danger">Delete</button>
            </div>
          </div>
        ))}
        {(!config?.streams || config.streams.length === 0) && (
          <div style={{padding: '24px', textAlign: 'center', color: 'var(--text-muted)'}}>No cameras connected.</div>
        )}
      </div>
    </div>
  )
}

function Settings({ config, reload }) {
  const [maxStorage, setMaxStorage] = useState(config?.max_storage_gb || 0)
  const [retention, setRetention] = useState(config?.retention_days || 0)
  const [segmentTime, setSegmentTime] = useState(config?.segment_time ? Math.round(config.segment_time / 60) : 60)
  
  const [currentPass, setCurrentPass] = useState('')
  const [newPass, setNewPass] = useState('')
  const [verifyPass, setVerifyPass] = useState('')
  const [passMsg, setPassMsg] = useState('')

  const handleSaveStorage = async () => {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
          max_storage_gb: maxStorage, 
          retention_days: retention,
          segment_time: parseInt(segmentTime) * 60
      })
    })
    reload()
    alert("System settings saved and applied to background engines.")
  }

  const handleUpdatePassword = async (e) => {
    e.preventDefault()
    setPassMsg('')
    if (newPass !== verifyPass) {
      setPassMsg('Passwords do not match!')
      return
    }
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: currentPass, new_password: newPass })
    })
    if (res.ok) {
      setPassMsg('Password updated successfully!')
      setCurrentPass('')
      setNewPass('')
      setVerifyPass('')
    } else {
      setPassMsg('Failed to update password. Check current password.')
    }
  }

  return (
    <div>
      <h2 className="page-title">System Settings</h2>
      
      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px'}}>
        <div className="glass-panel" style={{padding: '24px'}}>
          <h3 style={{marginBottom: '24px'}}>Engine Policies</h3>
          
          <div className="form-group" style={{paddingBottom: '16px', borderBottom: '1px solid var(--glass-border)'}}>
            <label className="form-label">Recording Segment Size (minutes)</label>
            <div style={{fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '8px'}}>The amount of video time stored in a single recording file (Default: 60 = 1 hour).</div>
            <input type="number" className="form-input" value={segmentTime} onChange={e => setSegmentTime(e.target.value)} />
          </div>

          <div className="form-group" style={{marginTop: '16px'}}>
            <label className="form-label">Max Storage Capacity (GB) - 0 to disable</label>
            <input type="number" className="form-input" value={maxStorage} onChange={e => setMaxStorage(e.target.value)} />
          </div>

          <div className="form-group">
            <label className="form-label">Retention Time (Days) - 0 to disable</label>
            <input type="number" className="form-input" value={retention} onChange={e => setRetention(e.target.value)} />
          </div>

          <button onClick={handleSaveStorage} className="btn" style={{marginTop: '16px'}}>Save Engine Policies</button>
        </div>

        <div className="glass-panel" style={{padding: '24px'}}>
          <h3 style={{marginBottom: '24px'}}>Security & Authentication</h3>
          <form onSubmit={handleUpdatePassword}>
            <div className="form-group">
              <label className="form-label">Current Password</label>
              <input type="password" className="form-input" value={currentPass} onChange={e => setCurrentPass(e.target.value)} required />
            </div>
            <div className="form-group">
              <label className="form-label">New Password</label>
              <input type="password" className="form-input" value={newPass} onChange={e => setNewPass(e.target.value)} required minLength={4} />
            </div>
            <div className="form-group">
              <label className="form-label">Verify Password</label>
              <input type="password" className="form-input" value={verifyPass} onChange={e => setVerifyPass(e.target.value)} required minLength={4} />
            </div>
            <button type="submit" className="btn">Change Password</button>
            {passMsg && <div style={{marginTop: '12px', fontSize: '0.875rem', color: passMsg.includes('Failed') ? 'var(--danger-color)' : '#4ade80'}}>{passMsg}</div>}
          </form>
        </div>
      </div>
    </div>
  )
}

export default App
