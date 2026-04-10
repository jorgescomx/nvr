import json
import logging
import os
import subprocess
import time
import threading
import urllib.request
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory, session
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
from cryptography.fernet import Fernet
import base64

# Environment variables with defaults
CONFIG_PATH = os.environ.get("CONFIG_PATH", "/config/config.json")
GO2RTC_CONFIG_PATH = os.environ.get("GO2RTC_CONFIG_PATH", "/config/go2rtc.yaml")
KEY_PATH = os.environ.get("ENCRYPTION_KEY_PATH", "/config/encryption.key")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("NVR")

app = Flask(__name__, static_folder='frontend/dist')
app.secret_key = os.environ.get("REC_SECRET_KEY", "nvr-dev-fallback-key-9921") 
CORS(app, supports_credentials=True)

# State tracking for dynamic restarts
active_processes = {}  # stream_name -> subprocess.Popen
active_threads = {}    # stream_name -> threading.Thread
stop_signals = {}      # stream_name -> bool

# Encryption logic
def get_cipher():
    if not os.path.exists(KEY_PATH):
        key = Fernet.generate_key()
        with open(KEY_PATH, "wb") as key_file:
            key_file.write(key)
    else:
        with open(KEY_PATH, "rb") as key_file:
            key = key_file.read()
    return Fernet(key)

cipher_suite = get_cipher()

def encrypt_value(text):
    return cipher_suite.encrypt(text.encode('utf-8')).decode('utf-8')

def decrypt_value(encrypted_text):
    try:
        return cipher_suite.decrypt(encrypted_text.encode('utf-8')).decode('utf-8')
    except Exception as e:
        logger.error(f"Decryption error: {e}")
        return None

def build_rtsp_url(ip, username, decrypted_password, path):
    # Strip leading slash if present to avoid double slashing
    p = path.lstrip('/')
    auth_part = f"{username}:{decrypted_password}@" if username and decrypted_password else ""
    return f"rtsp://{auth_part}{ip}:554/{p}"

def get_stream_url(stream):
    """Safely extracts and decrypts or builds the stream URL"""
    if "url" in stream:
        return stream["url"] # Legacy cleartext fallback
        
    if stream.get("ip"):
        password = ""
        if "encrypted_password" in stream:
            decrypted = decrypt_value(stream["encrypted_password"])
            if decrypted:
                password = decrypted
        return build_rtsp_url(stream.get("ip"), stream.get("username", ""), password, stream.get("path", "/stream2"))
        
    return None

def load_config():
    if not os.path.exists(CONFIG_PATH):
        return {
            "storage_path": "/recordings",
            "segment_time": 3600,
            "retention_days": 7,
            "max_storage_gb": 100,
            "streams": [],
            "username": "admin",
            "password_hash": generate_password_hash("admin")
        }
    with open(CONFIG_PATH, "r") as f:
        try:
            cfg = json.load(f)
            # Ensure auth defaults
            if "username" not in cfg:
                cfg["username"] = "admin"
            if "password_hash" not in cfg:
                cfg["password_hash"] = generate_password_hash("admin")
            return cfg
        except json.JSONDecodeError as e:
            logger.error(f"Error parsing config.json: {e}")
            return {}

def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)

def generate_go2rtc_config(streams):
    logger.info("Generating go2rtc.yaml configuration...")
    lines = [
        "webrtc:",
        "  listen: \":8555\"",
        "  candidates:",
        "    - stun:8555",
        "    - stun:stun.l.google.com:19302",
        "streams:"
    ]
    for stream in streams:
        name = stream.get("name")
        url = get_stream_url(stream)
        
        if name and url:
            # Force TCP and disable backchannel for maximum stability with Amcrest/Dahua/Hikvision
            if url.startswith("rtsp://") and "#" not in url:
                url += "#rtsp=tcp#backchannel=0"
            lines.append(f"  {name}: {url}")
            
    try:
        with open(GO2RTC_CONFIG_PATH, "w") as f:
            f.write("\n".join(lines) + "\n")
        logger.info(f"Successfully generated {GO2RTC_CONFIG_PATH}")
        # Signal go2rtc to restart and load the new yaml config
        # We retry a few times because go2rtc might be booting
        for i in range(5):
            try:
                req = urllib.request.Request("http://go2rtc:1984/api/restart", method="POST")
                urllib.request.urlopen(req, timeout=5)
                logger.info("Sent restart signal to go2rtc.")
                break
            except Exception as e:
                err_str = str(e)
                if "Connection reset" in err_str or "Remote end closed" in err_str or "104" in err_str or "10054" in err_str:
                    logger.info("Sent restart signal, go2rtc connection closed gracefully (expected).")
                    break
                logger.warning(f"Attempt {i+1}: Waiting for go2rtc API... ({err_str})")
                time.sleep(3)
        else:
            logger.error("Could not reach go2rtc API after 5 attempts.")
    except Exception as e:
        logger.error(f"Failed to generate go2rtc.yaml: {e}")

def get_dir_size(path):
    total = 0
    for dirpath, dirnames, filenames in os.walk(path):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            if not os.path.islink(fp):
                total += os.path.getsize(fp)
    return total

def cleanup_loop(storage_path):
    while True:
        try:
            cfg = load_config()
            retention_days = cfg.get("retention_days", 7)
            max_storage_gb = cfg.get("max_storage_gb", 100)
            
            # 1. Retention Days Cleanup
            if retention_days > 0:
                now = datetime.now()
                cutoff = now - timedelta(days=retention_days)
                
                for root, dirs, files in os.walk(storage_path):
                    for file in files:
                        if file.endswith(".mp4"):
                            filepath = os.path.join(root, file)
                            try:
                                file_mtime = datetime.fromtimestamp(os.path.getmtime(filepath))
                                if file_mtime < cutoff:
                                    logger.info(f"Deleting old recording (retention): {filepath}")
                                    os.remove(filepath)
                            except OSError:
                                pass
                                
            # 2. Max Storage Cleanup
            if max_storage_gb > 0:
                max_bytes = max_storage_gb * 1024 * 1024 * 1024
                while get_dir_size(storage_path) > max_bytes:
                    all_files = []
                    for root, dirs, files in os.walk(storage_path):
                        for file in files:
                            if file.endswith(".mp4"):
                                filepath = os.path.join(root, file)
                                try:
                                    all_files.append((filepath, os.path.getmtime(filepath)))
                                except OSError:
                                    pass
                                
                    if not all_files:
                        break
                        
                    all_files.sort(key=lambda x: x[1])
                    oldest_file = all_files[0][0]
                    logger.info(f"Storage limit exceeded. Deleting oldest file: {oldest_file}")
                    os.remove(oldest_file)
                            
            time.sleep(300)
        except Exception as e:
            logger.error(f"Error in cleanup loop: {e}")
            time.sleep(60)

def stream_worker(name, url, storage_path, segment_time, timezone_str="UTC"):
    logger.info(f"Starting worker for stream: {name}")
    
    # Give go2rtc a moment to start up if we just rebooted
    time.sleep(5)
    
    stream_dir = os.path.join(storage_path, name)
    os.makedirs(stream_dir, exist_ok=True)
    output_pattern = os.path.join(stream_dir, "%Y-%m-%d_%H-%M-%S.mp4")
    
    # Use the service name since we are back on a standard bridge network
    go2rtc_url = f"rtsp://go2rtc:8554/{name}"
    
    # Set up environment with the camera's specific timezone
    env = os.environ.copy()
    if timezone_str:
        env["TZ"] = timezone_str
        logger.info(f"Setting TZ={timezone_str} for {name}")
    
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-y",
        "-loglevel", "error", 
        "-rtsp_transport", "tcp",
        "-i", go2rtc_url,
        "-c:v", "copy",
        "-c:a", "aac",
        "-f", "segment",
        "-segment_time", str(segment_time),
        "-segment_format", "mp4",
        "-reset_timestamps", "1",
        "-strftime", "1",
        output_pattern
    ]
    
    while not stop_signals.get(name, False):
        try:
            logger.info(f"Launching FFmpeg for {name}...")
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env
            )
            active_processes[name] = process
            
            # Wait for process to finish
            stdout, stderr = process.communicate()
            
            if process.returncode != 0 and not stop_signals.get(name, False):
                logger.warning(f"FFmpeg process for {name} exited with code {process.returncode}.")
                if stderr:
                    logger.error(f"FFmpeg Error for {name}: {stderr.strip()}")
                # If it's failing immediately, let's wait a bit before retrying
                time.sleep(10)
            else:
                logger.info(f"FFmpeg process for {name} exited normally.")
                
        except Exception as e:
            logger.error(f"Error running FFmpeg for {name}: {e}")
            
        if not stop_signals.get(name, False):
            time.sleep(10)

def start_stream(stream, storage_path, segment_time):
    name = stream.get("name")
    
    # Check if stream has recording toggled off
    if stream.get("is_recording", True) == False:
        logger.info(f"Stream {name} has recording disabled.")
        return
        
    url = get_stream_url(stream)
    if not url:
        logger.error(f"Unable to extract URL for {name}")
        return
        
    if name in active_threads:
        return # Already running
        
    stop_signals[name] = False
    t = threading.Thread(
        target=stream_worker,
        args=(name, url, storage_path, segment_time, stream.get("timezone", "UTC")),
        daemon=True
    )
    active_threads[name] = t
    t.start()

def stop_stream(name):
    stop_signals[name] = True
    if name in active_processes:
        process = active_processes[name]
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        del active_processes[name]
    
    if name in active_threads:
        del active_threads[name]

def sync_workers():
    cfg = load_config()
    storage_path = cfg.get("storage_path", "/recordings")
    segment_time = cfg.get("segment_time", 3600)
    streams = cfg.get("streams", [])
    
    # Start new streams
    current_stream_names = set()
    for s in streams:
        name = s["name"]
        current_stream_names.add(name)
        
        # If it was disabled, stop it if it's currently running.
        if s.get("is_recording", True) == False:
            if name in active_threads:
                logger.info(f"Stopping stream currently marked as not recording: {name}")
                stop_stream(name)
        else:
            start_stream(s, storage_path, segment_time)
        
    # Stop removed streams
    for name in list(active_threads.keys()):
        if name not in current_stream_names:
            logger.info(f"Stopping removed stream: {name}")
            stop_stream(name)
            
    # Regenerate go2rtc configuration
    generate_go2rtc_config(streams)

# --- Flask Server API ---

def requires_auth(f):
    def wrapper(*args, **kwargs):
        if not session.get('authenticated'):
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    wrapper.__name__ = f.__name__
    return wrapper

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json
    cfg = load_config()
    
    if data.get("username") == cfg.get("username") and check_password_hash(cfg.get("password_hash"), data.get("password")):
        session['authenticated'] = True
        return jsonify({"message": "Success"}), 200
    return jsonify({"error": "Invalid credentials"}), 401

@app.route('/api/auth/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({"message": "Logged out"}), 200

@app.route('/api/auth/status', methods=['GET'])
def auth_status():
    if session.get('authenticated'):
        return jsonify({"authenticated": True}), 200
    return jsonify({"authenticated": False}), 401

@app.route('/api/auth/password', methods=['POST'])
@requires_auth
def change_password():
    data = request.json
    cfg = load_config()
    if not check_password_hash(cfg.get("password_hash"), data.get("current_password")):
        return jsonify({"error": "Incorrect current password"}), 400
        
    cfg["password_hash"] = generate_password_hash(data.get("new_password"))
    if data.get("username"):
        cfg["username"] = data.get("username")
    save_config(cfg)
    return jsonify({"message": "Password updated successfully"}), 200

@app.route('/api/config', methods=['GET'])
@requires_auth
def get_config():
    cfg = load_config()
    if "password_hash" in cfg:
        del cfg["password_hash"]
        
    # Mask streams encrypted password before returning purely for UI
    for s in cfg.get("streams", []):
        if "encrypted_password" in s:
            s["has_password"] = True
            del s["encrypted_password"] # Ensure we never leak the ciphertext visually
            
    return jsonify(cfg), 200

@app.route('/api/config', methods=['POST'])
@requires_auth
def update_config():
    data = request.json
    cfg = load_config()
    
    if "segment_time" in data:
        cfg["segment_time"] = int(data["segment_time"])
    if "retention_days" in data:
        cfg["retention_days"] = int(data["retention_days"])
    if "max_storage_gb" in data:
        cfg["max_storage_gb"] = int(data["max_storage_gb"])
        
    save_config(cfg)
    
    # If segment time changed, we must restart all threads
    if "segment_time" in data:
        sync_workers()
        # Full force restart of running stream workers 
        for name in list(active_threads.keys()):
            stop_stream(name)
        sync_workers()

    return jsonify({"message": "Settings updated"}), 200

@app.route('/api/streams/order', methods=['POST'])
@requires_auth
def reorder_streams():
    data = request.json
    order = data.get("order", [])
    if not order:
        return jsonify({"error": "No order provided"}), 400
        
    cfg = load_config()
    streams = cfg.get("streams", [])
    
    # Re-sort streams list based on the name list provided
    stream_map = {s["name"]: s for s in streams}
    new_streams = []
    for name in order:
        if name in stream_map:
            new_streams.append(stream_map[name])
            
    # Add any missing streams to the end just in case
    for s in streams:
        if s["name"] not in order:
            new_streams.append(s)
            
    cfg["streams"] = new_streams
    save_config(cfg)
    return jsonify({"message": "Order updated"}), 200

@app.route('/api/streams', methods=['POST'])
@requires_auth
def add_stream():
    data = request.json
    name = data.get("name")
    ip = data.get("ip")
    username = data.get("username")
    password = data.get("password")
    path = data.get("path", "/stream2")
    timezone = data.get("timezone", "UTC")
    
    if not name or not ip:
        return jsonify({"error": "Name and IP required"}), 400
        
    cfg = load_config()
    for s in cfg.get("streams", []):
        if s["name"] == name:
            return jsonify({"error": "Stream name already exists"}), 400
            
    stream_obj = {
        "name": name,
        "ip": ip,
        "username": username,
        "path": path,
        "timezone": timezone,
        "is_recording": True,
        "grid_size": 1
    }
    
    if password:
        stream_obj["encrypted_password"] = encrypt_value(password)
            
    cfg.setdefault("streams", []).append(stream_obj)
    save_config(cfg)
    sync_workers()
    
    return jsonify({"message": "Stream added"}), 201

@app.route('/api/streams/<name>', methods=['PUT'])
@requires_auth
def edit_stream(name):
    data = request.json
    cfg = load_config()
    
    found = False
    for s in cfg.get("streams", []):
        if s["name"] == name:
            found = True
            if "is_recording" in data:
                s["is_recording"] = data["is_recording"]
            if "grid_size" in data:
                s["grid_size"] = data["grid_size"]
            if "ip" in data:
                s["ip"] = data["ip"]
            if "username" in data:
                s["username"] = data["username"]
            if "path" in data:
                s["path"] = data["path"]
            if "timezone" in data:
                s["timezone"] = data["timezone"]
            if "layout" in data:
                s["layout"] = data["layout"]
            if "password" in data and data["password"]:
                s["encrypted_password"] = encrypt_value(data["password"])
            break
            
    if not found:
        return jsonify({"error": "Stream not found"}), 404
        
    save_config(cfg)
    sync_workers()
    
    return jsonify({"message": "Stream updated"}), 200

@app.route('/api/streams/<name>', methods=['DELETE'])
@requires_auth
def delete_stream(name):
    cfg = load_config()
    streams = cfg.get("streams", [])
    original_len = len(streams)
    cfg["streams"] = [s for s in streams if s["name"] != name]
    
    if len(cfg["streams"]) == original_len:
        return jsonify({"error": "Stream not found"}), 404
        
    save_config(cfg)
    sync_workers()
    
    return jsonify({"message": "Stream deleted"}), 200

# Muted player proxy - fetches go2rtc stream.html and injects mute script
@app.route('/player')
def muted_player():
    src = request.args.get('src', '')
    go2rtc_host = os.environ.get("GO2RTC_HOST", "go2rtc")
    try:
        url = f"http://{go2rtc_host}:1984/stream.html?src={src}&mode=webrtc,mse,mp4,mjpeg"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            html = resp.read().decode('utf-8')
        # Inject mute script before </body>
        mute_script = """
<script>
// Force mute on all video elements
function forceMute() {
    document.querySelectorAll('video').forEach(v => { v.muted = true; v.volume = 0; });
}
// Run on load and periodically for dynamically created elements
forceMute();
setInterval(forceMute, 500);
new MutationObserver(forceMute).observe(document.body, {childList: true, subtree: true});
</script>
"""
        html = html.replace('</body>', mute_script + '</body>')
        from flask import Response
        return Response(html, content_type='text/html')
    except Exception as e:
        logger.error(f"Player proxy error: {e}")
        return f"Error loading player: {e}", 500

# Serve Vite frontend
@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve(path):
    if path != "" and os.path.exists(app.static_folder + '/' + path):
        return send_from_directory(app.static_folder, path)
    else:
        return send_from_directory(app.static_folder, 'index.html')

if __name__ == "__main__":
    logger.info("Initializing Portable Full-Stack Docker NVR backend...")
    
    # Ensure config directory exists
    config_dir = os.path.dirname(CONFIG_PATH)
    if config_dir:
        os.makedirs(config_dir, exist_ok=True)
        
    cfg = load_config()
    os.makedirs(cfg.get("storage_path", "/recordings"), exist_ok=True)
    
    ct = threading.Thread(target=cleanup_loop, args=(cfg.get("storage_path", "/recordings"),), daemon=True)
    ct.start()
    sync_workers()
    app.run(host='0.0.0.0', port=5000, threaded=True)
