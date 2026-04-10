import { useState } from 'react'

function Cameras({ config, reload }) {
  const [newCamName, setNewCamName] = useState('')
  const [newCamIP, setNewCamIP] = useState('')
  const [newCamUser, setNewCamUser] = useState('')
  const [newCamPass, setNewCamPass] = useState('')
  const [newCamPath, setNewCamPath] = useState('/stream2')
  const [newCamTZ, setNewCamTZ] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')

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
      const data = await res.json()
      alert(data.error || 'Failed to add camera')
    }
  }

  const handleDelete = async (name) => {
    if (!window.confirm(`Are you sure you want to delete ${name}?`)) return
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
    if (res.ok) {
      setEditingStream(null)
      reload()
    } else {
      const data = await res.json()
      alert(data.error || 'Failed to update')
    }
  }

  return (
    <div>
      <h2 className="page-title">Manage Cameras</h2>

      {editingStream && (
        <div className="glass-panel" style={{ marginBottom: '32px', padding: '24px', border: '1px solid var(--accent-color)' }}>
          <h3 style={{ marginBottom: '16px' }}>Edit Camera: {editingStream.name}</h3>
          <form onSubmit={submitEdit}>
            <div style={{ display: 'flex', gap: '16px', marginBottom: '16px' }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">IP Address</label>
                <input
                  type="text"
                  className="form-input"
                  value={editingStream.ip || ''}
                  onChange={e => setEditingStream({ ...editingStream, ip: e.target.value })}
                  required
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Stream Path</label>
                <input
                  type="text"
                  className="form-input"
                  value={editingStream.path || ''}
                  onChange={e => setEditingStream({ ...editingStream, path: e.target.value })}
                  required
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Timezone</label>
                <input
                  type="text"
                  className="form-input"
                  value={editingStream.timezone || 'UTC'}
                  onChange={e => setEditingStream({ ...editingStream, timezone: e.target.value })}
                  required
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '16px', marginBottom: '24px' }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Username</label>
                <input
                  type="text"
                  className="form-input"
                  value={editingStream.username || ''}
                  onChange={e => setEditingStream({ ...editingStream, username: e.target.value })}
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Update Password (leave blank to keep current)</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="••••••••"
                  onChange={e => setEditingStream({ ...editingStream, password: e.target.value })}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '16px' }}>
              <button type="submit" className="btn btn-small" style={{ width: 'auto' }}>Save Changes</button>
              <button
                type="button"
                className="btn btn-small btn-dark"
                style={{ width: 'auto' }}
                onClick={() => setEditingStream(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {!editingStream && (
        <div className="glass-panel" style={{ marginBottom: '32px', padding: '24px' }}>
          <h3 style={{ marginBottom: '16px' }}>Add New Camera</h3>
          <form onSubmit={handleAdd}>
            <div style={{ display: 'flex', gap: '16px', marginBottom: '16px' }}>
              <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                <label className="form-label">Camera Name (no spaces)</label>
                <input
                  type="text"
                  className="form-input"
                  value={newCamName}
                  onChange={e => setNewCamName(e.target.value.replace(/\s+/g, '_'))}
                  placeholder="e.g. Front_Door"
                  required
                />
              </div>
              <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                <label className="form-label">IP Address</label>
                <input
                  type="text"
                  className="form-input"
                  value={newCamIP}
                  onChange={e => setNewCamIP(e.target.value)}
                  placeholder="192.168.1.100"
                  required
                />
              </div>
              <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                <label className="form-label">Stream Path</label>
                <input
                  type="text"
                  className="form-input"
                  value={newCamPath}
                  onChange={e => setNewCamPath(e.target.value)}
                  placeholder="/stream2"
                  required
                />
              </div>
              <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                <label className="form-label">Timezone</label>
                <input
                  type="text"
                  className="form-input"
                  value={newCamTZ}
                  onChange={e => setNewCamTZ(e.target.value)}
                  placeholder="America/New_York"
                  required
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
              <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                <label className="form-label">Username (optional)</label>
                <input
                  type="text"
                  className="form-input"
                  value={newCamUser}
                  onChange={e => setNewCamUser(e.target.value)}
                  placeholder="admin"
                />
              </div>
              <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                <label className="form-label">Password (optional)</label>
                <input
                  type="password"
                  className="form-input"
                  value={newCamPass}
                  onChange={e => setNewCamPass(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
              <button type="submit" className="btn btn-small" style={{ height: '42px', flex: 1 }}>
                Add Camera
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="glass-panel">
        {config?.streams?.map(stream => (
          <div key={stream.name} className="list-item" style={{ flexWrap: 'wrap', gap: '12px' }}>
            <div style={{ flex: 1, minWidth: '200px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <strong>{stream.name}</strong>
                {stream.worker_active && <span className="recording-dot" title="FFmpeg active" />}
              </div>
              <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                {stream.ip
                  ? `IP: ${stream.ip} · Path: ${stream.path} · TZ: ${stream.timezone || 'UTC'}`
                  : 'Legacy mode or invalid URL'}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => handleToggleRecord(stream)}
                className="btn btn-small"
                style={{
                  background: stream.is_recording !== false ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                  color: stream.is_recording !== false ? '#4ade80' : '#ef4444',
                  minWidth: '120px'
                }}
              >
                {stream.is_recording !== false ? 'Stop Recording' : 'Start Recording'}
              </button>
              <button
                onClick={() => setEditingStream({ ...stream, password: '' })}
                className="btn btn-small btn-dark"
              >
                Edit
              </button>
              <button onClick={() => handleDelete(stream.name)} className="btn btn-small btn-danger">
                Delete
              </button>
            </div>
          </div>
        ))}
        {(!config?.streams || config.streams.length === 0) && (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
            No cameras connected.
          </div>
        )}
      </div>
    </div>
  )
}

export default Cameras
