import paramiko, json

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('10.71.71.189', username='jetson', password='jetson', timeout=5)

# Upload a small test script
script = '''
import subprocess, json

out = subprocess.run("nmcli -t -f NAME,TYPE,DEVICE connection show --active", shell=True, capture_output=True, text=True).stdout.strip()
print("RAW OUTPUT:", repr(out))
for line in out.splitlines():
    parts = line.split(":")
    print("PARTS:", parts)
    print("LEN:", len(parts))
    if len(parts) >= 3:
        t = parts[1].strip().lower()
        print("TYPE FIELD:", repr(t))
        print("MATCH:", t in ("wifi", "wireless", "802-11-wireless"))
'''

sftp = ssh.open_sftp()
with sftp.file('/tmp/wifi_test.py', 'w') as f:
    f.write(script)
sftp.close()

_, o, e = ssh.exec_command('python3 /tmp/wifi_test.py 2>&1')
print(o.read().decode())
print(e.read().decode())
ssh.close()
