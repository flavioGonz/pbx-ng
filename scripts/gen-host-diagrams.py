#!/usr/bin/env python3
"""
PBX-NG · genera los diagramas de "Dónde instalarlo: tipos de host".

Un diagrama por arquitectura, mostrando las CAPAS reales (hardware → hipervisor →
sistema → Docker → módulos de PBX-NG) y, al pie, lo que hay que tener en cuenta al
instalar en ese tipo de host. La idea es que el técnico entienda de un vistazo dónde
se para la central y qué le puede arruinar el audio.

Salida: docs/manual/img/inst-2x-*.svg  (y copia a dashboard/public/manuales/img/)
Uso:    python3 scripts/gen-host-diagrams.py
"""
import os, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'docs', 'manual', 'img')
PUB = os.path.join(ROOT, 'dashboard', 'public', 'manuales', 'img')

W, H = 760, 430
C = {
    'hw':    ('#e2e8f0', '#64748b'),   # hardware
    'hyp':   ('#ede9fe', '#7c3aed'),   # hipervisor
    'os':    ('#dbeafe', '#2563eb'),   # sistema operativo
    'docker':('#cffafe', '#0891b2'),   # docker
    'pbx':   ('#dcfce7', '#16a34a'),   # modulos PBX-NG
    'net':   ('#fef3c7', '#d97706'),   # red
    'warn':  ('#fee2e2', '#dc2626'),   # cuidado
}

def capa(x, y, w, h, titulo, sub, kind, rx=10):
    fill, stroke = C[kind]
    s = (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" '
         f'stroke="{stroke}" stroke-width="1.8"/>')
    s += (f'<text x="{x+14}" y="{y+h/2-2}" font-size="13" font-weight="700" '
          f'fill="#0f172a">{titulo}</text>')
    if sub:
        s += (f'<text x="{x+14}" y="{y+h/2+15}" font-size="10.5" fill="#475569">{sub}</text>')
    return s

def chip(x, y, txt, kind='pbx'):
    fill, stroke = C[kind]
    w = 8 + len(txt) * 6.4
    return (f'<rect x="{x}" y="{y}" width="{w}" height="22" rx="7" fill="{fill}" stroke="{stroke}" '
            f'stroke-width="1.2"/><text x="{x+w/2}" y="{y+15}" font-size="10.5" font-weight="600" '
            f'text-anchor="middle" fill="#0f172a">{txt}</text>'), w

def modulos(x, y, mods):
    """Fila de chips con los módulos que corren."""
    s, cx = '', x
    for m in mods:
        c, w = chip(cx, y, m)
        s += c; cx += w + 7
    return s

def notas(y, items):
    """Recuadro de 'a tener en cuenta' al pie."""
    s = (f'<rect x="24" y="{y}" width="{W-48}" height="{22+len(items)*17}" rx="10" '
         f'fill="#fffbeb" stroke="#f59e0b" stroke-width="1.4"/>')
    s += (f'<text x="38" y="{y+18}" font-size="11" font-weight="800" fill="#92400e">'
          f'AL INSTALAR, TENER EN CUENTA</text>')
    for i, t in enumerate(items):
        s += (f'<text x="38" y="{y+37+i*17}" font-size="11" fill="#78350f">• {t}</text>')
    return s

def marco(titulo, subtitulo, cuerpo, pie):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
<rect width="{W}" height="{H}" fill="#ffffff"/>
<text x="24" y="30" font-size="17" font-weight="800" fill="#0f172a">{titulo}</text>
<text x="24" y="49" font-size="11.5" fill="#64748b">{subtitulo}</text>
<line x1="24" y1="60" x2="{W-24}" y2="60" stroke="#e2e8f0" stroke-width="1.5"/>
{cuerpo}
{pie}
</svg>
'''

# ── 1. Servidor físico (bare metal) ─────────────────────────────────────────
cuerpo = (
    capa(24, 76, W-48, 46, 'Servidor físico', 'CPU, RAM y disco dedicados — sin capas intermedias', 'hw') +
    capa(24, 130, W-48, 46, 'Debian 12 / Ubuntu 22.04', 'sistema operativo directo sobre el hardware', 'os') +
    capa(24, 184, W-48, 46, 'Docker + docker compose', 'motor de contenedores', 'docker') +
    f'<text x="24" y="252" font-size="11" font-weight="700" fill="#166534">MÓDULOS DE PBX-NG</text>' +
    modulos(24, 260, ['core (Asterisk + BD + panel)', 'sbc', 'turn', 'ai', 'intercom'])
)
pie = notas(300, [
    'Es el mejor rendimiento de audio: nada le roba CPU a la central.',
    'Recomendado para centrales grandes, muchas llamadas simultáneas o grabación masiva.',
    'Sincronizá el reloj (chrony/NTP): sin hora correcta fallan TLS y el cifrado del audio.',
])
open(os.path.join(OUT, 'inst-20-baremetal.svg'), 'w', encoding='utf-8').write(
    marco('Instalación en servidor físico (bare metal)',
          'Todo el hardware es para la central. La opción de máximo rendimiento.', cuerpo, pie))

# ── 2. Máquina virtual (Proxmox / KVM) ──────────────────────────────────────
cuerpo = (
    capa(24, 76, W-48, 40, 'Servidor físico', 'compartido con otras máquinas virtuales', 'hw') +
    capa(24, 124, W-48, 40, 'Hipervisor (Proxmox VE / KVM)', 'reparte CPU, RAM y red entre las VMs', 'hyp') +
    capa(24, 172, W-48, 44, 'VM dedicada a PBX-NG', 'CPU tipo «host» · CPU reservada (sin sobreventa)', 'os') +
    capa(24, 224, W-48, 36, 'Docker + docker compose', '', 'docker') +
    f'<text x="24" y="284" font-size="11" font-weight="700" fill="#166534">MÓDULOS DE PBX-NG</text>' +
    modulos(24, 292, ['core', 'sbc', 'turn', 'ai', 'intercom'])
)
pie = notas(328, [
    'Es la opción RECOMENDADA para la mayoría: buen aislamiento y comportamiento predecible.',
    'Poné el tipo de procesador en «host» para que la VM use el cifrado por hardware (AES-NI).',
    'No sobrevendas CPU: si el hipervisor se queda sin núcleos reales, el audio se corta.',
])
open(os.path.join(OUT, 'inst-21-vm.svg'), 'w', encoding='utf-8').write(
    marco('Instalación en máquina virtual (Proxmox / KVM)',
          'La opción recomendada: aislada, predecible y fácil de respaldar.', cuerpo, pie))

# ── 3. Contenedor LXC (Proxmox) ─────────────────────────────────────────────
cuerpo = (
    capa(24, 76, W-48, 38, 'Servidor físico', '', 'hw') +
    capa(24, 122, W-48, 38, 'Proxmox VE', 'el núcleo del host es COMPARTIDO por los contenedores', 'hyp') +
    capa(24, 168, W-48, 52, 'Contenedor LXC', 'requiere Anidamiento (nesting) = SÍ  ·  keyctl = SÍ', 'warn') +
    capa(24, 228, W-48, 36, 'Docker + docker compose', 'corre DENTRO del LXC gracias al anidamiento', 'docker') +
    f'<text x="24" y="288" font-size="11" font-weight="700" fill="#166534">MÓDULOS DE PBX-NG</text>' +
    modulos(24, 296, ['core', 'sbc', 'turn', 'ai', 'intercom'])
)
pie = notas(332, [
    'Sin «nesting» y «keyctl» activados, Docker NO arranca adentro y el error no es obvio.',
    'Consume menos y arranca más rápido que una VM, pero comparte el núcleo del host.',
    'Si dudás entre LXC y VM, elegí VM: es más predecible para el audio en tiempo real.',
])
open(os.path.join(OUT, 'inst-22-lxc.svg'), 'w', encoding='utf-8').write(
    marco('Instalación en contenedor LXC (Proxmox)',
          'Más densidad y arranque rápido, a cambio de compartir el núcleo del host.', cuerpo, pie))

# ── 4. VPS en la nube ───────────────────────────────────────────────────────
cuerpo = (
    capa(24, 76, W-48, 38, 'Infraestructura del proveedor', 'no la controlás vos', 'hw') +
    capa(24, 122, W-48, 44, 'VPS (Debian / Ubuntu)', 'IP pública propia · verificá que NO bloqueen UDP', 'os') +
    capa(24, 174, W-48, 36, 'Docker + docker compose', '', 'docker') +
    f'<text x="24" y="232" font-size="11" font-weight="700" fill="#166534">MÓDULOS DE PBX-NG</text>' +
    modulos(24, 240, ['core', 'sbc', 'turn', 'ai', 'intercom']) +
    capa(24, 276, W-48, 40, 'Red del proveedor', 'si la IP pública NO está en la interfaz, hay que declarar PUBLIC_IP', 'net')
)
pie = notas(330, [
    'Muchos proveedores filtran UDP: sin UDP no hay audio, aunque la llamada conecte.',
    'Si la IP pública no está en la placa (NAT del proveedor), configurá PUBLIC_IP al instalar.',
    'Abrí el rango RTP y el relay del TURN, no sólo el 5060: es el error número uno.',
])
open(os.path.join(OUT, 'inst-23-vps.svg'), 'w', encoding='utf-8').write(
    marco('Instalación en un VPS (nube)',
          'Central sin sede física. Todo depende de que el proveedor deje pasar el audio.', cuerpo, pie))

# ── 5. Núcleo + borde (dos máquinas) ────────────────────────────────────────
cuerpo = (
    f'<rect x="24" y="80" width="330" height="180" rx="12" fill="#f8fafc" stroke="#2563eb" stroke-width="2"/>'
    f'<text x="40" y="104" font-size="13" font-weight="800" fill="#1e40af">NÚCLEO (en la LAN)</text>'
    f'<text x="40" y="122" font-size="10.5" fill="#475569">no se publica a internet</text>'
    + modulos(40, 136, ['core']) + modulos(40, 166, ['Asterisk', 'BD', 'panel']) +
    f'<text x="40" y="214" font-size="10.5" fill="#475569">Guarda las grabaciones,</text>'
    f'<text x="40" y="230" font-size="10.5" fill="#475569">los usuarios y el CDR.</text>'

    f'<rect x="406" y="80" width="330" height="180" rx="12" fill="#f8fafc" stroke="#d97706" stroke-width="2"/>'
    f'<text x="422" y="104" font-size="13" font-weight="800" fill="#92400e">BORDE (en la DMZ)</text>'
    f'<text x="422" y="122" font-size="10.5" fill="#475569">expuesto a internet</text>'
    + modulos(422, 136, ['sbc', 'turn']) +
    f'<text x="422" y="190" font-size="10.5" fill="#475569">Recibe los ataques, las</text>'
    f'<text x="422" y="206" font-size="10.5" fill="#475569">troncales y los teléfonos</text>'
    f'<text x="422" y="222" font-size="10.5" fill="#475569">remotos.</text>'

    f'<line x1="354" y1="170" x2="406" y2="170" stroke="#64748b" stroke-width="2.5" stroke-dasharray="5 4"/>'
    f'<text x="380" y="162" font-size="9.5" text-anchor="middle" fill="#475569">LAN</text>'
    f'<circle cx="736" cy="40" r="0" fill="none"/>'
    f'<text x="24" y="290" font-size="11" fill="#334155">El instalador del núcleo genera un archivo de unión '
    f'(<tspan font-family="monospace" font-size="10.5">edge-join.env</tspan>) con los secretos compartidos; se copia al borde y se instala con '
    f'<tspan font-family="monospace" font-size="10.5">--join</tspan>.</text>'
)
pie = notas(310, [
    'Se usa cuando la seguridad perimetral importa: si vulneran el borde, no llegan a la base ni a las grabaciones.',
    'El borde verifica que alcanza al núcleo ANTES de desplegar: si un puerto no responde, avisa.',
    'Para una oficina o una central única, con UNA sola máquina alcanza y sobra.',
])
open(os.path.join(OUT, 'inst-24-nucleo-borde.svg'), 'w', encoding='utf-8').write(
    marco('Instalación en dos máquinas: núcleo + borde',
          'El núcleo queda protegido en la LAN y sólo el borde se expone a internet.', cuerpo, pie))

# copia a la carpeta que sirve el panel
os.makedirs(PUB, exist_ok=True)
n = 0
for f in os.listdir(OUT):
    if f.startswith('inst-2') and f.endswith('.svg'):
        shutil.copy2(os.path.join(OUT, f), os.path.join(PUB, f)); n += 1
print(f'✓ {n} diagramas generados en docs/manual/img/ y copiados al panel')
