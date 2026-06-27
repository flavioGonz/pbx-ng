#!/usr/bin/env python3
"""PBX-NG recordings agent (CT Asterisk): registra grabaciones en PostgreSQL,
sube a S3/NAS segun config, sirve los .wav por HTTP (:8089) y purga borrados."""
import os, re, time, wave, threading, shutil, http.server, socketserver
import psycopg2

MON = '/var/spool/asterisk/monitor'
PROMPT_DIR = '/var/lib/asterisk/sounds/custom'
DB = dict(host='172.26.20.184', dbname='pbxng', user='pbxng', password='__SET_DB_PASS__')
PORT = 8089

def conn():
    return psycopg2.connect(**DB)

def wav_duration(path):
    try:
        with wave.open(path, 'rb') as w:
            return int(w.getnframes() / float(w.getframerate() or 8000))
    except Exception:
        return 0

def parse(fn):
    m = re.match(r'pbxng-([^-]+)-(\d+)\.wav$', fn)
    ext = m.group(1) if m else None
    ts = None
    if m:
        try: ts = int(m.group(2)) / 1000.0
        except Exception: ts = None
    return ext, ts

def get_cfg(cur):
    cur.execute("SELECT backend, nas_path, s3_endpoint, s3_region, s3_bucket, s3_key, s3_secret, s3_prefix, auto_upload, retain_local FROM pbxng_rec_config WHERE id=1")
    r = cur.fetchone()
    keys = ['backend','nas_path','s3_endpoint','s3_region','s3_bucket','s3_key','s3_secret','s3_prefix','auto_upload','retain_local']
    return dict(zip(keys, r)) if r else {}

def upload(fn, cfg):
    path = os.path.join(MON, fn)
    if not os.path.exists(path): return None, None
    backend = cfg.get('backend') or 'local'
    if backend == 'nas' and cfg.get('nas_path'):
        try:
            os.makedirs(cfg['nas_path'], exist_ok=True)
            shutil.copy2(path, os.path.join(cfg['nas_path'], fn))
            return 'nas', os.path.join(cfg['nas_path'], fn)
        except Exception as e:
            print('nas err', e, flush=True); return None, None
    if backend == 's3' and cfg.get('s3_bucket') and cfg.get('s3_key'):
        try:
            import boto3
            c = boto3.client('s3', endpoint_url=cfg.get('s3_endpoint') or None,
                             region_name=cfg.get('s3_region') or None,
                             aws_access_key_id=cfg['s3_key'], aws_secret_access_key=cfg.get('s3_secret') or '')
            key = (cfg.get('s3_prefix') or '') + fn
            c.upload_file(path, cfg['s3_bucket'], key, ExtraArgs={'ContentType': 'audio/wav'})
            base = (cfg.get('s3_endpoint') or 'https://s3.' + (cfg.get('s3_region') or 'us-east-1') + '.amazonaws.com').rstrip('/')
            return 's3', base + '/' + cfg['s3_bucket'] + '/' + key
        except Exception as e:
            print('s3 err', e, flush=True); return None, None
    return None, None

def scan():
    try:
        c = conn(); cur = c.cursor()
        cfg = get_cfg(cur)
        files = [f for f in os.listdir(MON) if f.endswith('.wav')] if os.path.isdir(MON) else []
        for fn in files:
            path = os.path.join(MON, fn)
            try: bytes_ = os.path.getsize(path)
            except Exception: continue
            ext, ts = parse(fn)
            cur.execute("SELECT id, storage FROM pbxng_recordings WHERE filename=%s", (fn,))
            row = cur.fetchone()
            if not row:
                dur = wav_duration(path)
                started = None
                cur.execute("INSERT INTO pbxng_recordings (filename, ext, started_at, bytes, duration) VALUES (%s,%s, to_timestamp(%s), %s, %s) ON CONFLICT (filename) DO NOTHING",
                            (fn, ext, ts, bytes_, dur))
                c.commit()
            else:
                cur.execute("UPDATE pbxng_recordings SET bytes=%s WHERE filename=%s", (bytes_, fn)); c.commit()
            # subida si corresponde
            cur.execute("SELECT storage FROM pbxng_recordings WHERE filename=%s", (fn,))
            stg = (cur.fetchone() or ['local'])[0]
            if cfg.get('auto_upload') and cfg.get('backend') in ('s3','nas') and stg == 'local':
                st, url = upload(fn, cfg)
                if st:
                    cur.execute("UPDATE pbxng_recordings SET storage=%s, remote_url=%s WHERE filename=%s", (st, url, fn)); c.commit()
                    if not cfg.get('retain_local'):
                        try: os.remove(path)
                        except Exception: pass
        # purga de borrados
        cur.execute("SELECT id, filename FROM pbxng_recordings WHERE deleted=true")
        for rid, fn in cur.fetchall():
            try:
                p = os.path.join(MON, fn)
                if os.path.exists(p): os.remove(p)
            except Exception: pass
            cur.execute("DELETE FROM pbxng_recordings WHERE id=%s", (rid,)); c.commit()
        cur.close(); c.close()
    except Exception as e:
        print('scan err', e, flush=True)

def sync_prompts():
    try:
        c = conn(); cur = c.cursor()
        cur.execute("SELECT id,name,format,data,deleted FROM pbxng_prompts WHERE synced_at IS NULL OR synced_at < updated_at")
        rows = cur.fetchall()
        if rows: os.makedirs(PROMPT_DIR, exist_ok=True)
        for pid, name, fmt, data, deleted in rows:
            path = os.path.join(PROMPT_DIR, name + '.' + (fmt or 'wav'))
            try:
                if deleted:
                    if os.path.exists(path): os.remove(path)
                    cur.execute("DELETE FROM pbxng_prompts WHERE id=%s", (pid,))
                else:
                    with open(path, 'wb') as f: f.write(bytes(data))
                    cur.execute("UPDATE pbxng_prompts SET synced_at=now() WHERE id=%s", (pid,))
                c.commit()
            except Exception as e:
                print('prompt err', e, flush=True)
        cur.close(); c.close()
    except Exception as e:
        print('sync_prompts err', e, flush=True)

import json, urllib.parse
VM_BASE = '/var/spool/asterisk/voicemail/default'
def _safe(s):
    return re.sub(r'[^A-Za-z0-9_]', '', str(s or ''))
def vm_meta(path):
    d = {}
    try:
        for line in open(path, encoding='utf-8', errors='replace'):
            if '=' in line:
                k, v = line.split('=', 1); d[k.strip()] = v.strip()
    except Exception: pass
    return d
def vm_list(ext):
    ext = _safe(ext); out = []
    for folder in ('INBOX', 'Old'):
        base = os.path.join(VM_BASE, ext, folder)
        if not os.path.isdir(base): continue
        for f in os.listdir(base):
            if not f.endswith('.txt'): continue
            mid = f[:-4]; meta = vm_meta(os.path.join(base, f))
            dur = meta.get('duration', '')
            out.append({'id': mid, 'folder': folder, 'callerid': meta.get('callerid', ''), 'origtime': int(meta.get('origtime') or 0), 'duration': int(dur) if dur.isdigit() else 0, 'new': folder == 'INBOX'})
    out.sort(key=lambda x: x['origtime'], reverse=True)
    return out
def vm_files(ext, folder, mid):
    ext = _safe(ext); folder = _safe(folder) or 'INBOX'; mid = _safe(mid)
    base = os.path.join(VM_BASE, ext, folder)
    return base, mid
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=MON, **k)
    def log_message(self, *a): pass
    def _json(self, obj, code=200):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == '/vm/list':
            return self._json(vm_list(q.get('ext', [''])[0]))
        if u.path == '/vm/audio':
            base, mid = vm_files(q.get('ext', [''])[0], q.get('folder', ['INBOX'])[0], q.get('id', [''])[0])
            for extn in ('wav', 'WAV'):
                p = os.path.join(base, mid + '.' + extn)
                if os.path.exists(p):
                    data = open(p, 'rb').read(); self.send_response(200); self.send_header('Content-Type', 'audio/wav'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data); return
            self.send_response(404); self.end_headers(); return
        return super().do_GET()
    def do_POST(self):
        u = urllib.parse.urlparse(self.path); ln = int(self.headers.get('Content-Length') or 0)
        body = {}
        try: body = json.loads(self.rfile.read(ln) or b'{}')
        except Exception: pass
        if u.path == '/vm/del':
            base, mid = vm_files(body.get('ext'), body.get('folder', 'INBOX'), body.get('id'))
            n = 0
            if mid:
                for f in os.listdir(base) if os.path.isdir(base) else []:
                    if f.startswith(mid + '.'):
                        try: os.remove(os.path.join(base, f)); n += 1
                        except Exception: pass
            return self._json({'ok': True, 'removed': n})
        if u.path == '/vm/read':
            base, mid = vm_files(body.get('ext'), 'INBOX', body.get('id'))
            old = os.path.join(VM_BASE, _safe(body.get('ext')), 'Old')
            try:
                os.makedirs(old, exist_ok=True)
                for f in (os.listdir(base) if os.path.isdir(base) else []):
                    if f.startswith(mid + '.'):
                        shutil.move(os.path.join(base, f), os.path.join(old, f))
            except Exception: pass
            return self._json({'ok': True})
        self.send_response(404); self.end_headers()


def serve():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('0.0.0.0', PORT), Handler) as httpd:
        httpd.serve_forever()

if __name__ == '__main__':
    threading.Thread(target=serve, daemon=True).start()
    while True:
        scan()
        sync_prompts()
        time.sleep(15)
