#!/usr/bin/env python3
"""PBX-NG system-prompts agent (CT Asterisk): despliega audios de pbxng_sysprompts
como overrides de los sonidos de Asterisk (con backup reversible)."""
import os, time, shutil
import psycopg2

DB = dict(host='172.26.20.184', dbname='pbxng', user='pbxng', password='__SET_DB_PASS__')
SND = '/usr/share/asterisk/sounds/es'        # destino real (el symlink es -> aqui)
BAK = '/var/lib/asterisk/sounds/es-orig'      # backup de originales
EXTS = ('wav', 'gsm', 'g722', 'sln', 'ulaw', 'alaw', 'g729', 'siren7', 'siren14')
POLL = 4

def conn():
    return psycopg2.connect(**DB)

def backup_stock(name):
    marker = os.path.join(BAK, name + '.bak')
    if os.path.exists(marker):
        return
    os.makedirs(os.path.join(BAK, os.path.dirname(name)), exist_ok=True)
    for ext in EXTS:
        src = os.path.join(SND, name + '.' + ext)
        if os.path.exists(src) and not os.path.islink(src):
            try:
                shutil.copy2(src, os.path.join(BAK, name + '.' + ext))
            except Exception:
                pass
    with open(marker, 'w') as f:
        f.write('1')

def deploy(name, audio):
    backup_stock(name)
    os.makedirs(os.path.join(SND, os.path.dirname(name)), exist_ok=True)
    with open(os.path.join(SND, name + '.wav'), 'wb') as f:
        f.write(audio)
    # quitar formatos stock que compiten para que Asterisk use mi .wav
    for ext in ('gsm', 'g722', 'sln', 'ulaw', 'alaw', 'g729', 'siren7', 'siren14'):
        p = os.path.join(SND, name + '.' + ext)
        try:
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            pass

def revert(name):
    marker = os.path.join(BAK, name + '.bak')
    # borrar mis archivos
    for ext in EXTS:
        p = os.path.join(SND, name + '.' + ext)
        try:
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            pass
    # restaurar backup si lo hay
    if os.path.exists(marker):
        for ext in EXTS:
            src = os.path.join(BAK, name + '.' + ext)
            if os.path.exists(src):
                try:
                    shutil.copy2(src, os.path.join(SND, name + '.' + ext))
                except Exception:
                    pass

def loop():
    while True:
        try:
            c = conn(); cur = c.cursor()
            cur.execute("SELECT name, audio, revert FROM pbxng_sysprompts "
                        "WHERE (revert=true) OR (audio IS NOT NULL AND "
                        "(deployed_at IS NULL OR updated_at > deployed_at))")
            for name, audio, rev in cur.fetchall():
                try:
                    if rev:
                        revert(name)
                        cur.execute("UPDATE pbxng_sysprompts SET revert=false, deployed_at=now(), "
                                    "status='revertido' WHERE name=%s", (name,))
                    else:
                        deploy(name, bytes(audio))
                        cur.execute("UPDATE pbxng_sysprompts SET deployed_at=now(), "
                                    "status='desplegado' WHERE name=%s", (name,))
                    c.commit()
                except Exception as ex:
                    c.rollback()
                    try:
                        cur.execute("UPDATE pbxng_sysprompts SET status=%s WHERE name=%s",
                                    ('error: ' + str(ex)[:120], name)); c.commit()
                    except Exception:
                        c.rollback()
            cur.close(); c.close()
        except Exception as e:
            print("[prompt-agent]", e, flush=True)
        time.sleep(POLL)

if __name__ == '__main__':
    os.makedirs(BAK, exist_ok=True)
    print("[prompt-agent] iniciado", flush=True)
    loop()
