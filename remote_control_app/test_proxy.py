import requests, json

print('=== PROXY Tests (port 5001) ===')
s = requests.Session()
login = s.post('http://127.0.0.1:5001/login', data={'ip_address':'10.71.71.189'}, allow_redirects=False)
print('Login Status:', login.status_code)

r2 = s.get('http://127.0.0.1:5001/wifi/status', timeout=8)
print('/wifi/status:', r2.status_code)
if r2.status_code == 200:
    print(json.dumps(r2.json(), indent=2))
else:
    print(r2.text[:200])

print('\n=== /wifi/networks ===')
r3 = s.get('http://127.0.0.1:5001/wifi/networks', timeout=30)
print('/wifi/networks:', r3.status_code)
if r3.status_code == 200:
    nets = r3.json()
    print(f'Found {len(nets)} networks.')
    for n in nets[:5]:
        print(f"  {n['ssid']} | {n['signal']}% | {n['security']} | Connected: {n['connected']}")
