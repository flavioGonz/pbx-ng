#!/usr/bin/env python3
"""
PBX-NG · build-manuals — compila los manuales (Markdown) a HTML profesional.

  docs/manual/*.md  ->  dashboard/public/manuales/*.html

Cada manual sale con portada, índice navegable, estilos de impresión (el navegador lo
exporta a PDF con Ctrl+P) y **marcadores de imagen**: mientras la captura no exista, se ve
un recuadro elegante que dice qué va ahí. Cuando pegás el PNG en la carpeta de imágenes,
aparece solo — no hay que recompilar.

Uso:  python3 scripts/build-manuals.py
"""
import json, os, re, shutil, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, 'docs', 'manual')
OUT  = os.path.join(ROOT, 'dashboard', 'public', 'manuales')

# ------------------------------------------------------------------ markdown mínimo
def inline(t):
    t = t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)', r'<em>\1</em>', t)
    t = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', t)
    return t

def md(text):
    out, i = [], 0
    lines = text.split('\n')
    toc = []
    while i < len(lines):
        ln = lines[i]

        # imagen (marcador si todavía no existe el archivo)
        m = re.match(r'!\[([^\]]*)\]\(([^)]+)\)\s*$', ln)
        if m:
            alt, src = m.group(1), m.group(2)
            fname = src.split('/')[-1]
            out.append(f'<figure class="shot"><img src="{src}" alt="{inline(alt)}" '
                       f'onerror="this.parentNode.classList.add(\'ph\');this.remove();" />'
                       f'<figcaption>{inline(alt)}<span class="fn">{fname}</span></figcaption></figure>')
            i += 1; continue

        # bloque de código
        if ln.startswith('```'):
            i += 1; buf = []
            while i < len(lines) and not lines[i].startswith('```'):
                buf.append(lines[i].replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')); i += 1
            i += 1
            out.append('<pre><code>' + '\n'.join(buf) + '</code></pre>')
            continue

        # cita / nota
        if ln.startswith('> '):
            buf = []
            while i < len(lines) and lines[i].startswith('> '):
                buf.append(lines[i][2:]); i += 1
            out.append('<blockquote>' + ''.join(f'<p>{inline(b)}</p>' for b in buf if b.strip()) + '</blockquote>')
            continue

        # tabla
        if ln.startswith('|') and i + 1 < len(lines) and set(lines[i+1].replace('|', '').strip()) <= set('-: '):
            head = [c.strip() for c in ln.strip('|').split('|')]
            i += 2; body = []
            while i < len(lines) and lines[i].startswith('|'):
                body.append([c.strip() for c in lines[i].strip('|').split('|')]); i += 1
            th = ''.join(f'<th>{inline(c)}</th>' for c in head)
            tr = ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in body)
            out.append(f'<div class="tw"><table><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table></div>')
            continue

        # listas
        if re.match(r'^\s*[-*] ', ln):
            buf = []
            while i < len(lines) and re.match(r'^\s*[-*] ', lines[i]):
                buf.append(re.sub(r'^\s*[-*] ', '', lines[i])); i += 1
            out.append('<ul>' + ''.join(f'<li>{inline(b)}</li>' for b in buf) + '</ul>')
            continue
        if re.match(r'^\s*\d+\. ', ln):
            buf = []
            while i < len(lines) and re.match(r'^\s*\d+\. ', lines[i]):
                buf.append(re.sub(r'^\s*\d+\. ', '', lines[i])); i += 1
            out.append('<ol>' + ''.join(f'<li>{inline(b)}</li>' for b in buf) + '</ol>')
            continue

        # títulos
        m = re.match(r'^(#{1,4}) (.+)$', ln)
        if m:
            lvl, txt = len(m.group(1)), m.group(2)
            slug = re.sub(r'[^a-z0-9]+', '-', txt.lower()).strip('-')
            if lvl in (2, 3):
                toc.append((lvl, txt, slug))
            out.append(f'<h{lvl} id="{slug}">{inline(txt)}</h{lvl}>')
            i += 1; continue

        if ln.strip() == '---':
            out.append('<hr />'); i += 1; continue
        if not ln.strip():
            i += 1; continue

        # párrafo
        buf = []
        while i < len(lines) and lines[i].strip() and not re.match(r'^(#{1,4} |> |\||```|!\[|\s*[-*] |\s*\d+\. |---)', lines[i]):
            buf.append(lines[i]); i += 1
        out.append('<p>' + inline(' '.join(buf)) + '</p>')

    return '\n'.join(out), toc

# ------------------------------------------------------------------ plantilla
CSS = """
*{box-sizing:border-box}
body{margin:0;background:#eef1f6;color:#0f172a;font:16px/1.65 -apple-system,'Segoe UI',Roboto,Inter,Arial,sans-serif}
.page{max-width:980px;margin:0 auto;background:#fff;box-shadow:0 4px 30px rgba(15,23,42,.07)}
.cover{position:relative;min-height:940px;padding:0;background:#fff;color:#0f172a;display:flex;flex-direction:column}
.cover .bar{height:14px;background:var(--accent)}
.cover .side{position:absolute;left:0;top:14px;bottom:0;width:8px;background:linear-gradient(180deg,var(--accent),#0f1a30)}
.cover .inner{padding:58px 64px 46px 74px;display:flex;flex-direction:column;flex:1}
.cover .brandline{display:flex;align-items:center;gap:14px;border-bottom:1px solid #e8edf4;padding-bottom:18px}
.cover .mark{width:46px;height:46px;border-radius:11px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px}
.cover .brand{font-size:19px;font-weight:800;letter-spacing:-.2px}
.cover .brandsub{font-size:12px;color:#94a3b8}
.cover .mid{flex:1;display:flex;flex-direction:column;justify-content:center;padding:40px 0}
.cover .doctype{font-size:12px;font-weight:800;letter-spacing:2.6px;text-transform:uppercase;color:var(--accent)}
.cover h1{font-size:52px;line-height:1.05;margin:16px 0 0;font-weight:800;letter-spacing:-1px;color:#0f172a}
.cover .rule{width:96px;height:5px;background:var(--accent);border-radius:3px;margin:26px 0 22px}
.cover .sub{font-size:19px;color:#475569;max-width:560px;line-height:1.5}
.cover .metatable{border-top:1px solid #e8edf4;padding-top:22px;display:flex;gap:60px;flex-wrap:wrap}
.cover .metatable div span{display:block;font-size:10.5px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:#94a3b8;margin-bottom:5px}
.cover .metatable div b{font-size:14.5px;font-weight:600;color:#334155}
.cover .foot{margin-top:26px;font-size:11px;color:#94a3b8}
.toc{padding:34px 60px;border-bottom:1px solid #e8edf4;background:#f8fafc}
.toc h2{font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:#94a3b8;margin:0 0 14px}
.toc a{display:block;color:#334155;text-decoration:none;padding:4px 0;font-size:14.5px;border-left:2px solid transparent;padding-left:12px}
.toc a:hover{color:var(--accent);border-left-color:var(--accent)}
.toc a.l3{padding-left:30px;font-size:13.5px;color:#64748b}
main{padding:44px 60px 70px}
h1{font-size:30px;margin:0 0 22px}
h2{font-size:23px;margin:44px 0 14px;padding-bottom:9px;border-bottom:2px solid #eef1f7;scroll-margin-top:20px}
h3{font-size:17.5px;margin:28px 0 10px;color:#1e293b;scroll-margin-top:20px}
p{margin:12px 0}
code{background:#f1f5f9;padding:2px 6px;border-radius:5px;font:13.5px/1.5 ui-monospace,Consolas,monospace;color:#be123c}
pre{background:#0f1a30;color:#e2e8f0;padding:16px 18px;border-radius:11px;overflow:auto;margin:16px 0}
pre code{background:none;color:inherit;padding:0;font-size:13.5px}
blockquote{margin:18px 0;padding:14px 18px;background:var(--soft);border-left:4px solid var(--accent);border-radius:0 10px 10px 0}
blockquote p{margin:5px 0;font-size:14.5px;color:#334155}
.tw{overflow-x:auto;margin:18px 0}
table{width:100%;border-collapse:collapse;font-size:14.5px}
th{text-align:left;background:#f8fafc;color:#475569;font-weight:700;font-size:12.5px;letter-spacing:.4px;text-transform:uppercase;padding:11px 13px;border-bottom:2px solid #e8edf4}
td{padding:11px 13px;border-bottom:1px solid #f1f5f9;vertical-align:top}
tr:last-child td{border-bottom:none}
ul,ol{margin:12px 0;padding-left:24px}
li{margin:6px 0}
hr{border:none;border-top:1px solid #e8edf4;margin:38px 0}
figure.shot{margin:26px 0;text-align:center}
figure.shot img{max-width:100%;border-radius:12px;border:1px solid #e2e8f0;box-shadow:0 6px 22px rgba(15,23,42,.09)}
figure.shot figcaption{font-size:12.5px;color:#94a3b8;margin-top:9px}
figure.shot .fn{display:block;font:11.5px ui-monospace,Consolas,monospace;color:#cbd5e1;margin-top:3px}
figure.shot.ph .fn{color:var(--accent);font-weight:700;margin-top:6px}
figure.shot.ph{border:2px dashed #cbd5e1;border-radius:12px;background:#f8fafc;padding:38px 20px}
figure.shot.ph::before{content:'Imagen pendiente';display:block;font-size:12px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:#94a3b8}
figure.shot.ph figcaption{margin-top:8px;color:#64748b;font-size:13.5px}
footer{padding:26px 60px 40px;color:#94a3b8;font-size:12.5px;border-top:1px solid #eef1f7}
.top{position:fixed;right:22px;bottom:22px;background:var(--accent);color:#fff;border:0;border-radius:11px;padding:11px 16px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(15,23,42,.2)}
@media print{
  body{background:#fff}
  .page{box-shadow:none;max-width:none}
  .top{display:none}
  .cover{padding:60px 40px;page-break-after:always}
  .toc{page-break-after:always}
  main{padding:0 10px}
  h2{page-break-after:avoid}
  figure.shot,table,pre,blockquote{page-break-inside:avoid}
  a{color:inherit;text-decoration:none}
}
"""

def build(manual, meta):
    src = os.path.join(SRC, manual['id'] + '.md')
    body, toc = md(open(src, encoding='utf-8').read())
    # el h1 del md ya es el titulo: lo sacamos del cuerpo (va en la portada)
    body = re.sub(r'^<h1[^>]*>.*?</h1>\s*', '', body, count=1, flags=re.S)
    links = ''.join(f'<a class="l{l}" href="#{s}">{t}</a>' for l, t, s in toc)
    accent = manual.get('accent', '#2563eb')
    soft = accent + '14'
    today = datetime.date.today().strftime('%d/%m/%Y')
    ver = open(os.path.join(ROOT, 'VERSION')).read().strip() if os.path.exists(os.path.join(ROOT, 'VERSION')) else ''
    return f"""<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{meta['product']} · {manual['title']}</title>
<style>:root{{--accent:{accent};--soft:{soft}}}{CSS}</style></head>
<body>
<div class="page">
  <header class="cover">
    <div class="bar"></div><div class="side"></div>
    <div class="inner">
      <div class="brandline">
        <div class="mark">{manual['icon']}</div>
        <div>
          <div class="brand">{meta['product']}</div>
          <div class="brandsub">{meta['tagline']}</div>
        </div>
      </div>
      <div class="mid">
        <div class="doctype">Documentación oficial</div>
        <h1>{manual['title']}</h1>
        <div class="rule"></div>
        <div class="sub">{manual['subtitle']}</div>
      </div>
      <div class="metatable">
        <div><span>Dirigido a</span><b>{manual['audience']}</b></div>
        <div><span>Versión del producto</span><b>{ver or '—'}</b></div>
        <div><span>Actualizado</span><b>{today}</b></div>
        <div><span>Documento</span><b>{manual['id'].upper()}</b></div>
      </div>
      <div class="foot">© {datetime.date.today().year} {meta['product']} · Este documento puede actualizarse sin previo aviso.</div>
    </div>
  </header>
  <nav class="toc"><h2>Contenido</h2>{links}</nav>
  <main>{body}</main>
  <footer>{meta['product']} · {manual['title']} · versión {ver or '—'} · {today}</footer>
</div>
<button class="top" onclick="window.print()">Descargar PDF</button>
<script>if(location.search.indexOf("print=1")>=0){{window.addEventListener("load",function(){{setTimeout(function(){{window.print()}},400)}});}}</script>
</body></html>"""

MAXW, MAXKB = 1800, 350
def optimize(src, dst):
    """Redimensiona y recomprime capturas pesadas: un manual con 50 PNG de 2 MB es
    inservible (tarda en cargar y el PDF pesa 100 MB). Los SVG pasan intactos."""
    if not src.lower().endswith(('.png', '.jpg', '.jpeg')):
        return False
    try:
        from PIL import Image
    except ImportError:
        return False
    if os.path.getsize(src) <= MAXKB * 1024:
        return False
    try:
        im = Image.open(src)
        if im.width > MAXW:
            im = im.resize((MAXW, round(im.height * MAXW / im.width)), Image.LANCZOS)
        if im.mode == 'RGBA':
            bg = Image.new('RGB', im.size, (255, 255, 255)); bg.paste(im, mask=im.split()[-1]); im = bg
        im = im.convert('RGB')
        im.save(dst, 'PNG', optimize=True)
        if os.path.getsize(dst) > 600 * 1024:      # sigue pesada: paleta de 256 colores
            im.convert('P', palette=Image.ADAPTIVE, colors=256).save(dst, 'PNG', optimize=True)
        return True
    except Exception:
        return False

def main():
    meta = json.load(open(os.path.join(SRC, '00-meta.json'), encoding='utf-8'))
    os.makedirs(os.path.join(OUT, 'img'), exist_ok=True)
    for m in meta['manuals']:
        html = build(m, meta)
        dst = os.path.join(OUT, m['id'] + '.html')
        open(dst, 'w', encoding='utf-8').write(html)
        shutil.copy(os.path.join(SRC, m['id'] + '.md'), os.path.join(OUT, m['id'] + '.md'))
        print('  ✓ %-14s %s' % (m['id'], dst))
    # imágenes que ya existan (las capturas grandes se optimizan al copiarlas)
    src_img = os.path.join(SRC, 'img')
    n, saved = 0, 0
    if os.path.isdir(src_img):
        for f in os.listdir(src_img):
            src_f = os.path.join(src_img, f); dst_f = os.path.join(OUT, 'img', f)
            before = os.path.getsize(src_f)
            if not optimize(src_f, dst_f):
                shutil.copy(src_f, dst_f)
            saved += before - os.path.getsize(dst_f); n += 1
    json.dump(meta, open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('  ✓ %d imágenes · %.1f MB ahorrados por optimización' % (n, saved / 1048576))
    return 0

if __name__ == '__main__':
    sys.exit(main())
