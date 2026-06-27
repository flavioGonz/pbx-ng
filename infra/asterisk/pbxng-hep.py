#!/usr/bin/env python3
# PBX-NG HEP collector: recibe HEP3 de Asterisk (res_hep_pjsip), parsea SIP y
# vuelca a pbxng_sip_capture. Solo stdlib + psycopg2.
import socket, struct, time, sys
import psycopg2

DB = dict(host='172.26.20.184', dbname='pbxng', user='pbxng', password='__SET_DB_PASS__', client_encoding='UTF8')
LISTEN = ('127.0.0.1', 9060)
HOSTTAG = 'asterisk'
MAXROWS = 4000

DDL = """
CREATE TABLE IF NOT EXISTS pbxng_sip_capture (
  id bigserial PRIMARY KEY,
  ts timestamptz DEFAULT now(),
  host text, src text, dst text,
  method text, status int,
  callid text, cseq text, from_uri text, to_uri text, ruri text,
  raw text
);
CREATE INDEX IF NOT EXISTS pbxng_sip_capture_ts ON pbxng_sip_capture (id DESC);
CREATE INDEX IF NOT EXISTS pbxng_sip_capture_cid ON pbxng_sip_capture (callid);
CREATE TABLE IF NOT EXISTS pbxng_settings (key text PRIMARY KEY, value text);
"""

def parse_sip(payload):
    try:
        txt = payload.decode('utf-8', 'replace') if isinstance(payload, (bytes, bytearray)) else payload
    except Exception:
        return None
    lines = txt.replace('\r\n', '\n').split('\n')
    if not lines:
        return None
    first = lines[0].strip()
    method = status = ruri = None
    if first.startswith('SIP/2.0'):
        p = first.split(None, 2)
        if len(p) >= 2 and p[1].isdigit():
            status = int(p[1])
        else:
            return None
    else:
        p = first.split(None, 2)
        if len(p) < 2 or not p[1].startswith(('sip:', 'sips:', 'tel:')):
            return None
        method = p[0]
        ruri = p[1]
    hdr = {}
    for ln in lines[1:]:
        if ln.strip() == '':
            break
        if ':' in ln:
            k, v = ln.split(':', 1)
            k = k.strip().lower()
            if k not in hdr:
                hdr[k] = v.strip()
    return dict(method=method, status=status, ruri=ruri,
                callid=hdr.get('call-id') or hdr.get('i'),
                cseq=hdr.get('cseq'),
                from_uri=hdr.get('from') or hdr.get('f'),
                to_uri=hdr.get('to') or hdr.get('t'), raw=txt)

def parse_hep3(data):
    if data[:4] != b'HEP3':
        return None
    total = struct.unpack('!H', data[4:6])[0]
    pos = 6
    src = dst = None; sp = dp = None; payload = None
    while pos + 6 <= total:
        vid, tid, ln = struct.unpack('!HHH', data[pos:pos+6])
        body = data[pos+6:pos+ln]
        if tid == 0x0003 and len(body) == 4:
            src = '.'.join(str(b) for b in body)
        elif tid == 0x0004 and len(body) == 4:
            dst = '.'.join(str(b) for b in body)
        elif tid == 0x0007 and len(body) == 2:
            sp = struct.unpack('!H', body)[0]
        elif tid == 0x0008 and len(body) == 2:
            dp = struct.unpack('!H', body)[0]
        elif tid == 0x000f:
            payload = body
        pos += ln
        if ln < 6:
            break
    if payload is None:
        return None
    s = (src + ':' + str(sp)) if src else '?'
    d = (dst + ':' + str(dp)) if dst else '?'
    return s, d, payload

def main():
    conn = psycopg2.connect(**DB); conn.autocommit = True; cur = conn.cursor()
    cur.execute(DDL)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(LISTEN)
    print('HEP collector listening on %s:%d' % LISTEN, flush=True)
    last_flag = time.time(); enabled = True; n = 0
    while True:
        try:
            data, _ = sock.recvfrom(65535)
        except Exception:
            continue
        now = time.time()
        if now - last_flag > 4:
            last_flag = now
            try:
                cur.execute("SELECT value FROM pbxng_settings WHERE key='sip_capture_on'")
                r = cur.fetchone(); enabled = (r is None or r[0] != '0')
            except Exception:
                conn.rollback()
        if not enabled:
            continue
        try:
            hp = parse_hep3(data)
            if not hp:
                continue
            s, d, payload = hp
            sip = parse_sip(payload)
            if not sip:
                continue
            cur.execute(
                "INSERT INTO pbxng_sip_capture (host,src,dst,method,status,callid,cseq,from_uri,to_uri,ruri,raw) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (HOSTTAG, s, d, sip['method'], sip['status'], sip['callid'], sip['cseq'],
                 sip['from_uri'], sip['to_uri'], sip['ruri'], sip['raw'][:4000]))
            n += 1
            if n % 50 == 0:
                cur.execute("DELETE FROM pbxng_sip_capture WHERE id < (SELECT COALESCE(MAX(id),0)-%s FROM pbxng_sip_capture)", (MAXROWS,))
        except Exception as e:
            print('hep err:', e, flush=True)
            try:
                conn.rollback()
            except Exception:
                conn = psycopg2.connect(**DB); conn.autocommit = True; cur = conn.cursor()

if __name__ == '__main__':
    main()
