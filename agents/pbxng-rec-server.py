#!/usr/bin/env python3
# File-server de grabaciones para PBX-NG. Sirve /var/spool/asterisk/monitor por HTTP
# en :8089 (red interna docker). GET /list -> JSON [{filename,bytes,mtime}].
# GET /<archivo.wav> -> el wav. Lo consume el API (VM_AGENT) para reproducir e indexar.
import os, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
DIR = "/var/spool/asterisk/monitor"

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        p = self.path.split('?')[0]
        if p in ('/list', '/rec/list'):
            files = []
            try:
                for f in os.listdir(DIR):
                    if not f.endswith('.wav'):
                        continue
                    st = os.stat(os.path.join(DIR, f))
                    files.append({"filename": f, "bytes": st.st_size, "mtime": int(st.st_mtime)})
            except Exception:
                pass
            b = json.dumps(files).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b); return
        name = os.path.basename(p.lstrip('/'))
        fp = os.path.join(DIR, name)
        if not name or not os.path.isfile(fp):
            self.send_response(404); self.end_headers(); return
        try:
            with open(fp, 'rb') as fh: data = fh.read()
        except Exception:
            self.send_response(500); self.end_headers(); return
        self.send_response(200); self.send_header('Content-Type', 'audio/wav'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

if __name__ == '__main__':
    ThreadingHTTPServer(("0.0.0.0", 8089), H).serve_forever()
