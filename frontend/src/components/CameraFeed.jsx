function CameraFeed({ streamName }) {
  return (
    <iframe
      className="webrtc-iframe"
      src={`/player?src=${encodeURIComponent(streamName)}`}
      allow="autoplay; fullscreen"
    />
  )
}

export default CameraFeed
