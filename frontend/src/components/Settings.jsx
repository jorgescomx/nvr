import { useState } from 'react'

function Settings({ config, reload }) {
  const [maxStorage, setMaxStorage] = useState(config?.max_storage_gb || 0)
  const [retention, setRetention] = useState(config?.retention_days || 0)
  const [segmentTime, setSegmentTime] = useState(
    config?.segment_time ? Math.round(config.segment_time / 60) : 60
  )

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
    alert('System settings saved and applied to background engines.')
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
        <div className="glass-panel" style={{ padding: '24px' }}>
          <h3 style={{ marginBottom: '24px' }}>Engine Policies</h3>

          <div className="form-group" style={{ paddingBottom: '16px', borderBottom: '1px solid var(--glass-border)' }}>
            <label className="form-label">Recording Segment Size (minutes)</label>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
              Duration of each recording file (default: 60 = 1 hour).
            </div>
            <input
              type="number"
              className="form-input"
              value={segmentTime}
              onChange={e => setSegmentTime(e.target.value)}
            />
          </div>

          <div className="form-group" style={{ marginTop: '16px' }}>
            <label className="form-label">Max Storage Capacity (GB) — 0 to disable</label>
            <input
              type="number"
              className="form-input"
              value={maxStorage}
              onChange={e => setMaxStorage(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Retention Time (Days) — 0 to disable</label>
            <input
              type="number"
              className="form-input"
              value={retention}
              onChange={e => setRetention(e.target.value)}
            />
          </div>

          <button onClick={handleSaveStorage} className="btn" style={{ marginTop: '16px' }}>
            Save Engine Policies
          </button>
        </div>

        <div className="glass-panel" style={{ padding: '24px' }}>
          <h3 style={{ marginBottom: '24px' }}>Security & Authentication</h3>
          <form onSubmit={handleUpdatePassword}>
            <div className="form-group">
              <label className="form-label">Current Password</label>
              <input
                type="password"
                className="form-input"
                value={currentPass}
                onChange={e => setCurrentPass(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label className="form-label">New Password</label>
              <input
                type="password"
                className="form-input"
                value={newPass}
                onChange={e => setNewPass(e.target.value)}
                required
                minLength={4}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Verify Password</label>
              <input
                type="password"
                className="form-input"
                value={verifyPass}
                onChange={e => setVerifyPass(e.target.value)}
                required
                minLength={4}
              />
            </div>
            <button type="submit" className="btn">Change Password</button>
            {passMsg && (
              <div style={{
                marginTop: '12px',
                fontSize: '0.875rem',
                color: passMsg.includes('Failed') || passMsg.includes('match') ? 'var(--danger-color)' : '#4ade80'
              }}>
                {passMsg}
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  )
}

export default Settings
