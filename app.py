import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
import time
import threading
import urllib.request
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory, session, Response
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
from cryptography.fernet import Fernet

# Environment variables
DB_PATH = os.environ.get("DB_PATH", "/config/nvr.db")
GO2RTC_CONFIG_PATH = os.environ.get("GO2RTC_CONFIG_PATH", "/config/go2rtc.yaml")
KEY_PATH = os.environ.get("ENCRYPTION_KEY_PATH", "/config/encryption.key")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("NVR")

app = Flask(__name__, static_folder='frontend/dist')

# Enforce secret key — fail fast if not set
_secret_key = os.environ.get("REC_SECRET_KEY")
if not _secret_key:
    logger.error("FATAL: REC_SECRET_KEY environment variable is not set. Set it in docker-compose.yml.")
    sys.exit(1)
app.secret_key = _secret_key

CORS(app, supports_credentials=True)

# Stream state
active_processes = {}  # stream_name -> subprocess.Popen
active_threads = {}    # stream_name -> threading.Thread
stop_signals = {}      # stream_name -> bool

# Rate limiting (in-memory, per IP)
_login_attempts = {}
_login_lock = threading.Lock()
MAX_LOGIN_ATTEMPTS = 5
LOGIN_WINDOW_SECONDS = 60

def is_rate_limited(ip):
    now = time.time()
    with _login_lock:
        attempts = [t for t in _login_attempts.get(ip, []) if now - t < LOGIN_WINDOW_SECONDS]
        if len(attempts) >= MAX_LOGIN_ATTEMPTS:
            _login_attempts[ip] = attempts
            return True
        attempts.append(now)
        _login_attempts[ip] = attempts
        return False

# Input validation
_SAFE_IP_RE = re.compile(r'^[\w.\-]+$')
_SAFE_PATH_RE = re.compile(r'^[/\w.\-?=&]+$')

def validate_stream_input(ip, path):
    if not ip or not _SAFE_IP_RE.match(ip) or len(ip) > 255:
        return False, "Invalid IP address or hostname"
    if not path or not _SAFE_PATH_RE.match(path) or len(path) > 255:
        return False, "Invalid stream path"
    return True, None

# Encryption
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

# SQLite database
def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS streams (
                name TEXT PRIMARY KEY,
                ip TEXT,
                username TEXT,
                encrypted_password TEXT,
                path TEXT DEFAULT '/stream2',
                timezone TEXT DEFAULT 'UTC',
                is_recording INTEGER DEFAULT 1,
                grid_size INTEGER DEFAULT 1,
                layout TEXT,
                sort_order INTEGER DEFAULT 0
            )
        """)
        defaults = {
            'storage_path': '/recordings',
            'segment_time': '3600',
            'retention_days': '7',
            'max_storage_gb': '100',
            'username': 'admin',
            'password_hash': generate_password_hash('admin')
        }
        for key, value in defaults.items():
            conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value))
        conn.commit()

def migrate_from_json():
    """One-time migration from config.json to SQLite."""
    config_path = os.environ.get("CONFIG_PATH", "/config/config.json")
    if not os.path.exists(config_path):
        return
    try:
        with get_db() as conn:
            count = conn.execute("SELECT COUNT(*) FROM streams").fetchone()[0]
            if count > 0:
                return  # Already migrated
        with open(config_path, 'r') as f:
            cfg = json.load(f)
        with get_db() as conn:
            for key in ['storage_path', 'segment_time', 'retention_days', 'max_storage_gb', 'username', 'password_hash']:
                if key in cfg:
                    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(cfg[key])))
            for i, stream in enumerate(cfg.get('streams', [])):
                layout = json.dumps(stream.get('layout')) if stream.get('layout') else None
                conn.execute("""
                    INSERT OR REPLACE INTO streams
                    (name, ip, username, encrypted_password, path, timezone, is_recording, grid_size, layout, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    stream.get('name'),
                    stream.get('ip'),
                    stream.get('username'),
                    stream.get('encrypted_password'),
                    stream.get('path', '/stream2'),
                    stream.get('timezone', 'UTC'),
                    1 if stream.get('is_recording', True) else 0,
                    stream.get('grid_size', 1),
                    layout,
                    i
                ))
            conn.commit()
        logger.info("Migrated config from JSON to SQLite")
    except Exception as e:
        logger.error(f"Migration from JSON failed: {e}")

def load_config():
    with get_db() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        settings = {row['key']: row['value'] for row in rows}
        stream_rows = conn.execute("SELECT * FROM streams ORDER BY sort_order, name").fetchall()
        streams = []
        for row in stream_rows:
            s = dict(row)
            if s.get('layout'):
                try:
                    s['layout'] = json.loads(s['layout'])
                except Exception:
                    s['layout'] = None
            s['is_recording'] = bool(s['is_recording'])
            streams.append(s)
    return {
        'storage_path': settings.get('storage_path', '/recordings'),
        'segment_time': int(settings.get('segment_time', 3600)),
        'retention_days': int(settings.get('retention_days', 7)),
        'max_storage_gb': int(settings.get('max_storage_gb', 100)),
        'username': settings.get('username', 'admin'),
        'password_hash': settings.get('password_hash', generate_password_hash('admin')),
        'streams': streams
    }

def save_config(cfg):
    with get_db() as conn:
        for key in ['storage_path', 'segment_time', 'retention_days', 'max_storage_gb', 'username', 'password_hash']:
            if key in cfg:
                conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(cfg[key])))
        if 'streams' in cfg:
            conn.execute("DELETE FROM streams")
            for i, s in enumerate(cfg['streams']):
                layout = json.dumps(s['layout']) if s.get('layout') else None
                conn.execute("""
                    INSERT INTO streams
                    (name, ip, username, encrypted_password, path, timezone, is_recording, grid_size, layout, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    s.get('name'),
                    s.get('ip'),
                    s.get('username'),
                    s.get('encrypted_password'),
                    s.get('path', '/stream2'),
                    s.get('timezone', 'UTC'),
                    1 if s.get('is_recording', True) else 0,
                    s.get('grid_size', 1),
                    layout,
                    i
                ))
        conn.commit()

def build_rtsp_url(ip, username, decrypted_password, path):
    p = path.lstrip('/')
    auth_part = f"{username}:{decrypted_password}@" if username and decrypted_password else ""
    return f"rtsp://{auth_part}{ip}:554/{p}"

def get_stream_url(stream):
    if "url" in stream:
        return stream["url"]  # Legacy cleartext fallback
    if stream.get("ip"):
        password = ""
        if "encrypted_password" in stream and stream["encrypted_password"]:
            decrypted = decrypt_value(stream["encrypted_password"])
            if decrypted:
                password = decrypted
        return build_rtsp_url(stream.get("ip"), stream.get("username", ""), password, stream.get("path", "/stream2"))
    return None

def generate_go2rtc_config(streams):
    logger.info("Generating go2rtc.yaml configuration...")
    lines = [
        "api:",
        "  origin: '*'",
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
            if url.startswith("rtsp://") and "#" not in url:
                url += "#rtsp=tcp#backchannel=0"
            lines.append(f"  {name}: {url}")
    try:
        with open(GO2RTC_CONFIG_PATH, "w") as f:
            f.write("\n".join(lines) + "\n")
        logger.info(f"Successfully generated {GO2RTC_CONFIG_PATH}")
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

            if retention_days > 0:
                now = datetime.now()
                cutoff = now - timedelta(days=retention_days)
                for root, dirs, files in os.walk(storage_path):
                    for file in files:
                        if file.endswith(".ts") or file.endswith(".mp4"):
                            filepath = os.path.join(root, file)
                            try:
                                file_mtime = datetime.fromtimestamp(os.path.getmtime(filepath))
                                if file_mtime < cutoff:
                                    logger.info(f"Deleting old recording (retention): {filepath}")
                                    os.remove(filepath)
                            except OSError:
                                pass

            if max_storage_gb > 0:
                max_bytes = max_storage_gb * 1024 * 1024 * 1024
                while get_dir_size(storage_path) > max_bytes:
                    all_files = []
                    for root, dirs, files in os.walk(storage_path):
                        for file in files:
                            if file.endswith(".ts") or file.endswith(".mp4"):
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
    time.sleep(5)

    stream_dir = os.path.join(storage_path, name)
    os.makedirs(stream_dir, exist_ok=True)
    # Use MPEG-TS: always valid even if FFmpeg is killed mid-segment.
    # MP4 requires a clean shutdown to write the moov atom; TS does not.
    output_pattern = os.path.join(stream_dir, "%Y-%m-%d_%H-%M-%S.ts")

    go2rtc_url = f"rtsp://go2rtc:8554/{name}"

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
        "-segment_format", "mpegts",
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
            stdout, stderr = process.communicate()

            if process.returncode != 0 and not stop_signals.get(name, False):
                logger.warning(f"FFmpeg process for {name} exited with code {process.returncode}.")
                if stderr:
                    logger.error(f"FFmpeg Error for {name}: {stderr.strip()}")
                time.sleep(10)
            else:
                logger.info(f"FFmpeg process for {name} exited normally.")
        except Exception as e:
            logger.error(f"Error running FFmpeg for {name}: {e}")

        if not stop_signals.get(name, False):
            time.sleep(10)

def start_stream(stream, storage_path, segment_time):
    name = stream.get("name")
    if stream.get("is_recording", True) == False:
        logger.info(f"Stream {name} has recording disabled.")
        return
    url = get_stream_url(stream)
    if not url:
        logger.error(f"Unable to extract URL for {name}")
        return
    if name in active_threads and active_threads[name].is_alive():
        return  # Already running
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

    current_stream_names = set()
    for s in streams:
        name = s["name"]
        current_stream_names.add(name)
        if s.get("is_recording", True) == False:
            if name in active_threads:
                logger.info(f"Stopping stream currently marked as not recording: {name}")
                stop_stream(name)
        else:
            start_stream(s, storage_path, segment_time)

    for name in list(active_threads.keys()):
        if name not in current_stream_names:
            logger.info(f"Stopping removed stream: {name}")
            stop_stream(name)

    generate_go2rtc_config(streams)

def watchdog_loop():
    """Monitor stream threads and restart any that have died unexpectedly."""
    while True:
        try:
            time.sleep(30)
            cfg = load_config()
            storage_path = cfg.get('storage_path', '/recordings')
            segment_time = cfg.get('segment_time', 3600)
            streams = {s['name']: s for s in cfg.get('streams', [])}

            for name in list(active_threads.keys()):
                thread = active_threads[name]
                if not thread.is_alive() and not stop_signals.get(name, False):
                    logger.warning(f"Stream thread for {name} has died unexpectedly. Restarting...")
                    del active_threads[name]
                    if name in active_processes:
                        del active_processes[name]
                    if name in streams:
                        start_stream(streams[name], storage_path, segment_time)
        except Exception as e:
            logger.error(f"Watchdog error: {e}")

# --- Flask API ---

def requires_auth(f):
    def wrapper(*args, **kwargs):
        if not session.get('authenticated'):
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    wrapper.__name__ = f.__name__
    return wrapper

@app.route('/api/health', methods=['GET'])
def health():
    recording_count = sum(1 for t in active_threads.values() if t.is_alive())
    return jsonify({
        'status': 'ok',
        'active_streams': len(active_threads),
        'recording_streams': recording_count
    }), 200

@app.route('/api/auth/login', methods=['POST'])
def login():
    ip = request.remote_addr
    if is_rate_limited(ip):
        return jsonify({"error": "Too many login attempts. Try again in a minute."}), 429

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
    for s in cfg.get("streams", []):
        if "encrypted_password" in s:
            s["has_password"] = True
            del s["encrypted_password"]
        # Expose live worker status so the UI can show a real indicator
        s["worker_active"] = s["name"] in active_threads and active_threads[s["name"]].is_alive()
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

    if "segment_time" in data:
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
    stream_map = {s["name"]: s for s in streams}
    new_streams = [stream_map[name] for name in order if name in stream_map]
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

    valid, err = validate_stream_input(ip, path)
    if not valid:
        return jsonify({"error": err}), 400

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
        "is_recording": False,
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
                new_ip = data["ip"]
                new_path = data.get("path", s.get("path", "/stream2"))
                valid, err = validate_stream_input(new_ip, new_path)
                if not valid:
                    return jsonify({"error": err}), 400
                s["ip"] = new_ip
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

# Recordings API

def parse_filename_dt(filename):
    """Parse datetime from recording filename like 2025-04-10_14-32-00.ts or .mp4"""
    try:
        stem = filename
        for ext in ('.ts', '.mp4'):
            stem = stem.replace(ext, '')
        return datetime.strptime(stem, '%Y-%m-%d_%H-%M-%S')
    except ValueError:
        return None

def is_recording_file(filename):
    return filename.endswith('.ts') or filename.endswith('.mp4')

def get_recordings_for_date(cam_path, date_str):
    """Return sorted list of (filename, start_dt) for a given YYYY-MM-DD date."""
    results = []
    if not os.path.exists(cam_path):
        return results
    for f in os.listdir(cam_path):
        if not is_recording_file(f):
            continue
        dt = parse_filename_dt(f)
        if dt and dt.strftime('%Y-%m-%d') == date_str:
            results.append((f, dt))
    results.sort(key=lambda x: x[1])
    return results

@app.route('/api/recordings', methods=['GET'])
@requires_auth
def list_recording_cameras():
    cfg = load_config()
    storage_path = cfg.get("storage_path", "/recordings")
    cameras = []
    if os.path.exists(storage_path):
        for name in sorted(os.listdir(storage_path)):
            cam_path = os.path.join(storage_path, name)
            if os.path.isdir(cam_path):
                files = [f for f in os.listdir(cam_path) if is_recording_file(f)]
                size = sum(
                    os.path.getsize(os.path.join(cam_path, f))
                    for f in files
                    if os.path.exists(os.path.join(cam_path, f))
                )
                cameras.append({'name': name, 'count': len(files), 'size': size})
    return jsonify(cameras), 200

@app.route('/api/recordings/<camera>', methods=['GET'])
@requires_auth
def list_recordings(camera):
    camera = os.path.basename(camera)
    cfg = load_config()
    storage_path = cfg.get("storage_path", "/recordings")
    cam_path = os.path.join(storage_path, camera)
    if not os.path.exists(cam_path):
        return jsonify([]), 200
    files = []
    for f in sorted(os.listdir(cam_path), reverse=True):
        if is_recording_file(f):
            fp = os.path.join(cam_path, f)
            try:
                size = os.path.getsize(fp)
                mtime = os.path.getmtime(fp)
                files.append({
                    'filename': f,
                    'size': size,
                    'mtime': mtime,
                    'date': datetime.fromtimestamp(mtime).strftime('%Y-%m-%d')
                })
            except OSError:
                pass
    return jsonify(files), 200

@app.route('/api/recordings/<camera>/<filename>', methods=['GET'])
@requires_auth
def serve_recording(camera, filename):
    import tempfile
    from flask import after_this_request
    camera = os.path.basename(camera)
    filename = os.path.basename(filename)
    if not is_recording_file(filename):
        return jsonify({'error': 'Invalid filename'}), 400
    cfg = load_config()
    storage_path = cfg.get("storage_path", "/recordings")
    src = os.path.join(storage_path, camera, filename)
    if not os.path.exists(src):
        return jsonify({'error': 'Not found'}), 404

    # Remux to MP4 with faststart so the browser can seek immediately.
    # TS files need this unconditionally; MP4 files may already be valid.
    tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False, dir='/tmp')
    tmp.close()
    try:
        result = subprocess.run(
            ['ffmpeg', '-nostdin', '-y', '-i', src,
             '-c', 'copy', '-movflags', '+faststart', tmp.name],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.decode()[-200:] if result.stderr else 'ffmpeg failed')

        @after_this_request
        def cleanup(response):
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
            return response

        download_name = filename.replace('.ts', '.mp4')
        return send_from_directory('/tmp', os.path.basename(tmp.name),
                                   mimetype='video/mp4', conditional=True,
                                   download_name=download_name)
    except Exception as e:
        logger.error(f'serve_recording remux failed for {filename}: {e}')
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        return jsonify({'error': 'Could not process recording'}), 500

@app.route('/api/recordings/<camera>', methods=['DELETE'])
@requires_auth
def delete_camera_recordings(camera):
    """Delete all recordings for a camera (the entire folder)."""
    import shutil
    camera = os.path.basename(camera)
    cfg = load_config()
    storage_path = cfg.get("storage_path", "/recordings")
    cam_path = os.path.join(storage_path, camera)
    if not os.path.exists(cam_path):
        return jsonify({'error': 'Not found'}), 404
    try:
        shutil.rmtree(cam_path)
        return jsonify({'message': f'Deleted all recordings for {camera}'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/recordings/<camera>/<filename>', methods=['DELETE'])
@requires_auth
def delete_recording(camera, filename):
    """Delete a single recording file."""
    camera = os.path.basename(camera)
    filename = os.path.basename(filename)
    if not is_recording_file(filename):
        return jsonify({'error': 'Invalid filename'}), 400
    cfg = load_config()
    storage_path = cfg.get("storage_path", "/recordings")
    filepath = os.path.join(storage_path, camera, filename)
    if not os.path.exists(filepath):
        return jsonify({'error': 'Not found'}), 404
    try:
        os.remove(filepath)
        return jsonify({'message': 'Deleted'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/recordings/<camera>/days', methods=['GET'])
@requires_auth
def list_recording_days(camera):
    """Return a list of dates that have recordings for this camera."""
    camera = os.path.basename(camera)
    cfg = load_config()
    storage_path = cfg.get("storage_path", "/recordings")
    cam_path = os.path.join(storage_path, camera)
    if not os.path.exists(cam_path):
        return jsonify([]), 200
    days = set()
    for f in os.listdir(cam_path):
        if is_recording_file(f):
            dt = parse_filename_dt(f)
            if dt:
                days.add(dt.strftime('%Y-%m-%d'))
    return jsonify(sorted(days, reverse=True)), 200

@app.route('/api/recordings/<camera>/timeline', methods=['GET'])
@requires_auth
def recordings_timeline(camera):
    """
    Return timeline metadata for a camera on a given date.
    Query param: ?date=YYYY-MM-DD
    Returns list of segments: {filename, start_sec, end_sec, start_ts, size}
    where start_sec / end_sec are seconds since midnight.
    """
    camera = os.path.basename(camera)
    date_str = request.args.get('date')
    if not date_str:
        return jsonify({'error': 'date parameter required'}), 400
    try:
        datetime.strptime(date_str, '%Y-%m-%d')
    except ValueError:
        return jsonify({'error': 'Invalid date format, expected YYYY-MM-DD'}), 400

    cfg = load_config()
    storage_path = cfg.get("storage_path", "/recordings")
    segment_time = cfg.get("segment_time", 3600)
    cam_path = os.path.join(storage_path, camera)

    recordings = get_recordings_for_date(cam_path, date_str)
    segments = []
    for filename, start_dt in recordings:
        fp = os.path.join(cam_path, filename)
        try:
            size = os.path.getsize(fp)
        except OSError:
            size = 0
        start_sec = start_dt.hour * 3600 + start_dt.minute * 60 + start_dt.second

        # Use ffprobe to get the real duration of this file
        duration = segment_time
        try:
            probe = subprocess.run(
                ['ffprobe', '-v', 'quiet', '-print_format', 'json',
                 '-show_format', fp],
                capture_output=True, text=True, timeout=5
            )
            info = json.loads(probe.stdout)
            duration = float(info['format']['duration'])
        except Exception:
            pass

        end_sec = min(start_sec + duration, 86400)
        segments.append({
            'filename': filename,
            'start_sec': start_sec,
            'end_sec': end_sec,
            'duration': duration,
            'start_ts': start_dt.strftime('%H:%M:%S'),
            'size': size,
        })
    return jsonify(segments), 200


# Proxy go2rtc static assets through Flask (same origin) to avoid CORS blocks
@app.route('/go2rtc-proxy/<path:asset_path>')
def go2rtc_asset_proxy(asset_path):
    go2rtc_host = os.environ.get("GO2RTC_HOST", "go2rtc")
    try:
        qs = request.query_string.decode('utf-8')
        url = f"http://{go2rtc_host}:1984/{asset_path}"
        if qs:
            url += '?' + qs
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            content = resp.read()
            content_type = resp.headers.get('Content-Type', 'application/octet-stream')
        return Response(content, content_type=content_type)
    except Exception as e:
        logger.error(f"go2rtc asset proxy error: {e}")
        return f"Proxy error: {e}", 502

# Muted player proxy
@app.route('/player')
def muted_player():
    src = request.args.get('src', '')
    go2rtc_host = os.environ.get("GO2RTC_HOST", "go2rtc")
    try:
        url = f"http://{go2rtc_host}:1984/stream.html?src={src}&mode=webrtc"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            html = resp.read().decode('utf-8')
        mute_script = """
<script>
function forceMute() {
    document.querySelectorAll('video').forEach(v => { v.muted = true; v.volume = 0; });
}
forceMute();
setInterval(forceMute, 500);
new MutationObserver(forceMute).observe(document.body, {childList: true, subtree: true});
</script>
"""
        # Scripts load via same-origin Flask proxy (avoids CORS).
        # WebSocket URL is built with new URL('api/ws?...', location.href) in go2rtc's JS,
        # so replace location.href with the public go2rtc URL — WebSocket ignores CORS.
        public_host = request.host.split(':')[0]
        go2rtc_public = f"http://{public_host}:1984"
        html = html.replace('<head>', '<head>\n    <base href="/go2rtc-proxy/">', 1)
        html = html.replace('location.href', f'"{go2rtc_public}/"')
        html = html.replace('</body>', mute_script + '</body>')
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
    logger.info("Initializing NVR backend...")

    config_dir = os.path.dirname(DB_PATH)
    if config_dir:
        os.makedirs(config_dir, exist_ok=True)

    init_db()
    migrate_from_json()

    cfg = load_config()
    os.makedirs(cfg.get("storage_path", "/recordings"), exist_ok=True)

    cleanup_thread = threading.Thread(
        target=cleanup_loop,
        args=(cfg.get("storage_path", "/recordings"),),
        daemon=True
    )
    cleanup_thread.start()

    watchdog_thread = threading.Thread(target=watchdog_loop, daemon=True)
    watchdog_thread.start()

    sync_workers()
    app.run(host='0.0.0.0', port=5000, threaded=True)
