import { useState } from 'react'

function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      })
      if (res.ok) {
        onLogin()
      } else if (res.status === 429) {
        setError('Too many login attempts. Try again in a minute.')
      } else {
        setError('Invalid username or password.')
      }
    } catch {
      setError('Network error.')
    }
  }

  return (
    <div className="login-wrapper">
      <div className="glass-panel login-box">
        <h1 className="login-title">NVR Login</h1>
        {error && <div style={{ color: 'var(--danger-color)', marginBottom: '16px' }}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Username</label>
            <input
              type="text"
              className="form-input"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              type="password"
              className="form-input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>
          <button type="submit" className="btn">Sign In</button>
        </form>
      </div>
    </div>
  )
}

export default Login
