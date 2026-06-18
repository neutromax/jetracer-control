#!/usr/bin/env python3
"""
Deploys jetracer_server.py to the JetRacer and starts it on port 5000.
Usage:  python deploy_to_jetracer.py
"""

import paramiko
import os
import time

JETRACER_IP   = "10.106.155.189"
JETRACER_USER = "jetson"
JETRACER_PASS = "jetson"
REMOTE_PATH   = "/home/jetson/jetracer_server.py"
LOCAL_PATH    = os.path.join(os.path.dirname(__file__), "jetracer_server.py")

def run(ssh, cmd, timeout=30):
    print(f"  $ {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    if out: print(f"    {out}")
    if err: print(f"    ERR: {err}")
    return out, err

def main():
    print("=" * 60)
    print(f"Deploying jetracer_server.py -> {JETRACER_IP}")
    print("=" * 60)

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(JETRACER_IP, username=JETRACER_USER, password=JETRACER_PASS, timeout=10)
    print("[OK] SSH connected")

    # ── Upload server file ─────────────────────────────────────────────────────
    sftp = ssh.open_sftp()
    sftp.put(LOCAL_PATH, REMOTE_PATH)
    sftp.close()
    print(f"[OK] Uploaded {LOCAL_PATH} -> {REMOTE_PATH}")

    # ── Kill any existing server on port 5000 ─────────────────────────────────
    print("\nKilling any existing process on port 5000 ...")
    run(ssh, "fuser -k 5000/tcp 2>/dev/null || true")
    time.sleep(1)

    # ── Install flask (should already be there but just in case) ───────────────
    print("\nEnsuring Flask is installed ...")
    run(ssh, "python3 -c 'import flask' 2>&1 || pip3 install flask --quiet")

    # ── Start the server in the background ────────────────────────────────────
    print("\nStarting jetracer_server.py in background ...")
    start_cmd = (
        "nohup python3 /home/jetson/jetracer_server.py "
        "> /home/jetson/jetracer_server.log 2>&1 &"
    )
    run(ssh, start_cmd)
    time.sleep(3)

    # ── Verify it's listening ─────────────────────────────────────────────────
    print("\nVerifying server is listening on port 5000 ...")
    out, _ = run(ssh, "ss -ltn | grep :5000")
    if ":5000" in out:
        print("\n[OK] SERVER IS UP AND RUNNING ON PORT 5000!")
    else:
        print("\n[WARNING] Port 5000 not yet open, printing server log ...")
        run(ssh, "cat /home/jetson/jetracer_server.log")

    # ── Print last lines of log ────────────────────────────────────────────────
    print("\n--- Recent server log ---")
    run(ssh, "tail -20 /home/jetson/jetracer_server.log")

    ssh.close()
    print("\n[OK] Deploy complete. Connect your browser to http://127.0.0.1:5001")

if __name__ == "__main__":
    main()
