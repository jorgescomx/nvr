import { useState, useEffect, useRef } from 'react'

const SECONDS_IN_DAY = 86400

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function secToHHMMSS(sec) {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600).toString().padStart(2, '0')
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0')
  const ss = (s % 60).toString().padStart(2, '0')
  return `${h}:${m}:${ss}`
}

function Recordings({ active }) {
  const [cameras, setCameras] = useState([])
  const [selectedCamera, setSelectedCamera] = useState(null)
  const [availableDays, setAvailableDays] = useState([])
  const [selectedDate, setSelectedDate] = useState(null)
  const [segments, setSegments] = useState([])
  const [hoveredSeg, setHoveredSeg] = useState(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })

  // Which segment index is currently loaded in the player
  const [activeIdx, setActiveIdx] = useState(null)
  // Playhead position in absolute day-seconds
  const [playheadSec, setPlayheadSec] = useState(null)

  const videoRef = useRef(null)
  const timelineRef = useRef(null)
  const activeIdxRef = useRef(null)
  const segmentsRef = useRef([])
  const cameraRef = useRef(null)

  // Keep refs in sync so event handlers always see current values
  useEffect(() => { activeIdxRef.current = activeIdx }, [activeIdx])
  useEffect(() => { segmentsRef.current = segments }, [segments])
  useEffect(() => { cameraRef.current = selectedCamera }, [selectedCamera])

  useEffect(() => {
    if (active) loadCameras()
  }, [active])

  useEffect(() => {
    if (selectedCamera) loadDays(selectedCamera)
  }, [selectedCamera])

  useEffect(() => {
    if (selectedCamera && selectedDate) loadTimeline(selectedCamera, selectedDate)
  }, [selectedCamera, selectedDate])

  const loadCameras = async () => {
    try {
      const res = await fetch('/api/recordings')
      if (res.ok) {
        const data = await res.json()
        setCameras(data)
        if (data.length > 0) setSelectedCamera(prev => prev || data[0].name)
      }
    } catch (e) { console.error(e) }
  }

  const loadDays = async (camera) => {
    try {
      const res = await fetch(`/api/recordings/${camera}/days`)
      if (res.ok) {
        const days = await res.json()
        setAvailableDays(days)
        setSelectedDate(prev => (prev && days.includes(prev)) ? prev : (days[0] || null))
      }
    } catch (e) { console.error(e) }
  }

  const loadTimeline = async (camera, date) => {
    try {
      const res = await fetch(`/api/recordings/${camera}/timeline?date=${date}`)
      if (res.ok) {
        const data = await res.json()
        setSegments(data)
        // Reset player
        if (videoRef.current) { videoRef.current.src = ''; videoRef.current.load() }
        setActiveIdx(null)
        setPlayheadSec(null)
      }
    } catch (e) { console.error(e) }
  }

  // Load a segment by index into the video player
  const playSegment = (idx, seekToSec = null) => {
    const segs = segmentsRef.current
    const camera = cameraRef.current
    if (idx < 0 || idx >= segs.length || !videoRef.current) return
    const seg = segs[idx]
    const video = videoRef.current

    setActiveIdx(idx)
    video.src = `/api/recordings/${camera}/${seg.filename}`

    if (seekToSec !== null && seekToSec > 0) {
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = seekToSec
      }, { once: true })
    }

    video.load()
    video.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  // When video ends, auto-advance to next segment
  const handleEnded = () => {
    const next = (activeIdxRef.current ?? -1) + 1
    if (next < segmentsRef.current.length) {
      playSegment(next)
    }
  }

  // Update playhead position continuously
  const handleTimeUpdate = () => {
    const idx = activeIdxRef.current
    const segs = segmentsRef.current
    if (idx === null || !videoRef.current) return
    const seg = segs[idx]
    if (!seg) return
    setPlayheadSec(seg.start_sec + videoRef.current.currentTime)
  }

  // Click on timeline — find segment and seek into it
  const handleTimelineClick = (e) => {
    if (!segments.length || !timelineRef.current) return
    const rect = timelineRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const clickedSec = pct * SECONDS_IN_DAY

    const idx = segments.findIndex(s => clickedSec >= s.start_sec && clickedSec < s.end_sec)
    if (idx === -1) return

    const seg = segments[idx]
    const offsetInSeg = Math.max(0, clickedSec - seg.start_sec)
    playSegment(idx, offsetInSeg)
  }

  const handleTimelineMouseMove = (e) => {
    if (!segments.length || !timelineRef.current) return
    const rect = timelineRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const hovSec = pct * SECONDS_IN_DAY
    const seg = segments.find(s => hovSec >= s.start_sec && hovSec < s.end_sec)
    setHoveredSeg(seg || null)
    setTooltipPos({ x: e.clientX - rect.left })
  }

  const goToPrevDay = () => {
    const idx = availableDays.indexOf(selectedDate)
    if (idx < availableDays.length - 1) setSelectedDate(availableDays[idx + 1])
  }

  const goToNextDay = () => {
    const idx = availableDays.indexOf(selectedDate)
    if (idx > 0) setSelectedDate(availableDays[idx - 1])
  }

  const totalRecordedSec = segments.reduce((acc, s) => acc + (s.end_sec - s.start_sec), 0)
  const totalSize = segments.reduce((acc, s) => acc + s.size, 0)

  if (cameras.length === 0) {
    return (
      <div>
        <h2 className="page-title">Recordings</h2>
        <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
          No recordings found. Recordings appear here once cameras start recording.
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2 className="page-title">Recordings</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: '24px', alignItems: 'start' }}>

        {/* Camera sidebar */}
        <div className="glass-panel" style={{ padding: '8px' }}>
          {cameras.map(cam => (
            <div
              key={cam.name}
              className={`rec-camera-item ${selectedCamera === cam.name ? 'active' : ''}`}
              onClick={() => setSelectedCamera(cam.name)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{cam.name}</div>
                <button
                  className="btn btn-small btn-danger"
                  style={{ width: 'auto', padding: '2px 8px', fontSize: '0.7rem', flexShrink: 0, marginLeft: '6px' }}
                  title="Delete all recordings"
                  onClick={async (e) => {
                    e.stopPropagation()
                    if (!window.confirm(`Delete ALL recordings for ${cam.name}?`)) return
                    await fetch(`/api/recordings/${cam.name}`, { method: 'DELETE' })
                    if (selectedCamera === cam.name) {
                      setSelectedCamera(null)
                      setSegments([])
                      setAvailableDays([])
                    }
                    loadCameras()
                  }}
                >✕</button>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                {cam.count} file{cam.count !== 1 ? 's' : ''} · {formatSize(cam.size)}
              </div>
            </div>
          ))}
        </div>

        {/* Main area */}
        <div>

          {/* Date navigation */}
          {availableDays.length > 0 && (
            <div className="glass-panel" style={{ padding: '16px 20px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '16px' }}>
              <button
                className="btn btn-small btn-dark"
                style={{ width: 'auto', padding: '6px 14px' }}
                onClick={goToPrevDay}
                disabled={availableDays.indexOf(selectedDate) >= availableDays.length - 1}
              >
                ← Older
              </button>
              <select
                className="form-input"
                style={{ flex: 1, maxWidth: '200px', padding: '6px 12px', height: 'auto' }}
                value={selectedDate || ''}
                onChange={e => setSelectedDate(e.target.value)}
              >
                {availableDays.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <button
                className="btn btn-small btn-dark"
                style={{ width: 'auto', padding: '6px 14px' }}
                onClick={goToNextDay}
                disabled={availableDays.indexOf(selectedDate) <= 0}
              >
                Newer →
              </button>
              {segments.length > 0 && (
                <div style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {segments.length} segment{segments.length !== 1 ? 's' : ''} · {secToHHMMSS(totalRecordedSec)} recorded · {formatSize(totalSize)}
                </div>
              )}
            </div>
          )}

          {/* Timeline */}
          {selectedDate && (
            <div className="glass-panel" style={{ padding: '20px', marginBottom: '20px' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '12px', fontWeight: 600 }}>
                TIMELINE — click a segment to play
              </div>

              {segments.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                  No recordings for this date.
                </div>
              ) : (
                <>
                  {/* Hour axis */}
                  <div style={{ position: 'relative', marginBottom: '6px', height: '16px' }}>
                    {[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => (
                      <span key={h} style={{
                        position: 'absolute',
                        left: `${(h / 24) * 100}%`,
                        transform: h === 24 ? 'translateX(-100%)' : h === 0 ? 'none' : 'translateX(-50%)',
                        fontSize: '0.7rem',
                        color: 'var(--text-muted)',
                      }}>
                        {String(h).padStart(2, '0')}:00
                      </span>
                    ))}
                  </div>

                  {/* Bar */}
                  <div
                    ref={timelineRef}
                    className="timeline-bar"
                    onClick={handleTimelineClick}
                    onMouseMove={handleTimelineMouseMove}
                    onMouseLeave={() => setHoveredSeg(null)}
                  >
                    {segments.map((seg, idx) => {
                      const leftPct = (seg.start_sec / SECONDS_IN_DAY) * 100
                      const widthPct = ((seg.end_sec - seg.start_sec) / SECONDS_IN_DAY) * 100
                      return (
                        <div
                          key={seg.filename}
                          className={`timeline-segment ${activeIdx === idx ? 'active' : ''} ${hoveredSeg?.filename === seg.filename ? 'hovered' : ''}`}
                          style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.3)}%` }}
                          onClick={(e) => { e.stopPropagation(); playSegment(idx) }}
                          title={`${seg.start_ts} — ${formatSize(seg.size)}`}
                        />
                      )
                    })}

                    {/* Playhead needle */}
                    {playheadSec !== null && (
                      <div
                        className="timeline-playhead"
                        style={{ left: `${(playheadSec / SECONDS_IN_DAY) * 100}%` }}
                      />
                    )}

                    {/* Hover tooltip */}
                    {hoveredSeg && (
                      <div className="timeline-tooltip" style={{
                        left: Math.min(tooltipPos.x, (timelineRef.current?.offsetWidth || 999) - 160),
                      }}>
                        <strong>{hoveredSeg.start_ts}</strong>
                        <span> · {formatSize(hoveredSeg.size)}</span>
                        <div style={{ fontSize: '0.7rem', opacity: 0.7, marginTop: '2px' }}>Click to play</div>
                      </div>
                    )}
                  </div>

                  {/* Playhead label */}
                  {playheadSec !== null && (
                    <div style={{ marginTop: '10px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Position <strong style={{ color: 'var(--text-main)' }}>{secToHHMMSS(playheadSec)}</strong>
                      {activeIdx !== null && segments[activeIdx] && (
                        <> · Segment <strong style={{ color: 'var(--accent-color)' }}>{segments[activeIdx].start_ts}</strong></>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Video player */}
          <div className="glass-panel" style={{ padding: '16px', marginBottom: '20px', display: activeIdx !== null ? 'block' : 'none' }}>
            <video
              ref={videoRef}
              controls
              style={{ width: '100%', borderRadius: '8px', background: '#000', maxHeight: '500px', display: 'block' }}
              onTimeUpdate={handleTimeUpdate}
            />
          </div>

          {/* Segment list */}
          {segments.length > 0 && (
            <div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                Segments — {selectedDate}
              </div>
              <div className="glass-panel">
                {segments.map((seg, idx) => (
                  <div
                    key={seg.filename}
                    className={`list-item rec-file-item ${activeIdx === idx ? 'selected' : ''}`}
                    onClick={() => playSegment(idx)}
                  >
                    <div>
                      <div style={{ fontWeight: 500, fontSize: '0.9rem' }}>{seg.start_ts}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {seg.filename} · {formatSize(seg.size)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                      <button className="btn btn-small" style={{ width: 'auto' }}
                        onClick={e => { e.stopPropagation(); playSegment(idx) }}>
                        Play
                      </button>
                      <a
                        href={`/api/recordings/${selectedCamera}/${seg.filename}`}
                        download={seg.filename.replace('.ts', '.mp4')}
                        className="btn btn-small btn-dark"
                        style={{ width: 'auto', textDecoration: 'none' }}
                        onClick={e => e.stopPropagation()}
                      >
                        Download
                      </a>
                      <button
                        className="btn btn-small btn-danger"
                        style={{ width: 'auto' }}
                        onClick={async e => {
                          e.stopPropagation()
                          if (!window.confirm(`Delete ${seg.filename}?`)) return
                          await fetch(`/api/recordings/${selectedCamera}/${seg.filename}`, { method: 'DELETE' })
                          if (activeIdx === idx) {
                            if (videoRef.current) { videoRef.current.src = ''; videoRef.current.load() }
                            setActiveIdx(null)
                            setPlayheadSec(null)
                          }
                          loadTimeline(selectedCamera, selectedDate)
                          loadCameras()
                        }}
                      >Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

export default Recordings
