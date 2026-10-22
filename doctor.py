#!/usr/bin/env python3
"""Read-only deployment status for humans/agents. Never reads config contents."""
import argparse
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import urllib.request
from pathlib import Path

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise OSError('Redirect refused')

def runtime_status():
    # Ignore proxy environment variables: the local control token stays on loopback.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    base = 'http://127.0.0.1:18080'
    with opener.open(base + '/', timeout=3) as r:
        html = r.read(524289).decode('utf-8')
    token = re.search(r"const token='([a-f0-9]{64})'", html)
    if not token:
        raise ValueError('Local token unavailable')
    request = urllib.request.Request(base + '/api/state', headers={'X-Local-Token': token[1]})
    with opener.open(request, timeout=3) as r:
        raw = r.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError('Status exceeds limit')
    return summarize_runtime(json.loads(raw))

def summarize_runtime(s):
    # Deliberately omit appId, pairing code, report, messages, paths and raw errors.
    network = s.get('network', {}).get('state')
    allowed = ('connected', 'connecting', 'reconnecting', 'stopped', 'error')
    return {'reachable': True, 'qq': network if network in allowed else 'unknown',
            'bound': s.get('bound') is True, 'analysisReady': s.get('analysisReady') is True,
            'hasError': bool(s.get('lastError') or s.get('reminderWarning') or s.get('family',{}).get('warning')),
            'sharingEnabled': s.get('family',{}).get('enabled') is True}

def stage(s):
    if not s['supportedOS'] or not s['supportedArch'] or not s['systemd']:
        return 'unsupported_environment'
    if not s['installationExists']:
        return 'review_existing_paths' if s['existingState'] else 'ready_to_install'
    if s['credentials'] == 'needs_sudo':
        return 'rerun_doctor_with_sudo'
    if s['credentials'] != 'root_600':
        return 'needs_credentials_or_permissions'
    runtime = s['runtime']
    if not runtime.get('reachable'):
        return 'needs_service_start_or_diagnosis'
    if runtime.get('qq') != 'connected' or runtime.get('hasError'):
        return 'needs_connection_diagnosis'
    if not runtime.get('bound'):
        return 'needs_human_qq_binding'
    return 'ready_for_message_test'

def inspect():
    release = {}
    if Path('/etc/os-release').exists():
        for line in Path('/etc/os-release').read_text().splitlines():
            if '=' in line:
                key, value = line.split('=', 1)
                release[key] = value.strip('"')
    config = Path('/etc/qq-work-assistant/config.json')
    try:
        info = config.lstat()
        creds = 'root_600' if stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600 else 'unsafe_permissions'
    except FileNotFoundError:
        creds = 'missing'
    except PermissionError:
        creds = 'needs_sudo'
    try:
        runtime = runtime_status()
    except Exception:
        runtime = {'reachable': False}
    s = {'supportedOS': release.get('ID') == 'ubuntu' and release.get('VERSION_ID') == '24.04',
         'supportedArch': platform.machine() in ('x86_64', 'aarch64'),
         'systemd': Path('/run/systemd/system').is_dir() and bool(shutil.which('systemctl')),
         'installationExists': Path('/opt/qq-work-assistant/package.json').is_file(),
         'existingState': any(Path(p).exists() for p in ('/opt/qq-work-assistant', '/etc/qq-work-assistant', '/var/lib/qq-work-assistant')),
         'credentials': creds, 'runtime': runtime,
         'freeDiskGiB': round(shutil.disk_usage('/').free / 1024**3, 1)}
    s['nextStage'] = stage(s)
    return s

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true', help='Machine-readable status only')
    parser.add_argument('--require-ready', action='store_true', help='Exit 2 unless QQ is connected and owner bound')
    args = parser.parse_args()
    result = inspect()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.require_ready and result['nextStage'] != 'ready_for_message_test':
        raise SystemExit(2)
