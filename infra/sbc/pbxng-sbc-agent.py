#!/usr/bin/env python3
import os, subprocess, re, json, time, os, base64
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

def main():
    try:
        c = psycopg2.connect(**DB); cu = c.cursor()
        cu.execute("ALTER TABLE pbxng_sbc ADD COLUMN IF NOT EXISTS rtpengine jsonb DEFAULT '{}'")
        cu.execute("ALTER TABLE pbxng_sbc ADD COLUMN IF NOT EXISTS stats jsonb DEFAULT '{}'")
        cu.execute("ALTER TABLE pbxng_sbc ADD COLUMN IF NOT EXISTS cfg_content text")
        cu.execute("ALTER TABLE pbxng_sbc ADD COLUMN IF NOT EXISTS version text")
        cu.execute("ALTER TABLE pbxng_sbc_cmd ADD COLUMN IF NOT EXISTS arg text")
        cu.execute("ALTER TABLE pbxng_sbc_cmd ADD COLUMN IF NOT EXISTS result text")
        c.commit(); cu.close(); c.close()
    except Exception as e:
        print('alter err', e, flush=True)
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
            cur.close(); conn.close()
        except Exception as e:
            print('agent error:', e, flush=True)
        time.sleep(6)

if __name__ == '__main__':
    main()
