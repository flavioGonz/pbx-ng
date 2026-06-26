# SBC · Kamailio + RTPEngine (172.26.20.205)

El Session Border Controller corre **Kamailio** (proxy SIP de borde) y **RTPEngine** (relay de medios) en un contenedor aparte.

Su `kamailio.cfg` se administra **desde el panel** (`/sbc` → pestaña *Configuración*): se valida con `kamailio -c` antes de aplicar, se hace backup y se reinicia el servicio. Un agente liviano en el SBC sincroniza estado (dispatcher, pike/ipban, rtpengine, stats) y ejecuta comandos contra la base de datos.

Funciones clave:
- `dispatcher` → reparte señalización hacia los Asterisk activos.
- `pike` + `htable(ipban)` → anti-flood / mitigación de escaneo SIP (whitelist de la LAN).
- `rtpengine` → ancla y relaya el RTP en el borde, ocultando a Asterisk.
- `uac_reg` → registro de troncales de proveedor (Modelo A).

> La config viva no se versiona aquí porque vive en la base de datos del SBC y se edita por la UI.
