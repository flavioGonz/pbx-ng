#!/usr/bin/env python3
import os, subprocess, re, json, time, os, base64, threading
import psycopg2
DB = dict(host='172.26.20.184', dbname='pbxng', user='pbxng', password='__SET_DB_PASS__', client_encoding='UTF8')
CFG = '/etc/kamailio/kamailio.cfg'
ENVC = dict(os.environ, LC_ALL='C', LANG='C')

def kc(*a):
    try: return subprocess.run(['kamcmd', *a], capture_output=True, text=True, timeout=6, env=ENVC).stdout
    except Exception: return ''

def rctl(*a):
    try: return subprocess.run(['rtpengine-ctl', *a], capture_output=True, text=True, timeout=6, env=ENVC).stdout
    except Exception: return ''

def stats_group(g):
    out = {}
    for line in kc('stats.get_statistics', g + ':').splitlines():
        m = re.match(r'\s*' + re.escape(g) + r':(\S+)\s*=\s*(\d+)', line)
        if m: out[m.group(1)] = int(m.group(2))
    return out

def dispatcher():
    dl = kc('dispatcher.list'); disp = []; cur = None
    for line in dl.splitlines():
        s = line.strip()
        mu = re.search(r'URI:\s*(\S+)', s)
        mf = re.search(r'FLAGS:\s*(\S+)', s)
        mp = re.search(r'PRIORITY:\s*(\d+)', s)
        ml = re.search(r'LATENCY:\s*(\S+)', s) or re.search(r'(?:RTT|rtt):\s*([\d.]+)', s)
        if mu: cur = {'uri': mu.group(1), 'flags': '', 'priority': 0, 'latency': None}; disp.append(cur)
        elif cur is not None:
            if mf: cur['flags'] = mf.group(1)
            if mp: cur['priority'] = int(mp.group(1))
            if ml:
                try: cur['latency'] = float(ml.group(1))
                except Exception: pass
    return disp

def pike_list():
    out = kc('pike.list'); ips = re.findall(r'(\d+\.\d+\.\d+\.\d+)', out)
    return sorted(set(ips))

def rtpe():
    out = kc('rtpengine.show', 'all')
    up = ('disabled: 0' in out)
    t = rctl('list', 'totals')
    def g(rx):
        m = re.search(rx, t, re.I); return int(m.group(1)) if m else None
    sess = g(r'Total sessions\s*:\s*(\d+)')
    if sess is None:
        n = rctl('list', 'numsessions'); m = re.search(r'total[:\s]+(\d+)', n, re.I) or re.search(r'(\d+)', n); sess = int(m.group(1)) if m else 0
    return {
        'up': bool(up),
        'sessions': sess or 0,
        'foreign': g(r'Foreign sessions\s*:\s*(\d+)') or 0,
        'transcoded': g(r'Transcoded media\s*:\s*(\d+)') or 0,
        'pps': g(r'Packets per second \(userspace\)\s*:\s*(\d+)') or 0,
        'bps': g(r'Bytes per second \(userspace\)\s*:\s*(\d+)') or 0,
        'errps': g(r'Errors per second \(userspace\)\s*:\s*(\d+)') or 0,
    }

def version():
    v = kc('core.version'); m = re.search(r'(kamailio\s+[\d.]+)', v); return m.group(1) if m else 'kamailio'

PREV = {}
def rates(core):
    now = time.time(); out = {}
    for k in ('rcv_requests', 'fwd_requests', 'rcv_replies', 'fwd_replies', 'drop_requests', 'err_requests'):
        v = core.get(k)
        if v is None: continue
        p = PREV.get(k)
        if p and now > p[1]:
            out[k] = max(0, round((v - p[0]) / (now - p[1]), 2))
        PREV[k] = (v, now)
    return out

def net_info():
    out = {"ifaces": [], "routes": []}
    try:
        a = subprocess.run(["ip", "-br", "addr"], capture_output=True, text=True, timeout=6).stdout
        for line in a.splitlines():
            q = line.split()
            if not q or q[0] == "lo":
                continue
            out["ifaces"].append({"name": q[0], "state": (q[1] if len(q) > 1 else ""), "addrs": q[2:]})
    except Exception:
        pass
    try:
        r = subprocess.run(["ip", "route", "show"], capture_output=True, text=True, timeout=6).stdout
        out["routes"] = [l.strip() for l in r.splitlines() if l.strip()]
    except Exception:
        pass
    return out


def gather():
    up = kc('core.uptime'); m = re.search(r'uptime:\s*(.+)', up); uptime = m.group(1).strip() if m else None
    core = stats_group('core'); sl = stats_group('sl'); tcp = stats_group('tcp'); shm = stats_group('shmem')
    disp = dispatcher(); pike = pike_list()
    hb = kc('htable.dump', 'ipban'); banned = sorted(set(re.findall(r'(?:name|key):\s*(\d+\.\d+\.\d+\.\d+)', hb)))
    stats = {
        'core': core, 'sl': sl, 'tcp': tcp, 'shmem': shm,
        'rates': rates(core),
        'tcp_open': tcp.get('current_opened_connections', 0),
        'pike': pike, 'pike_count': len(pike),
        'net': net_info(),
    }
    try: cfg = open(CFG).read()
    except Exception: cfg = ''
    return uptime, disp, banned, stats, cfg

def apply_cmd(cmd, arg):
    res = 'ok'
    try:
        if cmd == 'reload': kc('dispatcher.reload')
        elif cmd == 'unban_all': kc('htable.reset', 'ipban')
        elif cmd == 'unban' and arg: kc('htable.delete', 'ipban', arg)
        elif cmd == 'ban' and arg: kc('htable.seti', 'ipban', arg, '1')
        elif cmd == 'debug' and arg: kc('cfg.seti', 'core', 'debug', str(int(arg)))
        elif cmd == 'disable_target' and arg: kc('dispatcher.set_state', 'i', '1', arg)
        elif cmd == 'enable_target' and arg: kc('dispatcher.set_state', 'a', '1', arg)
        elif cmd == 'add_target' and arg:
            dlp = '/etc/kamailio/dispatcher.list'
            uri = arg if arg.startswith('sip:') else ('sip:' + arg)
            lines = open(dlp).read().splitlines() if os.path.exists(dlp) else []
            exists = any((uri in l) for l in lines)
            if not exists:
                try: open(dlp + '.bak', 'w').write('\n'.join(lines) + '\n')
                except Exception: pass
                with open(dlp, 'a') as f: f.write('1 ' + uri + ' 0 0\n')
            kc('dispatcher.reload')
        elif cmd == 'del_target' and arg:
            dlp = '/etc/kamailio/dispatcher.list'
            uri = arg if arg.startswith('sip:') else ('sip:' + arg)
            if os.path.exists(dlp):
                lines = [l for l in open(dlp).read().splitlines() if uri not in l]
                try: open(dlp + '.bak', 'w').write(open(dlp).read())
                except Exception: pass
                open(dlp, 'w').write('\n'.join(lines) + '\n')
            kc('dispatcher.reload')
        elif cmd == 'route_add' and arg:
            parts = (arg.split('|') + ['', '', ''])[:3]
            dest, gw, dev = parts[0].strip(), parts[1].strip(), parts[2].strip()
            cv = ['ip', 'route', 'replace', dest] + (['via', gw] if gw else []) + (['dev', dev] if dev else [])
            rr = subprocess.run(cv, capture_output=True, text=True, timeout=10)
            res = 'ruta aplicada' if rr.returncode == 0 else ('error: ' + (rr.stderr or '')[-200:])
        elif cmd == 'route_del' and arg:
            rr = subprocess.run(['ip', 'route', 'del'] + arg.strip().split(), capture_output=True, text=True, timeout=10)
            res = 'ruta quitada' if rr.returncode == 0 else ('error: ' + (rr.stderr or '')[-200:])
        elif cmd == 'restart': subprocess.run(['systemctl', 'restart', 'kamailio'], timeout=30)
        elif cmd == 'cfg_save' and arg:
            content = base64.b64decode(arg).decode('utf-8', 'replace')
            tmp = '/tmp/kam_new.cfg'; open(tmp, 'w').write(content)
            v = subprocess.run(['kamailio', '-c', '-f', tmp], capture_output=True, text=True, timeout=20)
            if v.returncode != 0:
                res = 'INVALIDO: ' + (v.stderr or v.stdout)[-400:]
            else:
                subprocess.run(['cp', CFG, CFG + '.bak'], timeout=10)
                open(CFG, 'w').write(content)
                r = subprocess.run(['systemctl', 'restart', 'kamailio'], capture_output=True, text=True, timeout=30)
                res = 'aplicado y reiniciado' if r.returncode == 0 else ('restart fallo: ' + r.stderr[-300:])
        else: res = 'cmd desconocido'
    except Exception as e:
        res = 'error: ' + str(e)
    return res[:600]

def _parse_sip_msg(txt):
    lines = txt.replace('\r\n', '\n').split('\n')
    if not lines:
        return None
    first = lines[0].strip()
    method = status = ruri = None
    if first.startswith('SIP/2.0'):
        pr = first.split(None, 2)
        if len(pr) >= 2 and pr[1].isdigit():
            status = int(pr[1])
        else:
            return None
    else:
        pr = first.split(None, 2)
        if len(pr) < 2 or not pr[1].startswith(('sip:', 'sips:', 'tel:')):
            return None
        method = pr[0]; ruri = pr[1]
    hdr = {}
    for ln in lines[1:]:
        if ln.strip() == '':
            break
        if ':' in ln:
            k, v = ln.split(':', 1); k = k.strip().lower()
            if k not in hdr:
                hdr[k] = v.strip()
    return dict(method=method, status=status, ruri=ruri,
                callid=hdr.get('call-id') or hdr.get('i'), cseq=hdr.get('cseq'),
                from_uri=hdr.get('from') or hdr.get('f'), to_uri=hdr.get('to') or hdr.get('t'))

SIP_TOKENS = ('INVITE ', 'REGISTER ', 'OPTIONS ', 'BYE ', 'CANCEL ', 'ACK ', 'SUBSCRIBE ',
              'NOTIFY ', 'INFO ', 'PRACK ', 'UPDATE ', 'MESSAGE ', 'REFER ', 'PUBLISH ', 'SIP/2.0')

def sip_capture_loop():
    while True:
        try:
            conn = psycopg2.connect(**DB); conn.autocommit = True; cur = conn.cursor()
            cur.execute("CREATE TABLE IF NOT EXISTS pbxng_sip_capture (id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), host text, src text, dst text, method text, status int, callid text, cseq text, from_uri text, to_uri text, ruri text, raw text)")
            cur.execute("CREATE TABLE IF NOT EXISTS pbxng_settings (key text PRIMARY KEY, value text)")
            proc = subprocess.Popen(['tcpdump', '-i', 'any', '-n', '-A', '-s', '0', '-l', 'udp', 'port', '5060'],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=1, universal_newlines=True)
            hdr_re = re.compile(r'IP6?\s+(\S+?)\.(\d+)\s+>\s+(\S+?)\.(\d+):')
            state = {'src': None, 'dst': None, 'buf': [], 'n': 0, 'enabled': True, 'last': 0.0}

            def flush():
                if state['src'] and state['buf']:
                    raw = '\n'.join(state['buf'])
                    idx = -1
                    for tok in SIP_TOKENS:
                        j = raw.find(tok)
                        if j != -1 and (idx == -1 or j < idx):
                            idx = j
                    if idx != -1:
                        sip = _parse_sip_msg(raw[idx:])
                        if sip:
                            try:
                                cur.execute("INSERT INTO pbxng_sip_capture (host,src,dst,method,status,callid,cseq,from_uri,to_uri,ruri,raw) VALUES ('sbc',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                                            (state['src'], state['dst'], sip['method'], sip['status'], sip['callid'], sip['cseq'], sip['from_uri'], sip['to_uri'], sip['ruri'], raw[idx:][:4000]))
                                state['n'] += 1
                                if state['n'] % 50 == 0:
                                    cur.execute("DELETE FROM pbxng_sip_capture WHERE id < (SELECT COALESCE(MAX(id),0)-4000 FROM pbxng_sip_capture)")
                            except Exception:
                                pass
                state['buf'] = []

            for line in proc.stdout:
                line = line.rstrip('\n')
                m = hdr_re.search(line)
                if m:
                    now = time.time()
                    if now - state['last'] > 4:
                        state['last'] = now
                        try:
                            cur.execute("SELECT value FROM pbxng_settings WHERE key='sip_capture_on'")
                            r = cur.fetchone(); state['enabled'] = (r is None or r[0] != '0')
                        except Exception:
                            pass
                    flush()
                    if state['enabled']:
                        state['src'] = m.group(1) + ':' + m.group(2)
                        state['dst'] = m.group(3) + ':' + m.group(4)
                    else:
                        state['src'] = state['dst'] = None
                else:
                    if state['src'] is not None:
                        state['buf'].append(line)
            proc.wait()
        except Exception as e:
            print('sipcap err', e, flush=True)
        time.sleep(5)

def main():
    try:
        c = psycopg2.connect(**DB); cu = c.cursor()
        cu.execute("ALTER TABLE pbxng_sbc ADD COLUMN IF NOT EXISTS rtpengine jsonb DEFAULT '{}'")
        cu.execute("ALTER TABLE pbxng_sbc ADD COLUMN IF NOT EXISTS stats jsonb DEFAULT '{}'")
        cu.execute("ALTER TABLE pbxng_sbc ADD COLUMN IF NOT EXISTS cfg_content text")
        cu.execute("ALTER TABLE pbxng_sbc ADD COLUMN IF NOT EXISTS version text")
        cu.execute("ALTER TABLE pbxng_sbc_cmd ADD COLUMN IF NOT EXISTS arg text")
        cu.execute("ALTER TABLE pbxng_sbc_cmd ADD COLUMN IF NOT EXISTS result text")
        cu.execute("CREATE TABLE IF NOT EXISTS pbxng_sbc_routes (id serial PRIMARY KEY, dest text, gw text, dev text, note text, created_at timestamptz DEFAULT now())")
        cu.execute("CREATE TABLE IF NOT EXISTS pbxng_sip_capture (id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), host text, src text, dst text, method text, status int, callid text, cseq text, from_uri text, to_uri text, ruri text, raw text)")
        cu.execute("CREATE TABLE IF NOT EXISTS pbxng_settings (key text PRIMARY KEY, value text)")
        c.commit(); cu.close(); c.close()
    except Exception as e:
        print('alter err', e, flush=True)
    threading.Thread(target=sip_capture_loop, daemon=True).start()
    ver = version()
    while True:
        try:
            uptime, disp, banned, stats, cfg = gather()
            rt = rtpe()
            conn = psycopg2.connect(**DB); cur = conn.cursor()
            cur.execute("UPDATE pbxng_sbc SET uptime=%s, dispatcher=%s, banned=%s, rtpengine=%s, stats=%s, cfg_content=%s, version=%s, updated_at=now() WHERE id=1",
                        (uptime, json.dumps(disp), json.dumps(banned), json.dumps(rt), json.dumps(stats), cfg, ver))
            cur.execute("SELECT id, cmd, arg FROM pbxng_sbc_cmd WHERE done=false ORDER BY id")
            rows = cur.fetchall()
            conn.commit()
            for cid, cmd, arg in rows:
                res = apply_cmd(cmd, arg)
                cur.execute("UPDATE pbxng_sbc_cmd SET done=true, result=%s WHERE id=%s", (res, cid))
                conn.commit()
            try:
                cur.execute("SELECT dest, COALESCE(gw,''), COALESCE(dev,'') FROM pbxng_sbc_routes")
                for dest, gw, dev in cur.fetchall():
                    cv = ['ip', 'route', 'replace', dest] + (['via', gw] if gw else []) + (['dev', dev] if dev else [])
                    subprocess.run(cv, capture_output=True, timeout=8)
                conn.commit()
            except Exception:
                conn.rollback()
            cur.close(); conn.close()
        except Exception as e:
            print('agent error:', e, flush=True)
        time.sleep(6)

if __name__ == '__main__':
    main()
