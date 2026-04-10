import { useState } from 'react'
import CameraFeed from './CameraFeed'

function Dashboard({ config }) {
  const [localLayouts, setLocalLayouts] = useState({})

  if (!config || !config.streams || config.streams.length === 0) {
    return (
      <div>
        <h2 className="page-title">Live Dashboard</h2>
        <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
          No cameras configured yet. Go to the Cameras tab to add one.
        </div>
      </div>
    )
  }

  const getLayout = (stream, idx) => {
    if (localLayouts[stream.name]) return localLayouts[stream.name]
    if (stream.layout) return stream.layout
    const count = Math.max(1, config.streams.length)
    const cols = Math.ceil(Math.sqrt(count))
    const row = Math.floor(idx / cols)
    const col = idx % cols
    const baseW = 96 / cols
    const baseH = 45
    return {
      x: 2 + col * baseW,
      y: 2 + row * baseH,
      w: baseW - 2,
      h: baseH - 4
    }
  }

  const saveLayout = async (streamName, layout) => {
    setLocalLayouts(prev => ({ ...prev, [streamName]: layout }))
    await fetch(`/api/streams/${streamName}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout })
    })
  }

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

    const ghost = document.createElement('div')
    ghost.style.cssText = `position:fixed;width:${Math.min(280, cardRect.width)}px;height:45px;background:var(--bg-panel);border:2px solid var(--accent-color);border-radius:10px;opacity:0.85;z-index:10001;pointer-events:none;display:flex;align-items:center;padding:0 16px;font-family:Inter,sans-serif;font-weight:600;color:var(--text-main);font-size:14px;box-shadow:0 12px 40px rgba(0,0,0,0.5);backdrop-filter:blur(12px);left:${e.clientX - 20}px;top:${e.clientY - 22}px;`
    ghost.textContent = stream.name
    document.body.appendChild(ghost)

    card.style.opacity = '0.3'

    overlay.onmousemove = (moveEvent) => {
      ghost.style.left = moveEvent.clientX - 20 + 'px'
      ghost.style.top = moveEvent.clientY - 22 + 'px'
      const newLeft = moveEvent.clientX - containerRect.left - offsetX
      const newTop = moveEvent.clientY - containerRect.top - offsetY
      const pctX = Math.max(0, Math.min(100 - 5, (newLeft / containerRect.width) * 100))
      const pctY = Math.max(0, Math.min(100 - 5, (newTop / containerRect.height) * 100))
      card.style.left = pctX + '%'
      card.style.top = pctY + '%'
    }

    overlay.onmouseup = async () => {
      if (ghost.parentNode) document.body.removeChild(ghost)
      if (overlay.parentNode) document.body.removeChild(overlay)
      iframes.forEach(f => { f.style.pointerEvents = '' })
      card.style.opacity = ''
      const finalLeft = parseFloat(card.style.left)
      const finalTop = parseFloat(card.style.top)
      const layout = getLayout(stream, idx)
      await saveLayout(stream.name, { ...layout, x: finalLeft, y: finalTop })
    }
  }

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
      indicator.style.left = moveEvent.clientX + 12 + 'px'
      indicator.style.top = moveEvent.clientY - 12 + 'px'
    }

    overlay.onmouseup = async () => {
      if (overlay.parentNode) document.body.removeChild(overlay)
      if (indicator.parentNode) document.body.removeChild(indicator)
      iframes.forEach(f => { f.style.pointerEvents = '' })
      const finalW = (card.offsetWidth / containerRect.width) * 100
      const finalH = (card.offsetHeight / containerRect.height) * 100
      card.style.width = ''
      card.style.height = ''
      card.style.outline = ''
      card.style.transition = ''
      const layout = getLayout(stream, idx)
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
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {stream.worker_active && (
                    <span className="recording-dot" title="FFmpeg recording active" />
                  )}
                  {stream.is_recording !== false ? (
                    <span className="camera-status">RECORDING</span>
                  ) : (
                    <span className="camera-status" style={{ background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' }}>
                      NOT RECORDING
                    </span>
                  )}
                </div>
              </div>
              <div className="camera-feed">
                <CameraFeed streamName={stream.name} />
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

export default Dashboard
