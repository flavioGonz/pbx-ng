# Colas de llamadas · análisis competitivo (Grandstream UCM6304) y plan para PBX-NG

Relevado de las capturas del UCM6304A (Cola de llamadas → Ajustes básicos / Configuraciones
avanzadas / Agentes) y contrastado con lo que hoy tiene PBX-NG.

## Qué tenemos hoy

`queues` (realtime) con **6 campos**: `name`, `strategy`, `timeout`, `musiconhold`, `maxlen=0`,
`retry=5`; `queue_members`; y un `access_exten` para marcarla. La UI (`QueuePanel.jsx`, 51 líneas)
expone poco más que eso. Funciona, pero es una cola "de manual", no de producto.

La buena noticia: **casi todo lo que hace el UCM ya lo soporta `app_queue` nativo** — están las
columnas en la tabla `queues` de realtime. No hace falta inventar dialplan; hace falta exponerlas.

## Mapeo Grandstream → Asterisk → PBX-NG

| Grandstream (UCM) | Asterisk (`queues`) | Estado |
|---|---|---|
| Tiempo de descanso del agente | `wrapuptime` | falta |
| Tiempo de timbrado del agente | `timeout` | ✅ |
| Tiempo de reintento | `retry` | ✅ (fijo en 5) |
| Capacidad de cola máxima | `maxlen` | ✅ (fijo en 0) |
| Estrategia | `strategy` | ✅ |
| Música en espera | `musiconhold` | ✅ |
| Grabación automática | `monitor-type` = MixMonitor | falta |
| Notificación de bienvenida | `announce` | falta |
| Anuncio de posición / de tiempo en espera | `announce-position`, `announce-holdtime` | falta |
| Anuncio personalizado + intervalo | `periodic-announce`, `periodic-announce-frequency` | falta |
| Salir cuando no hay agentes (estricto) | `joinempty` / `leavewhenempty` | falta |
| Permitir llamadas en cola sin agente | `joinempty=yes` | falta |
| Anuncio de Agent ID | `announce-to-first-user` / agente | falta |
| Reportar tiempo en espera | `reportholdtime` | falta |
| Acuerdo de nivel de servicio (SLA) | `servicelevel` | falta |
| Memoria de llamadas | `memberdelay` / `ringinuse` | falta |
| Enrutamiento por competencia (skills) | `queue_members.penalty` | falta (la columna existe) |
| Agentes dinámicos vs estáticos | miembros dinámicos (AMI/QueueAdd) vs estáticos | parcial |
| Jefe de cola (CTI) | — | ✅ (panel supervisor: escucha/susurro/irrupción) |
| Cola virtual / callback | — (no existe en Asterisk) | falta — **el más valioso** |
| Encuesta de satisfacción | — | ✅ motor propio (CRM) — falta conectarlo a la cola |
| Tiempo máx. de espera + destino | `timeout` de la cola + dialplan | falta el destino |

## Plan propuesto (en orden de valor / esfuerzo)

### Bloque 1 — Cola "completa" (config nativa, bajo riesgo)
Exponer en la UI y en la API las columnas que ya soporta `app_queue`: `wrapuptime`, `retry`,
`maxlen`, `weight`, `servicelevel`, `joinempty`/`leavewhenempty`, `ringinuse`, `autofill`,
`autopause`, `reportholdtime`, `monitor-type` (grabación automática por cola), y el
**destino al vencer la espera máxima** (colgar / buzón / otra cola / IVR / interno) resuelto en el
dialplan generado. Es el 70% de lo que muestra el UCM y es casi todo configuración.

### Bloque 2 — Anuncios con voz propia (diferencial)
`announce` (bienvenida), `announce-position`, `announce-holdtime` y `periodic-announce`.
**Diferencia con Grandstream**: ellos te obligan a *subir un WAV*. Nosotros generamos el anuncio
**desde texto** con el TTS propio (voz uruguaya es-UY), lo guardamos como prompt y lo asignamos a
la cola. "Escribí el anuncio, escuchalo, guardalo" — sin editores de audio.

### Bloque 3 — Cola virtual / callback ("no cuelgue, lo llamamos")
Lo que el UCM llama *Cola virtual*: al superar N segundos, se ofrece "presione 1 y lo llamamos
manteniendo su lugar". Guardamos número + posición + hora, liberamos la línea, y cuando toca el
turno el control-plane hace `Originate` al cliente y recién ahí engancha al agente. Requiere
lógica nuestra (ARI/AMI), no existe en Asterisk. **Es el feature que más se nota en un call center
real** y el que más diferencia contra un UCM.

### Bloque 4 — Agentes de verdad
Estáticos vs dinámicos, login/logout con feature code y clave, **penalty = niveles de competencia**
(skills-based routing), pausa con motivo (ya existe `/api/agent/pause`), y contador de llamadas por
agente con reseteo programado.

### Bloque 5 — SLA y calidad
`servicelevel` + métricas reales en el wallboard: % atendidas dentro del SLA, abandonos, tiempo
medio de espera, ocupación por agente. Y **encuesta de satisfacción al colgar** enganchada al motor
de encuestas que ya tenemos en el CRM (DTMF 1-5 → tabla de encuestas → reporte por agente).

### Fuera de alcance (ruido del UCM)
Código premium, Alert-Info, RPID, "autocompletar", reemplazo de nombre de visualización: son
parches de compatibilidad con sus propios teléfonos; no aportan a nuestro producto.

## Ventajas que ya tenemos y ellos no
Transcripción y análisis de llamadas con IA (Whisper), screen-pop de CRM al entrar la llamada,
softphone propio (escritorio + PWA), grabaciones con reproductor y transcripción en el panel, y
anuncios generados por TTS en vez de WAVs subidos a mano.
