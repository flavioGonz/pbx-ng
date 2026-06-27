#!/usr/bin/env python3
"""PBX-NG Fail2Ban agent: jails + bans detallados (intentos/tiempo) + whitelist + comandos."""
import subprocess, json, time, re, os, sqlite3

DB = ['psql', '-h', '172.26.20.184', '-U', 'pbxng', '-d', 'pbxng', '-tA']
ENV = dict(os.environ, PGPASSWORD='__SET_DB_PASS__')
F2B_DB = '/var/lib/fail2ban/fail2ban.sqlite3'

def sql(q):
    try: return subprocess.run(DB + ['-c', q], env=ENV, capture_output=True, text=True, timeout=20)
    except Exception as e: print('sql err', e); return None

def f2b(*a):
    try: return subprocess.run(['fail2ban-client', *a], capture_output=True, text=True, timeout=20).stdout
    except Exception as e: print('f2b err', e); return ''

def jails():
    m = re.search(r'Jail list:\s*(.*)', f2b('status'))
    return [j.strip() for j in m.group(1).split(',') if j.strip()] if m else []

def jail_status(j):
    out = f2b('status', j)
    tf = re.search(r'Total failed:\s*(\d+)', out); tb = re.search(r'Currently banned:\s*(\d+)', out)
    ipm = re.search(r'Banned IP list:\s*(.*)', out)
    ips = [x for x in (ipm.group(1).split() if ipm else []) if x]
    return (int(tf.group(1)) if tf else 0, int(tb.group(1)) if tb else 0, ips)

def jail_cfg(j):
    def g(k):
        v = (f2b('get', j, k) or '').strip()
        try: return int(v)
        except Exception: return v
    return {'maxretry': g('maxretry'), 'findtime': g('findtime'), 'bantime': g('bantime')}

def bips(j):
    out = {}
    try:
        db = sqlite3.connect(F2B_DB); db.row_factory = sqlite3.Row
        for r in db.execute("SELECT ip,timeofban,bantime,bancount,data FROM bips WHERE jail=?", (j,)):
            att = 0
            try: att = json.loads(r['data']).get('failures', 0)
            except Exception: pass
            out[r['ip']] = {'ts': r['timeofban'], 'bantime': r['bantime'], 'bancount': r['bancount'], 'attempts': att}
        db.close()
    except Exception as e: print('sqlite err', e)
    return out

def qstr(s): return "'" + str(s).replace("'", "''") + "'"

def whitelist():
    r = sql("SELECT ip FROM pbxng_f2b_whitelist")
    return [l.strip() for l in (r.stdout.strip().splitlines() if r and r.stdout else []) if l.strip()]

while True:
    try:
        js = jails(); wl = whitelist()
        for ip in wl:
            for j in js:
                f2b('set', j, 'addignoreip', ip); f2b('set', j, 'unbanip', ip)
        for j in js:
            tf, tb, ips = jail_status(j)
            detail = bips(j)
            bans = [dict(ip=ip, **detail.get(ip, {})) for ip in ips]
            cfg = jail_cfg(j)
            sql("INSERT INTO pbxng_fail2ban (jail,banned,bans,config,total_failed,total_banned,updated_at) VALUES (%s,%s::jsonb,%s::jsonb,%s::jsonb,%d,%d,now()) ON CONFLICT (jail) DO UPDATE SET banned=EXCLUDED.banned,bans=EXCLUDED.bans,config=EXCLUDED.config,total_failed=EXCLUDED.total_failed,total_banned=EXCLUDED.total_banned,updated_at=now()" % (qstr(j), qstr(json.dumps(ips)), qstr(json.dumps(bans)), qstr(json.dumps(cfg)), tf, tb))
        r = sql("SELECT id,cmd,COALESCE(ip,''),COALESCE(jail,'') FROM pbxng_fail2ban_cmd WHERE done_at IS NULL ORDER BY id")
        if r and r.stdout.strip():
            for line in r.stdout.strip().splitlines():
                pp = line.split('|')
                if len(pp) < 3: continue
                cid, cmd, ip = pp[0], pp[1], pp[2]; jl = pp[3] if len(pp) > 3 else ''
                tgt = [jl] if jl else js
                if cmd == 'ban':
                    for t in tgt: f2b('set', t, 'banip', ip)
                elif cmd == 'wl_del':
                    for t in js: f2b('set', t, 'delignoreip', ip)
                else:  # unban (default)
                    for t in tgt: f2b('set', t, 'unbanip', ip)
                sql("UPDATE pbxng_fail2ban_cmd SET done_at=now() WHERE id=%s" % cid)
    except Exception as e:
        print('loop err', e)
    time.sleep(15)
