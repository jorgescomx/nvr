import { useEffect, useRef } from 'react'
import Hls from 'hls.js'

function CameraFeed({ streamName }) {
  const videoRef = useRef(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const src = `/hls/${encodeURIComponent(streamName)}/stream.m3u8`
    let hls

    if (Hls.isSupported()) {
      hls = new Hls({
        liveSyncDurationCount: 1,
        liveMaxLatencyDurationCount: 3,
        maxBufferLength: 2,
        enableWorker: true,
      })
      hls.loadSource(src)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}))
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src
      video.play().catch(() => {})
    }

    return () => { if (hls) hls.destroy() }
  }, [streamName])

  return (
    <video
      ref={videoRef}
      muted
      autoPlay
      playsInline
      style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
    />
  )
}

export default CameraFeed
