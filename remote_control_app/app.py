import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, request, jsonify, session, redirect, url_for, Response
import requests
import secrets
from flask_socketio import SocketIO, emit
import paramiko
import threading
import time

app = Flask(__name__)
app.secret_key = 'jetracer_secure_static_session_key'
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0  # disable static file caching during development

socketio = SocketIO(app, cors_allowed_origins="*")

# Persistent session for HTTP Keep-Alive – drastically reduces per-command latency
http_session = requests.Session()

# ── Auth ───────────────────────────────────────────────────────────────────────

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        ip_address = request.form.get('ip_address')
        if ip_address:
            session['ip_address'] = ip_address
            return redirect(url_for('index'))
    return render_template('login.html')

@app.route('/')
def index():
    if 'ip_address' not in session:
        return redirect(url_for('login'))
    return render_template('index.html', ip_address=session['ip_address'])

# ── Video stream proxy ─────────────────────────────────────────────────────────

@app.route('/video_feed')
def video_feed():
    target_ip = session.get('ip_address')
    if not target_ip:
        return "No JetRacer IP connected", 404

    stream_url = f"http://{target_ip}:5000/video_feed"
    try:
        req = http_session.get(stream_url, stream=True, timeout=(5, None))

        def generate(r):
            try:
                for chunk in r.iter_content(chunk_size=4096):
                    yield chunk
            finally:
                r.close()

        return Response(generate(req),
                        content_type=req.headers.get('Content-Type',
                                                     'multipart/x-mixed-replace; boundary=frame'))
    except Exception as e:
        return f"Stream not reachable at {stream_url}. Error: {e}", 404
# ── Command proxy ──────────────────────────────────────────────────────────────

@app.route('/command', methods=['POST'])
def command():
    if 'ip_address' not in session:
        return jsonify({"status": "error", "message": "Not connected to any JetRacer."}), 401

    cmd       = request.form.get('cmd')
    target_ip = session['ip_address']

    try:
        resp = http_session.post(
            f"http://{target_ip}:5000/command",
            data={"cmd": cmd},
            timeout=1
        )
        print(f"[JETRACER_LINK] Command Forwarded: {cmd}")
        result = {"status": "ok", "command": cmd, "forwarded_to": target_ip}
    except Exception as e:
        print(f"[ERROR] Could not reach JetRacer: {e}")
        result = {"status": "error", "message": f"Connection to {target_ip} failed."}

    return jsonify(result)

# ── Telemetry proxy (used by HUD to show real stats) ──────────────────────────

@app.route('/status')
def status():
    target_ip = session.get('ip_address')
    if not target_ip:
        return jsonify({"status": "disconnected"}), 401
    try:
        resp = http_session.get(f"http://{target_ip}:5000/status", timeout=2)
        return Response(resp.content, content_type='application/json')
    except Exception as e:
        return jsonify({"status": "disconnected", "error": str(e)})

# ── Direct drive endpoint (for AI loop or high-frequency joystick) ─────────────

@app.route('/drive', methods=['POST'])
def drive():
    target_ip = session.get('ip_address')
    if not target_ip:
        return jsonify({"status": "error"}), 401
    try:
        http_session.post(
            f"http://{target_ip}:5000/drive",
            data=request.form,
            timeout=0.5
        )
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

# ── Ping ───────────────────────────────────────────────────────────────────────

@app.route('/ping_jetracer')
def ping_jetracer():
    target_ip = session.get('ip_address')
    if not target_ip:
        return jsonify({"reachable": False}), 401
    try:
        r = http_session.get(f"http://{target_ip}:5000/ping", timeout=1)
        return jsonify({"reachable": True, "response": r.json()})
    except Exception as e:
        return jsonify({"reachable": False, "error": str(e)})

# ── Camera control proxy ───────────────────────────────────────────────────────

@app.route('/camera/status')
def camera_status():
    target_ip = session.get('ip_address')
    if not target_ip:
        return jsonify({"camera_running": False}), 401
    try:
        r = http_session.get(f"http://{target_ip}:5000/camera/status", timeout=2)
        return Response(r.content, content_type='application/json')
    except Exception as e:
        return jsonify({"camera_running": False, "error": str(e)})

@app.route('/camera/stop', methods=['POST'])
def camera_stop():
    target_ip = session.get('ip_address')
    if not target_ip:
        return jsonify({"status": "error"}), 401
    try:
        r = http_session.post(f"http://{target_ip}:5000/camera/stop", timeout=3)
        return Response(r.content, content_type='application/json')
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

@app.route('/camera/start', methods=['POST'])
def camera_start():
    target_ip = session.get('ip_address')
    if not target_ip:
        return jsonify({"status": "error"}), 401
    try:
        r = http_session.post(f"http://{target_ip}:5000/camera/start", timeout=3)
        return Response(r.content, content_type='application/json')
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

# ── Logs proxy ─────────────────────────────────────────────────────────────────

@app.route('/logs')
def get_logs():
    target_ip = session.get('ip_address')
    if not target_ip:
        return jsonify({"total": 0, "entries": []}), 401
    since = request.args.get('since', '0')
    try:
        r = http_session.get(f"http://{target_ip}:5000/logs?since={since}", timeout=3)
        return Response(r.content, content_type='application/json')
    except Exception as e:
        return jsonify({"total": 0, "entries": [], "error": str(e)})

# ── WiFi proxy ─────────────────────────────────────────────────────────────────

def _wifi_proxy(path, method='GET', json_body=None):
    target_ip = session.get('ip_address')
    if not target_ip:
        return jsonify({"error": "not logged in"}), 401
    url = f"http://{target_ip}:5000/wifi/{path}"
    try:
        if method == 'POST':
            r = http_session.post(url, json=json_body, timeout=35)
        else:
            r = http_session.get(url, params=request.args, timeout=15)
        return Response(r.content, content_type='application/json')
    except Exception as e:
        return jsonify({"error": str(e)}), 502

@app.route('/wifi/networks')
def wifi_networks_proxy():
    return _wifi_proxy('networks')

@app.route('/wifi/status')
def wifi_status_proxy():
    return _wifi_proxy('status')

@app.route('/wifi/rescan', methods=['POST'])
def wifi_rescan_proxy():
    return _wifi_proxy('rescan', method='POST')

@app.route('/wifi/connect', methods=['POST'])
def wifi_connect_proxy():
    return _wifi_proxy('connect', method='POST', json_body=request.get_json(force=True))

# ── Gallery proxy ──────────────────────────────────────────────────────────────

def _gallery_proxy(path, method='GET', stream=False):
    target_ip = session.get('ip_address')
    if not target_ip:
        return jsonify({"error": "not logged in"}), 401
    
    url = f"http://{target_ip}:5000/{path}"
    try:
        if method == 'POST':
            r = http_session.post(url, timeout=5)
        elif method == 'DELETE':
            r = http_session.delete(url, timeout=5)
        else:
            r = http_session.get(url, stream=stream, timeout=5)
        
        if stream:
            return Response(r.iter_content(chunk_size=1024), content_type=r.headers.get('Content-Type'))
        return Response(r.content, content_type=r.headers.get('Content-Type'))
    except Exception as e:
        return jsonify({"error": str(e)}), 502

@app.route('/capture-frame', methods=['POST'])
def capture_frame_proxy():
    return _gallery_proxy('capture-frame', method='POST')

@app.route('/gallery')
def gallery_list_proxy():
    return _gallery_proxy('gallery')

@app.route('/gallery/<filename>')
def gallery_image_proxy(filename):
    return _gallery_proxy(f'gallery/{filename}', stream=True)

@app.route('/gallery/<filename>', methods=['DELETE'])
def gallery_delete_proxy(filename):
    return _gallery_proxy(f'gallery/{filename}', method='DELETE')

# ── Terminal WebSocket ─────────────────────────────────────────────────────────

ssh_sessions = {}

def cleanup_session(sid):
    if sid in ssh_sessions:
        session_data = ssh_sessions.pop(sid)
        session_data['active'] = False
        try:
            session_data['channel'].close()
        except Exception:
            pass
        try:
            session_data['ssh'].close()
        except Exception:
            pass

def ssh_connect_and_loop(sid):
    host = "10.71.71.189"
    username = "jetson"
    password = "jetson"
    
    socketio.emit('status', {'status': 'reconnecting', 'message': 'Connecting to SSH...'}, to=sid, namespace='/terminal')
    
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(host, username=username, password=password, timeout=5)
        
        channel = ssh.invoke_shell(term='xterm')
        channel.settimeout(0.0)
        
        ssh_sessions[sid] = {
            'ssh': ssh,
            'channel': channel,
            'active': True
        }
        
        socketio.emit('status', {'status': 'connected'}, to=sid, namespace='/terminal')
        socketio.emit('log', {'type': 'info', 'message': 'Connection established.'}, to=sid, namespace='/terminal')
        
        while sid in ssh_sessions and ssh_sessions[sid]['active']:
            try:
                if channel.recv_ready():
                    data = channel.recv(4096).decode('utf-8', errors='ignore')
                    if data:
                        socketio.emit('output', {'data': data}, to=sid, namespace='/terminal')
                else:
                    time.sleep(0.02)
            except Exception as e:
                socketio.emit('log', {'type': 'error', 'message': f'Read error: {str(e)}'}, to=sid, namespace='/terminal')
                break
                
            if channel.exit_status_ready():
                socketio.emit('log', {'type': 'info', 'message': 'SSH session terminated by remote host.'}, to=sid, namespace='/terminal')
                break
                
    except Exception as e:
        socketio.emit('status', {'status': 'disconnected', 'message': f'Connection failed: {str(e)}'}, to=sid, namespace='/terminal')
        socketio.emit('log', {'type': 'error', 'message': f'Connection failed: {str(e)}'}, to=sid, namespace='/terminal')
        return

    cleanup_session(sid)
    socketio.emit('status', {'status': 'disconnected'}, to=sid, namespace='/terminal')

@socketio.on('connect', namespace='/terminal')
def on_terminal_connect():
    sid = request.sid
    thread = threading.Thread(target=ssh_connect_and_loop, args=(sid,))
    thread.daemon = True
    thread.start()

@socketio.on('disconnect', namespace='/terminal')
def on_terminal_disconnect():
    sid = request.sid
    cleanup_session(sid)

@socketio.on('input', namespace='/terminal')
def on_terminal_input(data):
    sid = request.sid
    char = data.get('data')
    if sid in ssh_sessions:
        channel = ssh_sessions[sid]['channel']
        try:
            channel.send(char)
        except Exception as e:
            socketio.emit('log', {'type': 'error', 'message': f'Write error: {str(e)}'}, to=sid, namespace='/terminal')

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5001, debug=False)