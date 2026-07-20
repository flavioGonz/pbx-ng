# Manual de Configuración

> **Para quién es este manual**
> Para el administrador de la central: la persona que la pone en marcha, conecta las troncales,
> crea las extensiones y decide cómo entran y salen las llamadas. Se lee en orden la primera vez, y
> después se usa como referencia por sección.

---

## 1. Qué es PBX-NG

### 1.1 No es una central: es el director de orquesta

PBX-NG **no reemplaza** a las piezas clásicas de la telefonía IP: las **coordina**. Debajo del capó
corren varios motores libres, cada uno excelente en lo suyo y ninguno pensado para conversar con el
otro. PBX-NG es la capa que los hace trabajar juntos, y la única cara que ves.

| Motor | Qué resuelve | Qué NO hace |
|---|---|---|
| **Asterisk 22** | Las llamadas: dialplan, colas, IVR, buzón, grabación, conferencias | No sabe defenderse de Internet ni hablar con navegadores |
| **coturn** | STUN y TURN: que un teléfono detrás de cualquier NAT tenga audio | No es una central |
| **go2rtc** | Traduce el video RTSP de porteros y cámaras a WebRTC | Solo video |
| **PostgreSQL** | La memoria: configuración, llamadas, grabaciones, CRM | — |

Y por encima de todos, el **control-plane** de PBX-NG: el panel que ves, la API, las alertas, el CRM
y los correos. Es quien traduce "creá una cola de ventas" en las decenas de líneas de configuración
que cada motor necesita.

### 1.2 Cómo se hablan entre sí

El recorrido de **una llamada que entra desde la calle** cuenta la historia mejor que cualquier
diagrama:

1. El operador manda la llamada a tu enlace. Si tenés un **borde** adelante (SBC-NG u otro), la
   recibe él y le pasa a la central sólo lo que es legítimo; si no lo tenés, la troncal llega
   directo a Asterisk. Las dos formas son válidas — ver *§5 · El borde*.
2. **Asterisk** hace lo suyo: mira el dialplan, decide si va a una extensión, una cola o un IVR, graba
   si corresponde, deja el mensaje en el buzón si nadie atiende.
3. Si el que atiende es un **softphone WebRTC**, el navegador negocia el audio con **coturn**, que le
   da un camino aunque esté detrás del NAT de su casa.
4. Todo lo que pasó queda en **PostgreSQL**: el registro de la llamada, la grabación, la encuesta.
5. Y el **control-plane** lo muestra en el panel, y te manda un correo si algo salió mal.

![Cómo se comunican los componentes](img/inst-01-arquitectura.svg)

### 1.3 Qué implica esto para vos

- **Cada motor se puede prender y apagar** (Configuración → Módulos). Sin TURN, los softphones
  remotos se quedan sin audio; sin el motor de IA, hay que subir los audios a mano.
- **Cada motor tiene su panel de diagnóstico** en PBX-NG. Cuando algo falla, la pregunta correcta es
  *"¿qué motor falló?"*, y este manual te lleva a la pantalla de ese motor.
- **No hay que configurar Asterisk a mano.** El panel genera su configuración. Si editás
  archivos por debajo, el panel los va a sobrescribir la próxima vez que guardes algo.


---

## 2. Orden de puesta en marcha

### 2.1 Qué vas a tener cuando termines

Antes de tocar un solo botón, conviene saber a dónde vamos. Al final de este capítulo la central no
va a estar "instalada": va a estar **en producción**, y eso significa cinco cosas concretas.

| Al terminar vas a tener | Qué quiere decir en la práctica |
|---|---|
| **Una central que atiende** | Entra una llamada del operador, la contesta un menú o una persona, y sale por donde vos decidiste. |
| **Personas con teléfono** | Cada uno con su extensión: en el navegador, en el celular, en la app de escritorio o en un teléfono de escritorio. Sin instalar nada a mano. |
| **Un borde que se defiende** | El SBC filtrando escaneos, bloqueando IPs y cortando el fraude antes de que llegue a Asterisk. |
| **Una central que te avisa** | Si se cae la troncal, si te atacan, si una cola quedó sin agentes: te llega un correo. No te enterás por un cliente enojado. |
| **Números para mostrar** | Historial, grabaciones, wallboard e informe ejecutivo. Se puede medir, y lo que se mide se puede mejorar. |

### 2.2 Antes de enchufar nada

Hay seis cosas que no dependen de PBX-NG y que, si faltan, frenan la puesta en marcha a la mitad
esperando a un tercero (el operador, el proveedor de internet, el que administra el dominio).
Conseguilas primero.

![Lo que hay que tener resuelto antes de empezar](img/cfg-00-antes-de-empezar.svg)

### 2.3 El recorrido, en cuatro fases

El orden no es caprichoso: **cada fase se apoya en la anterior**. Si respetás la secuencia, nunca
tenés que volver atrás a rehacer algo que ya habías configurado.

![El recorrido de puesta en marcha en cuatro fases](img/cfg-00-recorrido.svg)

### 2.4 El checklist paso a paso

| # | Paso | Dónde | Por qué va acá |
|---|---|---|---|
| **0** | **Entrar por la IP** | `http://<IP-del-servidor>:3001` | **Primero comprobá que la aplicación está viva.** Antes de meterse con dominios, DNS o certificados, entrá directo por la IP: si el panel carga, el problema (si después aparece) es de red o de proxy, no del sistema. Es el paso que ahorra horas de diagnóstico. |
| 1 | Cambiar la contraseña | Panel → primer ingreso | El instalador imprimió una clave inicial y el sistema te obliga a cambiarla. |
| 2 | Módulos activos | Configuración → Módulos | Define qué contenedores existen (SBC, TURN, IA, Intercom). Encender un módulo lo crea; apagarlo lo destruye. |
| 3 | **Dominio y certificado** | Configuración → Proxy / TLS | **Recién ahora** el dominio: apuntás el DNS, emitís el certificado y pasás a entrar por `https://tu-dominio`. Sin TLS, las extensiones WebRTC no funcionan (el navegador no da micrófono sin HTTPS). |
| 4 | Componentes (IPs) | Configuración → Componentes | El panel necesita saber dónde vive cada pieza. |
| 5 | Marca | Configuración → Branding | Aparece en el panel, en los correos y en los informes. |
| 6 | *(opcional)* **Borde** | Panel de SBC-NG | Sólo si vas a exponer la central a Internet. Es otro producto: ver su manual. |
| 7 | TURN | Configuración → Módulos | El que hace que WebRTC funcione detrás de cualquier NAT. |
| 8 | Troncal | Troncales | La línea con el mundo. |
| 9 | Rutas salientes | Rutas → Salientes | Qué se marca y por dónde sale. |
| 10 | Rutas entrantes | Rutas → Entrantes | Qué pasa cuando te llaman. |
| 11 | Extensiones | Extensiones | Las personas. |
| 12 | Correo | Configuración → Email | Sin esto no hay QR, ni buzón por mail, ni alertas. |
| 13 | Entrega de teléfonos | Extensiones → Enviar acceso | El QR y el enlace de acceso. |
| 14 | Aplicaciones | Aplicaciones | Colas, IVR, buzones, conferencias. |
| 15 | Alertas | Configuración → Alertas | Que la central te avise a vos. |

> **La regla de los dos pasos**: primero **IP** (¿está viva la aplicación?), después **dominio**
> (¿está bien publicada?). Nunca al revés. Si entrás directo por el dominio y algo falla, no sabés si
> el problema es el sistema, el DNS, el proxy o el certificado — tenés cuatro sospechosos en vez de
> uno.

---

## 3. Primer ingreso al panel

» Navegador → https://tu-dominio

### 3.1 La dirección de la aplicación

Al terminar la instalación, el instalador imprime **las URLs** y la contraseña inicial. Guardalas: son
la puerta de entrada.

El panel vive en el servidor donde instalaste PBX-NG, en el **puerto 3001**:

```
http://IP-DEL-SERVIDOR:3001
```

Esa dirección **solo sirve para el primer arranque y desde la red interna**. En cuanto publiques el
dominio (siguiente punto), el acceso definitivo pasa a ser:

```
https://pbx.tu-empresa.com
```

Y esa es la que le vas a dar a todo el mundo — la que va en los correos de acceso, la que usan los
softphones y la que hay que respaldar en tu documentación del cliente.

![Pantalla de login del panel](img/inst-04-login.png)

### 3.2 El dominio con certificado SSL no es opcional

Esta es la advertencia más importante de todo el despliegue, así que va sola y en negrita:

> **Sin un dominio con certificado SSL válido, las extensiones WebRTC no funcionan. Ninguna.**
> Ni el softphone del navegador, ni el del celular, ni el de escritorio en modo WebRTC.

**No es un capricho nuestro.** Los navegadores prohíben el acceso al micrófono (`getUserMedia`) y el
WebSocket seguro (`wss://`) cuando la página no viene de un **origen seguro** — es decir, HTTPS con
un certificado emitido por una autoridad reconocida. Un certificado **autofirmado tampoco alcanza**:
el navegador lo rechaza igual, y el softphone se queda registrando para siempre.

Sin dominio la central igual funciona, pero **sólo con teléfonos SIP**: los de escritorio, los ATA,
las bocinas IP y el softphone en modo SIP nativo dentro de la red. Perdés justamente lo que la hace
atractiva.

![Qué se puede hacer con dominio y certificado, y qué no sin ellos](img/cfg-01-ssl-webrtc.svg)

| Función | Con dominio + SSL | Sólo por IP |
|---|:---:|:---:|
| Softphone en el navegador | ✅ | ❌ |
| Softphone en el celular (PWA) | ✅ | ❌ |
| App de escritorio en modo WebRTC | ✅ | ❌ |
| Teletrabajo sin VPN | ✅ | ❌ |
| QR y enlace de acceso | ✅ | ❌ (el enlace apunta a la nada) |
| Click-to-Call desde la web | ✅ | ❌ |
| Teléfonos SIP en la LAN | ✅ | ✅ |
| Troncales SIP con el operador | ✅ | ✅ |

**Por eso el orden correcto es**: entrás por IP para verificar que la aplicación está viva (paso 0),
y enseguida **dominio → certificado → todo lo demás**. No dejes el dominio "para después": vas a
tener que rehacer la configuración de todos los teléfonos y volver a mandar los enlaces de acceso.

### 3.3 Credenciales por defecto

| Usuario | Contraseña |
|---|---|
| `admin` | **La que imprimió el instalador al terminar** |

La contraseña del `admin` **no es fija ni conocida**: el instalador genera una aleatoria en cada
instalación. **En el primer ingreso el sistema te obliga a cambiarla** y no te deja avanzar hasta que
lo hagas. Una central con la contraseña de fábrica es una central comprometida.

### 3.4 Otras credenciales que genera el instalador

Todas se generan solas, son distintas en cada instalación, y viven en `docker/.env` con permisos
restringidos. **Nunca las edites a mano**: el instalador aborta si detecta un secreto débil.

| Credencial | Para qué sirve | Dónde se ve |
|---|---|---|
| Base de datos | Postgres | `.env` |
| JWT | Firma las sesiones del panel | `.env` |
| ARI / AMI | El panel conversa con Asterisk | `.env` |
| **TURN** | Los softphones usan el relay de audio | `.env` · SBC → TURN |
| Admin del panel | Tu primer ingreso | Salida del instalador |

> **Lo primero que hay que rotar en producción** es la contraseña del TURN si quedó con el valor de
> ejemplo (`pbxng-turn-changeme`). Se cambia en **SBC → TURN**, y hay que actualizarla también en el
> `.env` para que la central se la entregue a los teléfonos.

### 3.5 Hay tres paneles, no uno

La misma dirección sirve a las tres personas, pero **cada rol entra a un panel distinto**. No es una
cuestión de permisos sobre la misma pantalla: son tres aplicaciones con propósitos diferentes.

| Panel | Quién entra | Para qué sirve |
|---|---|---|
| **Administración** | Administrador | Configurar la central: extensiones, troncales, rutas, colas, seguridad. Es este manual. |
| **Supervisor** | Jefe de call center | Ver las colas en vivo, monitorear agentes, escuchar/susurrar/irrumpir, gestionar clientes |
| **Agente** | Quien atiende llamadas | Su softphone, la ficha del cliente que llama, su historial y su buzón |

El ruteo es automático: la persona entra con su usuario y **cae en el panel que le corresponde**. Un
agente no ve —ni puede ver— la configuración de la central.

Los paneles de agente y supervisor están explicados en el **Capítulo 32**; el del usuario final, en
el *Manual de Usuario*.

## 4. Configuración inicial del sistema

» Menú lateral → Sistema → Configuración

Todo esto vive en **Configuración**, y son los cimientos.

### 4.1 Módulos

» Configuración → Módulos

Un módulo activo **es** un contenedor corriendo; uno inactivo **no existe**. Acá prendés y apagás
el SBC, el TURN, el motor de voz (IA) y el intercom. El cambio crea o destruye el contenedor de
verdad: no es una casilla decorativa.

![Módulos activos](img/cfg-16-modulos.png)

### 4.2 Proxy / TLS

» Configuración → Proxy / TLS  ·  y el proxy en sí: http://IP-DEL-PROXY:81

Acá hay una distinción que confunde a todo el mundo la primera vez:

> **PBX-NG no configura el proxy: lo vigila.** La configuración real del reverse proxy se hace
> **dentro de Nginx Proxy Manager**, en su propia interfaz. Lo que cargás en el panel de PBX-NG son
> las credenciales para que pueda *leer* el estado del certificado y la regla del host, y avisarte
> si el certificado está por vencer.

#### Dónde se configura de verdad

Nginx Proxy Manager tiene su propio panel, en el **puerto 81** del servidor donde corre:

```
http://IP-DEL-PROXY:81
```

Credenciales de fábrica de NPM (cambialas en el primer ingreso):

| Usuario | Contraseña |
|---|---|
| `admin@example.com` | `changeme` |

#### Cómo se publica PBX-NG (paso a paso, en NPM)

1. **Hosts → Proxy Hosts → Add Proxy Host**.
2. **Domain Names**: tu dominio (`pbx.tu-empresa.com`).
3. **Scheme**: `http` · **Forward Hostname/IP**: la IP del servidor de PBX-NG · **Forward Port**:
   `3001` (el panel).
4. Activá **Websockets Support**. ← *Sin esto, el softphone web no registra nunca.*
5. Activá **Block Common Exploits**.
6. Pestaña **SSL** → *Request a new SSL Certificate* (Let's Encrypt) → activá **Force SSL** y
   **HTTP/2 Support = APAGADO**.
7. **Save**.

> **Los dos errores que dejan el softphone "conectando" para siempre:**
> 1. **Websockets Support apagado.** El WebSocket (`/ws`) no se establece y el teléfono no registra.
> 2. **HTTP/2 encendido.** Rompe el WebSocket aunque esté habilitado. Tiene que estar **apagado**.
>
> Si el panel carga bien pero el teléfono no registra, revisá estas dos casillas antes que nada.

![Regla del host en Nginx Proxy Manager](img/cfg-35-npm-host.png)

#### Qué hace el panel de PBX-NG (Configuración → Proxy / TLS)

Cargás la URL del NPM (`http://IP:81`), el dominio público y las credenciales de administración de
NPM. Con eso, PBX-NG te muestra:

- El **estado del certificado TLS**: emisor, dominio y **cuántos días le quedan**.
- La **regla del host** de PBX-NG tal como está en el proxy (para verificar que quedó bien).

Es monitoreo, no configuración. Si el certificado se vence, el softphone deja de funcionar — por eso
vale la pena tenerlo a la vista.

![Proxy y certificado TLS en el panel](img/cfg-17-proxy.png)

#### Que se pueda llegar desde adentro y desde afuera (loopback / hairpin)

Un detalle que hace perder horas: **el softphone tiene que registrar tanto desde la calle como desde
la propia oficina**, y las dos cosas usan el mismo dominio público. Cuando alguien en la LAN abre
`https://pbx.tu-empresa.com`, ese pedido sale hacia la IP pública... y tiene que "dar la vuelta" para
volver a entrar. A eso se le llama **NAT loopback** o **hairpin**, y muchos routers no lo hacen de
fábrica.

Los dos síntomas:

- Desde afuera (4G, casa) todo anda; **desde la oficina el softphone no registra**.
- El diagnóstico ICE del panel (SBC → TURN) da **error 701** cuando lo probás desde la LAN.

La solución depende del router, pero la idea es siempre la misma: que el tráfico interno hacia la IP
pública se redirija al servidor, igual que el que viene de Internet. En routers MikroTik, esto se
resuelve con reglas `dst-nat` que **no filtren por interfaz de entrada** (el error clásico es
`in-interface=WAN`, que ignora el tráfico de la LAN) más un `masquerade` de vuelta. El detalle
completo, con las reglas exactas, está en el documento técnico `docs/FIREWALL.md`.

#### Qué puertos abrir, y cómo verificarlos

El proxy publica el panel y el WebSocket, pero la telefonía necesita **más puertos abiertos en el
router hacia el servidor**. Estos son los mínimos:

| Puerto | Protocolo | Para qué |
|---|---|---|
| `443` (y `80` para el certificado) | TCP | Panel, softphone web y `wss://` |
| `5060` / `5061` | UDP+TCP / TCP | SIP (troncales y teléfonos) |
| `3478` | **UDP y TCP** | STUN/TURN — los dos |
| `49152-65535` | UDP | Rango de relay del TURN |
| `30000-40000` | UDP | Audio (RTP) de las troncales y los teléfonos |

> **Los dos errores que dejan las llamadas mudas:**
> 1. Abrir `3478` y **olvidar el rango de relay** (`49152-65535/UDP`). El teléfono obtiene la
>    dirección de relay pero el audio nunca fluye. Van juntos.
> 2. Abrir `3478/UDP` y **no `3478/TCP`**. Muchas redes corporativas bloquean el UDP saliente.

**No confíes en que "está abierto" porque lo configuraste.** Verificalo de verdad: el panel tiene el
**diagnóstico ICE en vivo** (SBC → TURN), que levanta una conexión real y te dice si el TURN
responde y autentica. Y desde la terminal:

```bash
scripts/check-turn.py --env docker/.env --tcp
```

Si la salida dice **`ALLOCATE 200 · relay`**, el puerto está abierto y el TURN funciona de verdad.
Si no, revisá el router antes de seguir. Un puerto que creés abierto y no lo está es la causa número
uno de "registra pero no hay audio".

#### Si usás tu propio proxy (nginx, Traefik, Caddy)

No hace falta NPM. Solo asegurate de que tu proxy:

- Reenvíe el dominio al puerto **3001** (panel) del servidor.
- **Soporte WebSocket** en `/ws` (cabeceras `Upgrade` y `Connection`).
- Tenga **HTTP/2 desactivado** en ese host.

En ese caso, dejá vacío el panel de Proxy/TLS: simplemente no vas a tener el monitoreo del
certificado.

### 4.3 Componentes

» Configuración → Componentes

Es el mapa de la instalación: en qué IP está el Asterisk, el SBC, el TURN, el motor de voz y el
anclaje de medios. El panel usa esto para consultarlos y para dibujar la topología. Si moviste una
pieza de servidor, se actualiza acá.

![Componentes y sus IPs](img/cfg-18-componentes.png)

### 4.4 Branding

» Configuración → Branding

Nombre, subtítulo y **logo** (se sube una imagen). Aparece en el panel, en la pantalla de login, en
los correos de alerta y en los manuales. Es lo primero que ve el cliente: si entregás la central con
el logo de fábrica, parece a medio instalar.

![Branding: nombre y logo](img/cfg-51-branding.png)

### 4.5 Audios e Integraciones

» Configuración → Audios  /  Configuración → Integraciones

**Audios**: los mensajes del sistema. Se pueden subir archivos, pero lo normal es **escribir el
texto y que lo sintetice la central** con su propia voz.

**Integraciones**: notificaciones a Telegram/WhatsApp y otros ganchos externos.

![Audios del sistema](img/cfg-52-audios.png)

---

## 5. El borde: SBC-NG

» Menú lateral → Telefonía → SBC-NG *(sólo aparece si tenés SBC-NG instalado)*

**SBC-NG es un producto aparte de PBX-NG.** Tiene su propia licencia, su propio panel, su propio
manual y su propio ciclo de versiones. Esta sección explica únicamente **cómo se relaciona con la
central**; todo lo que sea configurarlo está en el **Manual de Configuración de SBC-NG**.

### 5.1 PBX-NG funciona con SBC y sin SBC

La central no depende del borde. Son dos escenarios válidos y soportados:

| Escenario | Cómo entra y sale el tráfico | Cuándo elegirlo |
|---|---|---|
| **PBX-NG sola** | Las troncales del operador llegan directo a la central, y los teléfonos se registran contra ella. | Instalaciones en LAN, o cuando el operador entrega el enlace por una red privada o un túnel. |
| **PBX-NG + SBC-NG** | El operador y los teléfonos remotos llegan al borde, y el borde habla con la central por la red interna. | Siempre que la central quede expuesta a Internet. |

El panel se adapta solo: si detecta un borde configurado, **Rutas** y **Topología** muestran el
camino pasando por él; si no lo hay, muestran las troncales conectadas directamente a la central.
No hay que tocar nada para cambiar de escenario más allá de dar de alta o de baja la troncal.

> **Si tu central está expuesta a Internet, poner un borde adelante no es un lujo.** Una central
> desnuda empieza a recibir intentos de registro automatizados en cuestión de horas. Ahora bien:
> ese borde puede ser SBC-NG o el que ya tengas — a PBX-NG le da igual, habla SIP estándar con
> cualquiera.

### 5.2 Qué mira la central del borde

Desde PBX-NG sólo vas a necesitar tres cosas del borde, y las tres se configuran **acá**, no allá:

1. **La troncal hacia el borde** (Troncales). Es una troncal SIP común, apuntada a la IP interna
   del borde. Ver *§7 · Troncales*.
2. **El estado del enlace** (Topología). Muestra si la central y el borde se ven entre sí. Ver
   *§23 · Topología*.
3. **El origen de cada llamada** (Historial). El CDR marca si la llamada entró por el borde o
   directo, para que puedas distinguir tráfico interno de tráfico de Internet. Ver *§21*.

Todo lo demás — reglas de seguridad, bloqueo por país, enrutamiento por operador (LCR),
manipulación de cabeceras SIP, anclaje de medios, STIR/SHAKEN — **es configuración del borde y vive
en su panel**. No lo busques en este manual.

### 5.3 Dónde seguir

| Si querés… | Andá a |
|---|---|
| Configurar el borde | Manual de Configuración de **SBC-NG** |
| Operarlo y diagnosticar | Manual de Operación de **SBC-NG** |
| Conectar la central al borde | *§7 · Troncales*, en este manual |
| Ver el camino de una llamada | *§23 · Topología*, en este manual |

---

## 6. Asterisk · el núcleo

» Menú lateral → Telefonía → Asterisk

La consola de Asterisk (**Asterisk** en el menú) es la ventana al motor de llamadas:

| Pestaña | Qué muestra |
|---|---|
| **Núcleo** | Versión, uptime, llamadas activas, canales |
| **Extensiones** | Estado real de cada endpoint (registrado, en llamada, no alcanzable) |
| **Troncal SBC** | El enlace entre el núcleo y el borde |
| **Red** | Interfaces y conectividad |
| **Dialplan** | El plan de marcación generado, tal cual lo ve Asterisk |
| **Rutas** | Las rutas resueltas |
| **Seguridad** | Fail2ban sobre los registros SIP |

Casi nunca vas a tener que tocar nada acá: el panel genera el dialplan solo a partir de las colas,
los IVR y las rutas. Es para **ver** y para **diagnosticar**.

![Consola de Asterisk](img/cfg-30-asterisk.png)

---

## 7. Troncales

» Menú lateral → Telefonía → Troncales

La **troncal** es la línea que te conecta con el mundo.

### 7.1 Troncal SIP con un operador

En **Troncales → Nueva**: nombre, host y puerto del proveedor, usuario y contraseña, y si hace falta
**registro** (la mayoría de los operadores lo exigen; los que autentican por IP, no).

El panel muestra el estado en vivo: **verde** si responde a OPTIONS, **rojo** si no.

![Troncales con estado en vivo](img/cfg-04-troncales.png)

### 7.2 Troncal WebRTC (unir dos centrales)

Sirve para enlazar dos PBX por Internet sin abrir puertos SIP: una actúa de servidor y la otra se
registra por WebSocket seguro. Se configura con el **enlace WSS**, usuario y contraseña.

![Troncal WebRTC](img/cfg-31-troncal-webrtc.png)

### 7.3 Activá la alerta

**Encendé la alerta de "troncal caída"** (Configuración → Alertas). Si la troncal se corta, dejás de
recibir llamadas — y sin alerta te enterás cuando un cliente se queja, horas después.

---

## 8. Rutas salientes · qué se marca y por dónde sale

» Menú lateral → Telefonía → Rutas → Salientes

En **Rutas → Salientes**. Cada regla es un patrón de marcación y qué hacer con él.

| Campo | Qué hace | Ejemplo |
|---|---|---|
| **Patrón** | Qué números matchea | `_0X.` (todo lo que empieza con 0) |
| **Strip** | Dígitos a quitar del principio | `1` (saca el 0) |
| **Prepend** | Qué agregar adelante | `598` |
| **Caller ID** | Con qué número te ven | `+59824001234` |
| **Troncal** | Por dónde sale | La troncal o el SBC |

**Ejemplo real:** el usuario marca `099123456`. Con `strip=0` y la troncal del operador, sale tal
cual. Si el operador exige formato internacional, ponés `strip=1` y `prepend=598` → sale
`59899123456`.

> Las reglas se evalúan **de arriba hacia abajo**. Poné las más específicas primero (emergencias,
> internacional) y las genéricas al final.

![Rutas salientes](img/cfg-32-rutas-salientes.png)

---

## 9. Rutas entrantes · qué pasa cuando te llaman

» Menú lateral → Telefonía → Rutas → Entrantes

En **Rutas → Entrantes**. Una ruta entrante toma el número al que llamaron (**DID**) y lo manda a
un destino.

| Campo | Qué es |
|---|---|
| **DID** | El número que te asignó el operador |
| **Nombre** | Para identificarla en la lista |
| **Destino** | Extensión, cola, IVR, buzón o conferencia |

**Ejemplo:** el `24001234` (línea principal) va al **IVR** de bienvenida; el `24001299` (ventas
directo) va a la **cola de Ventas**.

> Si una llamada entrante "no llega a ningún lado", el 90% de las veces es que **falta la ruta
> entrante** para ese DID, o que el operador te está mandando el número en otro formato del que
> cargaste (con o sin el código de país). Miralo en **SBC → SIP debug**.

![Rutas entrantes](img/cfg-05-rutas.png)

---

## 10. Extensiones

» Menú lateral → Telefonía → Extensiones

### 10.1 Crear una extensión

En **Extensiones → Nuevo**. Lo mínimo es el número y el nombre. Cada extensión nace con su contraseña
SIP generada y su **buzón de voz activado** (PIN inicial = su número).

![Alta de una extensión](img/cfg-02-nuevo-interno.png)

### 10.2 ¿WebRTC o SIP?

Es la decisión más importante del alta y define qué recibe el usuario en su enlace.

| | **WebRTC** | **SIP clásico** |
|---|---|---|
| Para qué | Softphone en navegador, celular o escritorio | Teléfonos de escritorio, ATAs, bocinas IP |
| Cómo viaja | Cifrado (DTLS-SRTP) sobre WebSocket, puerto 443 | SIP sobre UDP/TCP/TLS |
| Detrás de NAT | Anda sin abrir nada (usa TURN) | Requiere red preparada |
| Cuándo | **Por defecto**, para personas | Para **hardware** |

> **No los mezcles.** Una extensión WebRTC registrado en modo SIP **autentica pero se queda sin
> audio**: el endpoint exige cifrado. Es una confusión clásica y difícil de diagnosticar. El enlace
> de acceso ya viene con el modo correcto según la extensión.

![Tipo de extensión](img/cfg-15-tipo-extensión.png)

### 10.3 Teléfonos físicos

Si en vez de un softphone la persona va a usar un teléfono de escritorio, **no lo configures a mano**:
cargá su MAC en **Telefonía → Teléfonos** y el aparato se configura solo al enchufarlo. El capítulo 24
lo explica completo, incluida la **opción 66 del DHCP**, que es lo que hace que 20 teléfonos nuevos se
configuren sin que toques ninguno.

---

## 11. Correo saliente

» Menú lateral → Sistema → Configuración → Email por empresa

**Sin esto no funciona el envío del QR, ni el buzón por correo, ni las alertas.** Es de las
primeras cosas que conviene dejar andando.

En **Configuración → Email**:

| Campo | Valor típico |
|---|---|
| Host | `smtp.gmail.com` |
| Puerto | `587` (STARTTLS) o `465` (SSL) |
| Usuario | La cuenta completa (`no-reply@tu-empresa.com`) |
| Contraseña | Ver el aviso de abajo |
| Remitente | `Central <no-reply@tu-empresa.com>` |

Guardá y usá el botón **Probar**: si algo está mal, el sistema te dice exactamente qué (credencial
rechazada, no conecta, remitente inválido).

> **Con Gmail o Google Workspace:** si la cuenta tiene verificación en dos pasos, **la contraseña
> normal no sirve** para SMTP. Hay que generar una **contraseña de aplicación** (16 caracteres) en
> `myaccount.google.com/apppasswords` con esa cuenta. Es el error más frecuente de esta pantalla, y
> el panel te lo señala con esas palabras.
>
> Alternativa más robusta para una cuenta `no-reply`: usar el **SMTP relay** de Google autorizando
> la IP pública de la central. No hay contraseña que rotar ni que se venza.

![Configuración de correo](img/cfg-10-email.png)

---

## 12. Entrega del teléfono: QR y enlace de acceso

» Menú lateral → Telefonía → Extensiones → (elegir la extensión) → Enviar acceso por correo

Este es el proceso que reemplaza al "te paso la contraseña por WhatsApp".

### 12.1 Cómo se manda

En **Extensiones**, sobre la extensión, botón **Enviar acceso por correo**. Escribís la dirección de la
persona y listo.

### 12.2 Qué recibe la persona

Un correo con **un código QR** y **un enlace**. Con cualquiera de los dos, su teléfono queda
configurado solo.

![Correo de acceso con el QR](img/cfg-03-email-acceso.png)

### 12.3 Qué lleva adentro el enlace

Es importante que sepas qué estás mandando, porque explica por qué funciona sin que el usuario
configure nada:

- El **transporte correcto según la extensión**: si es WebRTC, va con el servidor WebSocket y las
  credenciales del TURN; si es SIP, va con el servidor SIP, el puerto y el transporte. **El sistema
  lo deduce del endpoint real**, no lo asume.
- El **extensión y su contraseña**.
- La **sesión en la plataforma** (si la extensión tiene un usuario asociado): así la persona ve el
  directorio, la ficha de los clientes y el intercom sin volver a loguearse.

### 12.4 Reglas del enlace

- **Vence en 24 horas.** Si expira, se genera uno nuevo.
- **Sirve para los tres clientes**: navegador, celular (agregar a la pantalla de inicio) y app de
  escritorio (botón QR → "Pegar código").
- Se puede reenviar las veces que haga falta.

> **Para que el usuario vea clientes e intercom**, la extensión tiene que tener un **usuario asociado**
> en **Usuarios** (con su rol). Si no lo tiene, el enlace configura el teléfono igual, pero sin
> sesión en la plataforma.

![Enviar acceso desde el panel](img/cfg-33-enviar-acceso.png)

---

## 13. Aplicaciones

» Menú lateral → Telefonía → Aplicaciones

### 13.1 Colas

» Menú lateral → Aplicaciones → Colas → **Nueva cola**

Una cola es una sala de espera con reglas: las llamadas entran, se ordenan, y se van repartiendo
entre los agentes según la estrategia que elijas. El editor tiene tres pestañas y **todos** sus
campos se explican acá.

#### Pestaña *Básico* — quién atiende y cómo

| Campo | Qué hace | Recomendación |
|---|---|---|
| **Nombre** | Identificador interno de la cola (sin espacios). No se puede cambiar después. | `ventas`, `soporte` |
| **Etiqueta** | El nombre lindo que ve el supervisor en los tableros. | "Ventas · Montevideo" |
| **Extensión de acceso** | El número que hay que marcar (o al que rutea una ruta entrante) para caer en la cola. | 3001, 3002… |
| **Estrategia** | Cómo se elige el agente al que suena. Ver el cuadro de abajo. | *Round-robin con memoria* |
| **Timbrado del agente** | Segundos que suena en un agente antes de pasar al siguiente. | 20-25 s |
| **Descanso del agente** (*wrap-up*) | Segundos de respiro entre una llamada y la siguiente, para cargar la ficha y respirar. | **Al menos 10 s.** En 0 el agente se quema y baja la calidad |
| **Capacidad máxima** | Cuántas llamadas aguanta la cola. Las que llegan de más van al destino de desborde. | 0 = sin límite |
| **Espera máxima** | Cuánto tolera esperar una llamada antes de rendirse. | 120-180 s |
| **Destino al vencer la espera** | A dónde va la llamada que esperó demasiado: buzón, otra extensión, otra cola. | Buzón o extensión de respaldo |
| **Grabar llamadas** | Graba todo lo que se atiende por esta cola. | Encendido en atención al cliente |
| **Agentes** | Las extensiones que atienden. Se agregan y se sacan en caliente, sin cortar llamadas. | — |

**Las estrategias, en criollo**

| Estrategia | Qué hace | Cuándo usarla |
|---|---|---|
| Timbrar todos | Suena en todos los agentes libres a la vez. | Equipos chicos donde gana el más rápido. |
| **Round-robin con memoria** | Va rotando y **se acuerda** en quién quedó. | El reparto más justo. Es la que recomendamos. |
| Menos reciente | Al que hace más tiempo que no atiende. | Equilibrar carga. |
| Menos llamadas | Al que menos llamadas atendió. | Equilibrar por volumen. |
| Aleatoria / ponderada | Al azar (la ponderada respeta el peso del agente). | Cuando querés que los seniors reciban más. |
| Lineal | Siempre en el mismo orden, de arriba abajo. | Escalado: primero el junior, después el senior. |

#### Pestaña *Anuncios* — lo que escucha quien espera

Acá está la diferencia con otras centrales: **no se suben archivos de audio**. Escribís el texto,
elegís la voz, lo escuchás, y el sistema lo sintetiza y lo publica solo.

| Campo | Qué hace |
|---|---|
| **Bienvenida** | Lo primero que se escucha al entrar a la cola. |
| **Voz** | Qué voz lo dice (uruguaya masculina o femenina, entre otras). |
| **Anuncio periódico** | Un mensaje que se repite mientras espera ("seguimos con vos, en breve te atendemos"). |
| **Cada cuántos segundos** | Frecuencia del anuncio periódico. 30-45 s está bien; menos, molesta. |
| **Anunciar posición** | Le dice al que espera qué lugar ocupa en la fila. |
| **Anunciar espera estimada** | Le dice cuánto le falta, calculado con la espera real de los últimos minutos. |
| **Escuchar** | Reproduce el audio generado antes de guardarlo. |

#### Pestaña *Avanzado* — SLA y comportamiento fino

| Campo | Qué hace |
|---|---|
| **SLA objetivo (segundos)** | El **compromiso de atención**: cuántos segundos como máximo debería esperar una llamada antes de que la atienda una persona. |
| **Peso de la cola** | Prioridad entre colas cuando un agente está en varias. Más peso = esa cola le entra primero. |
| **Entrar sin agentes** | Si una llamada puede entrar a la cola cuando no hay ni un agente conectado. |
| **Salir si se quedan sin agentes** | Si las llamadas que ya están esperando se van cuando el último agente se desconecta. |
| **Timbrar a agentes ocupados** | Si suena en un agente que ya está hablando. Normalmente, no. |
| **Autofill** | Reparte varias llamadas en paralelo a varios agentes libres, en vez de una por vez. |
| **Pausa automática** | Pone en pausa al agente que dejó sonar sin atender, para que no siga rebotando llamadas. |

**El SLA objetivo, en detalle** (porque es el que más se malinterpreta)

- **Qué es**: el umbral en segundos de tu promesa de servicio. Con **SLA = 30**, tu promesa es
  "atendemos en menos de 30 segundos".
- **Qué hace el sistema con él**: no corta ni desvía nada. Lo usa para **medir**. Cada llamada
  atendida dentro del umbral cuenta como "dentro de SLA"; las que tardaron más, fuera. Ese
  porcentaje es el que ves en el **Wallboard** y en el panel de **Supervisor**, y es el número que
  se le muestra al cliente en una reunión de servicio.
- **Cómo se configura**: Aplicaciones → Colas → editar la cola → pestaña *Avanzado* → **SLA objetivo
  (s)**. Se guarda al presionar *Guardar* y aplica a las llamadas siguientes.
- **Qué valor poner**: 20 s en atención comercial (el que llama a comprar no espera), 30 s es el
  estándar de la industria (el famoso *80/30*: atender el 80 % de las llamadas en 30 segundos), 60 s
  en soporte técnico donde la gente tolera más.
- **Cómo se lee**: si tu cumplimiento de SLA está en 55 %, no te faltan minutos de agente: **te
  faltan agentes en la franja pico**. Cruzalo con la *Distribución horaria* del informe ejecutivo del
  historial y vas a ver exactamente en qué hora se rompe.

> **El proceso completo de armar una cola de agentes**, de punta a punta:
> 1. **Creá los usuarios agentes** (capítulo 17): usuario, rol *agente* e **extensión asignado**. Sin
>    extensión asignado, el agente entra al panel pero no puede atender.
> 2. **Creá la cola** con su extensión de acceso, la estrategia y el descanso.
> 3. **Agregá los agentes** a la cola (las extensiones del paso 1).
> 4. **Grabá los anuncios** por texto en la pestaña *Anuncios*.
> 5. **Fijá el SLA** en *Avanzado* y encendé la alerta **Cola sin agentes** (capítulo 14).
> 6. **Apuntá una ruta entrante** (capítulo 9) a la extensión de acceso de la cola: eso hace que las
>    llamadas del DID caigan directo en la fila.
> 7. **Mirá el Wallboard** el primer día: en espera, atendidas, abandonadas y cumplimiento de SLA.

![Editor de colas · Básico](img/cfg-06-cola-basico.png)

![Editor de colas · Anuncios](img/cfg-07-cola-anuncios.png)

![Editor de colas · Avanzado y SLA](img/cfg-08-cola-avanzado.png)

### 13.2 IVR

El menú de bienvenida ("marque 1 para ventas"). Se arma visualmente y los audios se generan por
texto, igual que en las colas.

![IVR](img/cfg-34-ivr.png)

### 13.3 Buzones de voz

Cada extensión ya tiene el suyo (`*97` para escucharlo). En **Aplicaciones → Buzones**, panel
*"Mensaje de voz al correo"*: cargás la dirección y cada mensaje nuevo llega por mail con **el audio
adjunto y la transcripción automática**.

![Buzón de voz al correo](img/cfg-09-buzon-email.png)

### 13.4 Conferencias, grupos de timbrado, paging y códigos

Salas de conferencia con PIN, grupos que suenan a la vez, voceo por parlantes, y los códigos de
función (`*97`, `*98`, etc.).

### 13.5 Aparcado de llamadas

» Menú lateral → Aplicaciones → Aparcado · Captura · MoH → **Aparcado**

Es el *"te la dejo en la 701"* de toda la vida. Sirve cuando atendés una llamada y hay que
buscar a alguien que no está en su escritorio: en vez de transferir a ciegas o dejar al que
llama esperando en tu teléfono, la **aparcás** y cualquiera la levanta desde cualquier interno.

**Cómo se usa (esto es lo que le explicás al usuario):**

1. Con la llamada en curso, hacés una **transferencia** al número de aparcado (por defecto
   el **700**).
2. Asterisk te dice en voz **en qué plaza quedó** (por ejemplo, "setecientos uno").
3. Avisás por el medio que sea: *"Juan, tenés una llamada en la 701"*.
4. Juan marca **701** desde cualquier teléfono y la toma.
5. Si nadie la levanta en el tiempo configurado, la llamada **vuelve a timbrar** donde estaba.

**Configuración:**

| Campo | Qué hace | Valor típico |
|---|---|---|
| **Número para aparcar** | A dónde se transfiere para aparcar | `700` |
| **Primera plaza** / **Última plaza** | El rango de casilleros disponibles | `701` a `720` (20 plazas) |
| **Tiempo de espera** | Cuánto aguanta antes de volver a timbrar | `300` s (5 min) |
| **Vuelve a quien la aparcó** | Si al vencer suena en el teléfono de quien la dejó | activado |

> **Elegí bien el rango.** Las plazas ocupan números reales del plan de marcado: si tus internos
> son 7xx, el rango 701–720 te los pisa. Cambialo a algo que no choque (por ejemplo 801–820).

**Ver qué hay aparcado.** El botón *Ver plazas ocupadas* abre una tabla con **todas** las plazas
del rango: cuáles están libres, quién está esperando en cada ocupada (nombre y número), quién la
aparcó y cuántos segundos faltan para que vuelva. Se refresca sola cada 5 segundos, así que sirve
para dejarla abierta en recepción.

> Después de cambiar cualquier valor hay que tocar **Aplicar en Asterisk**: guardar sólo lo
> anota en la base; aplicar es lo que recarga el motor.

![Tabla de plazas de aparcado con ocupadas y libres](img/cfg-13-aparcado.png)

### 13.6 Captura de llamada

» Menú lateral → Aplicaciones → Aparcado · Captura · MoH → **Captura**

Atender el teléfono que está sonando **en el escritorio de al lado**, sin levantarse. Hay dos
formas, y conviene enseñar las dos:

| Código | Qué hace | Cuándo se usa |
|---|---|---|
| **`*8`** | Atiende el teléfono que suena **en tu grupo** | El caso normal: alguien de tu sector no está y su teléfono suena |
| **`**<interno>`** | Atiende el de **ese interno** en concreto (ej. `**1001`) | Cuando sabés exactamente cuál querés tomar, aunque no sea de tu grupo |

**Los grupos.** Para que `*8` funcione, los internos que se cubren entre sí tienen que estar en
el **mismo grupo de captura**. Se asigna por interno desde esta pantalla, escribiendo un nombre
libre: `ventas`, `recepcion`, `soporte`. Un interno sin grupo no captura ni puede ser capturado
con `*8` (sí con `**`).

> **Es simétrico a propósito.** Al asignar un grupo, el panel configura tanto "a quién puedo
> capturar" como "quién me puede capturar". Es lo que espera la gente: si compartís el grupo,
> se cubren mutuamente. Si necesitás una relación en un solo sentido, es un caso raro que hoy
> no se cubre desde el panel.

### 13.7 Música en espera

» Menú lateral → Aplicaciones → Aparcado · Captura · MoH → **Música en espera**

Lo que escucha quien está en espera o en una cola. La central trae la música de fábrica
(clase `default`), y desde acá podés subir **la tuya**: la del cliente, una locución
institucional, o música distinta por sector.

**Una clase = una carpeta de audios.** Los archivos suenan en orden alfabético (o al azar, según
la clase). Para armar una:

1. Escribí el nombre y tocá **Nueva clase** (por ejemplo `ventas`).
2. Subí los audios con **Subir audio**. Formatos: `wav`, `gsm`, `ulaw`, `alaw`, `sln`, `g722`.
3. Tocá **Aplicar en Asterisk**.
4. Elegí esa clase en la cola o donde corresponda.

> **Sobre el formato.** Lo que mejor rinde es **WAV mono, 8 kHz, 16 bits**: es el formato nativo
> de la telefonía y no obliga a la central a convertir en cada llamada. Un MP3 estéreo de 44 kHz
> anda, pero le hace trabajar el procesador de más en cada persona en espera.

> **Derechos de autor.** La música comercial en espera necesita licencia. Es un problema legal
> real del cliente, no un detalle técnico: conviene usar música libre de regalías o una locución
> propia, y dejarlo por escrito.

La clase `default` es la de fábrica y no se toca desde el panel: si borrás una clase propia, se
borran también sus audios.

---

## 14. Alertas

» Menú lateral → Sistema → Configuración → Alertas

### 14.1 Para qué existe este módulo

Una central telefónica falla en silencio. La troncal se cae un domingo y te enterás el lunes cuando
un cliente se queja; alguien encuentra la contraseña de una extensión y te factura ocho mil pesos de
llamadas a Cuba antes de que abras el panel; la cola de ventas queda sin un solo agente en horario
pico y nadie lo nota. **El módulo de Alertas convierte esos silencios en un correo.**

No es un log ni un tablero que hay que mirar: es el sistema el que te busca a vos. Cada alerta tiene
un motivo de negocio detrás —seguridad, continuidad del servicio, antifraude o calidad de atención—
y llega redactada en castellano, con los datos que necesitás para decidir si tenés que hacer algo
ahora o puede esperar.

### 14.2 Cómo funciona por dentro

1. **Un motor que mira cada minuto.** La API revisa el estado de las troncales, los servicios, los
   registros SIP fallidos, las llamadas en curso y las colas. No consulta nada de afuera: usa lo que
   ya sabe de tu propia central.
2. **Agrupa en vez de inundar.** Si te están atacando desde cuarenta IPs, no recibís cuarenta
   correos: recibís **uno solo** con las cuarenta IPs adentro. Cada tipo de alerta tiene un tiempo
   mínimo entre avisos, así una troncal que parpadea no te llena la casilla.
3. **Avisa también cuando se arregla.** Las alertas de continuidad (troncales, servicios) mandan un
   correo verde de *recuperado* cuando la cosa vuelve a la normalidad. No te quedás con la duda.
4. **Cada correo tiene su estilo.** El color y el ícono cambian según el tipo: rojo para ataque,
   ámbar para antifraude, azul para acceso, verde para recuperación. Se reconoce de un vistazo desde
   el celular, sin abrirlo.
5. **Historial.** Todo lo que se disparó queda registrado en el panel, aunque el correo no haya
   salido.

> **Requisito**: las alertas viajan por correo, así que primero tiene que estar configurado el
> **Correo saliente** (capítulo 11). Sin eso, el motor detecta pero no puede avisar.

![Panel de alertas](img/cfg-11-alertas.png)

### 14.3 Los campos del panel

| Campo | Qué hace |
|---|---|
| **Destinatarios** | Una o más direcciones separadas por coma. Es a quién le llega todo. Poné una casilla que alguien mire de verdad, no `info@`. |
| **Interruptor de cada alerta** | Enciende o apaga ese tipo de aviso. Se guarda solo al tocarlo. |
| **Probar** | Manda ese correo con datos de ejemplo, **aunque la alerta esté apagada**. Sirve para validar el correo saliente y para ver cómo se va a ver. |
| **Resumen diario · hora** | A qué hora sale el correo de resumen (por defecto a la mañana). |
| **Historial** | Lista de las alertas disparadas, con fecha, tipo y detalle. |

### 14.4 Cada tipo de alerta, en detalle

**Seguridad**

| Alerta | Qué la dispara | Qué trae el correo | Qué hacer |
|---|---|---|---|
| **Estamos bajo ataque** | Ráfaga de registros SIP fallidos en poco tiempo (típico de un escaneo automatizado). | Cantidad de intentos, las IPs implicadas con país e ISP, y los usuarios que probaron. | Normalmente nada: el SBC y Fail2ban ya los están bloqueando. Si el ataque insiste desde un país donde no tenés clientes, bloqueá el país en el SBC. |
| **IP bloqueada** | El firewall metió una IP en la lista negra. | IP, país, ISP y motivo del bloqueo. | Nada, salvo que sea una IP tuya: entonces desbloqueala desde **Seguridad**. |
| **Inicio de sesión al panel** | Alguien entró al panel. Por defecto **solo avisa desde una IP nueva**, para no molestar con los ingresos de todos los días. | Usuario, rol, IP, país y navegador. | Si no reconocés el ingreso, cambiá esa contraseña ya. |
| **Intentos fallidos al panel** | Varias contraseñas erradas seguidas contra el panel. | Usuario probado, IP y cantidad. | Fuerza bruta contra el administrador: revisá que la contraseña sea fuerte. |

**Continuidad del servicio**

| Alerta | Qué la dispara | Qué trae el correo | Qué hacer |
|---|---|---|---|
| **Troncal caída / recuperada** | El registro contra el operador se perdió (o volvió). | Nombre de la troncal, operador, hace cuánto está caída. | Es la alerta que evita el "no entran llamadas y nadie sabe desde cuándo". Llamá al operador o revisá internet. |
| **Servicio caído** | Un componente del núcleo no responde (base de datos, Asterisk). | Qué servicio y desde cuándo. | Es grave: la central está degradada o muda. |

**Antifraude**

| Alerta | Qué la dispara | Qué trae el correo | Qué hacer |
|---|---|---|---|
| **Llamada muy larga** | Una llamada saliente supera el umbral configurado. | Extensión, destino, duración y hora. | Primer síntoma de fraude: una llamada abierta a un número premium que factura por minuto. |
| **Salientes fuera de horario** | Ráfaga de llamadas salientes de madrugada o fin de semana. | Cantidad, extensiones y destinos. | El patrón clásico de la extensión comprometido: nadie llama a las 4 de la mañana. |
| **Llamada internacional** | Se marcó un destino internacional. | Extensión, número y país. | Si tu empresa no llama al exterior, esta alerta sola paga el sistema. Cortá la ruta saliente internacional. |

**Operación y calidad**

| Alerta | Qué la dispara | Qué trae el correo | Qué hacer |
|---|---|---|---|
| **Cola sin agentes** | Una cola quedó sin ningún agente conectado en horario laboral. | Nombre de la cola y hace cuánto. | Las llamadas entran y nadie las atiende. Es la alerta que más plata salva en un call center chico. |
| **Resumen diario** | Todos los días a la hora que elijas. | Llamadas de ayer, atendidas y perdidas, minutos hablados, alertas del día, estado de troncales. | Leerlo con el café: si algo viene torcido, se ve en la tendencia antes de que sea un problema. |

> **Recomendación de arranque**: encendé todo lo de seguridad y continuidad, las tres de antifraude y
> el resumen diario. Es el conjunto que cubre lo que realmente duele. Ajustá los umbrales después de
> una semana, cuando sepas cómo es tu tráfico normal.

---

## 15. Grabaciones

» Menú lateral → Telefonía → Grabaciones

### 15.1 Cómo se graba

La grabación la hace Asterisk con **MixMonitor**: mezcla en un solo archivo lo que dicen las dos
partes de la llamada. Se puede activar de tres maneras, y no se pisan entre sí:

| Forma | Dónde se activa | Cuándo conviene |
|---|---|---|
| **Por extensión** | Telefonía → Extensiones → editar la extensión → *Grabar llamadas* | Un puesto puntual: recepción, la extensión del gerente, un agente en capacitación. |
| **Por cola** | Aplicaciones → Colas → pestaña *Básico* → *Grabar llamadas* | Lo habitual en un call center: se graba todo lo que entra por la cola, sin importar qué agente atienda. |
| **A demanda** | Botón de grabar en la llamada en vivo (panel y softphone) | Cuando el cliente empieza a decir algo que conviene tener guardado. Se puede arrancar y frenar en el medio de la llamada. |

Terminada la llamada, un indexador escribe la ficha en la base (extensión, origen, destino, fecha,
tamaño, duración) y la grabación aparece en el listado. **La ficha vive en PostgreSQL; el audio, en
el almacenamiento que elijas.**

### 15.2 Formato y cuánto pesa

Se graba en **WAV PCM 16 bits, 8 kHz, mono**, sin comprimir. Es el formato que produce Asterisk sin
transcodificar y el que abre cualquier reproductor, sin códecs raros ni licencias.

Ese formato pesa **16 kB por segundo**, independientemente del códec que usen los teléfonos:

| Duración | Tamaño del archivo |
|---|---|
| 1 minuto | ≈ 0,94 MB |
| 1 hora | ≈ 56 MB |
| 100 llamadas de 3 min | ≈ 280 MB |
| 8 h/día de una cola, 22 días | ≈ 10 GB por mes |

> **Ojo con el códec.** El códec (G.711, Opus, G.729) afecta el **ancho de banda de la llamada**, no
> el tamaño de la grabación: MixMonitor decodifica y guarda siempre en WAV. Una llamada por Opus a
> 24 kbps se graba igual de pesada que una por G.711. Si te importa el disco, lo que hay que decidir
> es **a quién grabás y cuánto tiempo lo guardás**, no qué códec usás.

### 15.3 ¿Se pueden descargar?

Sí. En el listado, cada grabación tiene:

- **Reproducir**: reproductor con forma de onda, dentro del panel, sin descargar nada.
- **Descargar**: baja el `.wav` original.
- **Transcribir**: pasa el audio por el motor de IA y te devuelve el texto de la conversación
  (requiere el módulo AI encendido).
- **Eliminar**: borra la grabación.

Las grabaciones también aparecen en **Historial de llamadas**, pegadas a su llamada: desde ahí se
escuchan sin salir del CDR.

![Grabaciones](img/cfg-12-grabaciones.png)

### 15.4 Dónde se guardan: local, NAS o S3

» Grabaciones → pestaña **Almacenamiento**

El audio siempre nace en el disco del servidor. Lo que se configura acá es **a dónde se lo lleva
después**.

| Destino | Cómo funciona | Cuándo usarlo |
|---|---|---|
| **Local** | Se queda en el volumen `recordings` del servidor. | Instalaciones chicas, o cuando el servidor ya tiene disco de sobra y respaldo. |
| **NAS** | Cada grabación se **copia** a una carpeta que vos montaste en el servidor (NFS, CIFS/Samba, un disco USB, lo que sea). Para el sistema es una carpeta más: no habla NFS, habla filesystem. | Ya tenés un NAS con respaldo y querés que las grabaciones vivan ahí. |
| **S3 / compatible** | Cada grabación se **sube por HTTPS** con firma AWS SigV4 al bucket. Funciona con AWS S3 y con cualquier compatible: MinIO, Wasabi, Backblaze B2. | Querés retención larga fuera del servidor, o el cliente exige que el audio no quede en la central. |

**Cómo lee el sistema una ruta remota**

- **NAS**: el sistema **no monta nada por vos**. Vos montás el recurso en el host (por ejemplo
  `/mnt/nas/grabaciones` vía `/etc/fstab`), lo exponés al contenedor, y en el panel ponés esa ruta.
  Si la ruta no existe o no tiene permiso de escritura, *Probar destino* te lo dice y no se sube
  nada: **nunca se borra el original si la copia falló**.
- **S3**: el sistema arma la URL del objeto según lo que cargues. Sin endpoint, va contra AWS
  (`https://<bucket>.s3.<región>.amazonaws.com/<prefijo><archivo>`). Con endpoint (MinIO, Wasabi),
  usa el formato *path-style* (`https://<endpoint>/<bucket>/<prefijo><archivo>`). La ficha en la
  base guarda la URL final, así el panel sabe de dónde traer el audio aunque ya no esté en el
  servidor.

**Los campos de la pestaña Almacenamiento**

| Campo | Qué hace |
|---|---|
| **Destino** | Local, NAS o S3. Cambia los campos de abajo. |
| **Ruta del NAS** | Carpeta ya montada en el servidor, por ejemplo `/mnt/nas/grabaciones`. Sólo con destino NAS. |
| **Endpoint** | Vacío = AWS. Para MinIO o Wasabi, la URL del servicio (`https://minio.tu-red:9000`). |
| **Región** | La región del bucket (`us-east-1` si no sabés). |
| **Bucket** | El bucket donde van los audios. Tiene que existir. |
| **Prefijo** | Carpeta virtual dentro del bucket (`recordings/`). Ayuda a ordenar y a aplicar reglas de retención del lado del proveedor. |
| **Access Key / Secret Key** | Las credenciales del bucket. La clave secreta se guarda cifrada y **nunca se vuelve a mostrar**: si el campo aparece con puntos, ya está cargada. |
| **Subir automáticamente** | Encendido, un barrido cada 2 minutos sube todo lo que quedó pendiente. Apagado, se sube sólo cuando tocás *Sincronizar ahora*. |
| **Conservar copia local** | Encendido, la grabación queda también en el servidor (más seguro, gasta disco). Apagado, se borra del servidor **después** de confirmar que la copia remota quedó bien. |
| **Probar destino** | Escribe un archivo de prueba en el NAS o el bucket y te dice si funcionó. Hacelo siempre antes de apagar *Conservar copia local*. |
| **Sincronizar ahora** | Fuerza la subida de todo lo pendiente. |

> **Cómo lo configuraría yo**: destino S3 con *Subir automáticamente* encendido y *Conservar copia
> local* encendido las primeras semanas. Cuando veas que el bucket se está llenando solo y sin
> errores, apagás la copia local y el disco del servidor deja de ser un problema.

---

## 16. Seguridad

» Menú lateral → Sistema → Seguridad

Además del SBC, el núcleo tiene **Fail2ban** sobre los registros SIP: quien intenta adivinar
contraseñas queda bloqueado. La sección **Seguridad** muestra las IPs bloqueadas con su país y
permite desbloquear o bloquear a mano.

![Seguridad](img/cfg-13-seguridad.png)

---

## 17. Usuarios y roles

» Menú lateral → Sistema → Usuarios

En **Usuarios**. Cada persona puede tener un **extensión asociado** — y eso es lo que habilita que su
softphone vea clientes e intercom.

| Rol | Qué puede hacer |
|---|---|
| **Administrador** | Todo |
| **Supervisor** | Monitorear colas y agentes, escuchar/susurrar/irrumpir, gestionar clientes |
| **Agente** | Su softphone, su historial y su buzón |

![Usuarios y roles](img/cfg-14-usuarios.png)

---

---

## 18. Clientes (CRM)

» Menú lateral → Operación → Clientes

### 18.1 Para qué existe

La central sabe **quién llama** (un número). El CRM le enseña **quién es** (una persona, una
empresa, un domicilio). Con eso, cuando entra una llamada, el agente ve la ficha **antes de
atender** — sabe con quién habla desde el "hola".

Es el mismo concepto que el identificador de llamadas del teléfono de tu casa, pero con la libreta
de la empresa adentro.

**Ejemplo real (un edificio con portería):** llama el `099123456`. El sistema lo reconoce como
*María Fernández, apartamento 302*, y le muestra al portero sus **personas autorizadas** (quién
puede entrar en su nombre) y sus **espacios** (garaje 12, baulera 7). El portero no busca nada:
la información le llega sola.

### 18.2 Qué guarda cada ficha

| Nivel | Qué es | Ejemplo |
|---|---|---|
| **Cliente** | La ficha principal | *María Fernández* · doc · dirección · notas |
| **Teléfonos** | Todos los números por los que puede llamar | `099123456`, `24001234` |
| **Personas autorizadas** | Quién puede actuar en su nombre, con vencimiento | *Juan Pérez (hijo), hasta 31/12* |
| **Espacios** | Lugares asociados | *Garaje 12*, *Baulera 7* |
| **Dispositivos** | Porteros y cámaras del cliente | *Portero principal* (ver Intercom) |

El reconocimiento se hace por el **teléfono**: cualquier número cargado en la ficha identifica al
cliente cuando llama.

![Libreta de clientes](img/cfg-37-clientes.png)

### 18.3 Encuesta post-llamada

» Clientes → Encuesta post-llamada

Se definen los campos que el agente completa **al cortar** (texto, opciones, obligatorio o no). Sirve
para tipificar: *motivo del llamado*, *resuelto sí/no*, *derivado a*. Los campos que definís acá son
los que le aparecen al agente en su panel cuando termina la llamada.

![Editor de la encuesta post-llamada](img/cfg-38-encuesta.png)

---

## 19. Qué ve el softphone del CRM (y qué no)

» Se aplica al softphone de escritorio, a la PWA y al panel del agente

Esta es una pregunta que conviene tener contestada **antes** de entregar teléfonos, porque define
qué información sale de la central hacia la computadora de cada persona.

### 19.1 El softphone solo ve el CRM si tiene sesión de plataforma

El teléfono y la plataforma son **dos accesos distintos**:

- **Registro SIP** (extensión + contraseña): le permite llamar y recibir llamadas. Nada más.
- **Sesión de plataforma** (usuario del panel): le permite ver directorio, clientes e intercom.

El enlace de acceso que mandás por correo trae **las dos cosas** — pero la segunda **solo si el
extensión tiene un usuario asociado** en *Usuarios*. Si no lo tiene, el teléfono funciona igual, pero
el softphone no muestra clientes ni intercom.

> **Consecuencia práctica:** si querés que un agente vea la ficha del cliente que lo llama, no
> alcanza con crearle la extensión. Hay que crearle **también el usuario** y asignarle esa extensión.

### 19.2 Qué puede hacer cada rol

| Acción | Agente | Supervisor | Administrador |
|---|---|---|---|
| Ver el directorio de extensiones | ✅ | ✅ | ✅ |
| Ver la ficha del cliente que lo llama | ✅ | ✅ | ✅ |
| Ver toda la libreta de clientes | ✅ | ✅ | ✅ |
| **Crear, editar o borrar clientes** | ❌ | ✅ | ✅ |
| **Editar personas autorizadas y espacios** | ❌ | ✅ | ✅ |
| **Definir la encuesta post-llamada** | ❌ | ✅ | ✅ |
| Responder la encuesta al cortar | ✅ | ✅ | ✅ |
| Ver las cámaras del intercom | ✅ | ✅ | ✅ |
| Escuchar / susurrar / irrumpir en llamadas ajenas | ❌ | ✅ | ✅ |

El agente **lee** el CRM porque lo necesita para atender; **no lo modifica**. Si un agente intenta
editar la libreta desde su softphone, la central le responde que no está autorizado.

### 19.3 Lo que el softphone nunca ve

Las grabaciones de llamadas ajenas, la configuración de la central, las troncales, la seguridad y
los datos de otros extensiones. El softphone es un teléfono con contexto, no una consola de
administración.

---

## 20. Intercom · porteros y cámaras

» Menú lateral → Telefonía → Intercom

### 20.1 Para qué existe

Un **portero** que llama a la extensión de recepción es una llamada como cualquier otra: se escucha,
pero no se ve. El módulo de Intercom agrega **el video**: cuando el portero del cliente llama, el
que atiende ve la cámara asociada, en vivo, dentro del mismo panel.

**Ejemplo:** llama el portero del edificio. En la pantalla del portero (la persona) aparece la ficha
del cliente **y la imagen de la cámara de entrada**, sin que tenga que abrir otra aplicación ni
recordar la IP de nada.

### 20.2 Cómo se arma

Los dispositivos se asocian a un **cliente** del CRM (por eso este capítulo va después del anterior).

| Campo | Qué es | Ejemplo |
|---|---|---|
| **Cliente** | A quién pertenece el dispositivo | *Edificio Rambla* |
| **Etiqueta** | Cómo se lo llama | *Portero principal* |
| **Tipo** | Portero o cámara | — |
| **URL RTSP** | El flujo de video del dispositivo | `rtsp://usuario:clave@192.168.1.50:554/Streaming/Channels/101` |

La URL RTSP la da el fabricante del portero o la cámara. Es la misma que usarías en un grabador de
video (NVR).

![Intercom: dispositivos por cliente](img/cfg-39-intercom.png)

### 20.3 Cómo llega el video al navegador

Un navegador **no puede reproducir RTSP**. Entre medio hay un traductor (go2rtc) que convierte el
flujo de la cámara a algo que el navegador entiende (WebRTC), en tiempo real y sin plugins.

Eso significa dos cosas prácticas:

- El módulo **intercom** tiene que estar activo (Configuración → Módulos).
- La central tiene que **alcanzar la cámara por la red**. Si la cámara está en la LAN del cliente y
  la central en otra red, no hay magia: hay que darle camino (VPN o publicación).

> **Las credenciales de la cámara viajan dentro de la URL RTSP.** Usá un usuario de solo lectura
> creado para esto, no el administrador de la cámara.

### 20.4 Probar que funciona

Al guardar el dispositivo, el panel intenta levantar el flujo. Si la cámara no responde, lo vas a
ver ahí mismo — no esperes a la primera llamada real para enterarte.

---

## 21. Historial de llamadas

» Menú lateral → Telefonía → Historial

Todas las llamadas de la central (el **CDR**): quién llamó, a quién, cuándo, cuánto duró y cómo
terminó (atendida, no contestada, ocupado). Se actualiza solo.

Es la fuente de verdad para las tres preguntas típicas: *"¿me llamaron?"*, *"¿cuánto habló con el
cliente?"* y *"¿por qué esa llamada no entró?"*.

| Estado | Qué significa |
|---|---|
| `ANSWERED` | Alguien atendió |
| `NO ANSWER` | Sonó y nadie atendió |
| `BUSY` | El destino estaba ocupado |
| `FAILED` / `CONGESTION` | No se pudo completar (problema de ruta u operador) |

> Si ves muchas `FAILED` hacia el mismo destino, el problema no es el usuario: es la ruta saliente o
> el operador. Miralo en **SBC → SIP debug**.

![Historial de llamadas (CDR)](img/cfg-40-historial.png)

---

## 22. Monitoreo en vivo, Wallboard y Mapa

### 22.1 Llamadas en vivo

» Menú lateral → Operación → Llamadas en vivo

Las llamadas que están ocurriendo **ahora**: quién habla con quién, hace cuánto. Desde acá el
supervisor puede **escuchar** (sin que lo sepan), **susurrar** (solo lo escucha el agente) o
**irrumpir** (los tres hablan). Es la herramienta de un jefe de call center, y es la razón principal
por la que existe el rol de supervisor.

![Llamadas en vivo](img/cfg-41-monitor.png)

### 22.2 Wallboard

» Menú lateral → Operación → Wallboard

La pantalla grande del call center: llamadas en espera, agentes conectados, tiempos. Está pensada
para dejarla en un televisor, no para mirarla de cerca.

![Wallboard](img/cfg-42-wallboard.png)

### 22.3 Mapa

» Menú lateral → Operación → Mapa

Ubica geográficamente las llamadas (cuando hay dato de posición, típicamente de Click-to-Call). Sirve
para ver de dónde te llaman.

### 22.4 Resumen

» Menú lateral → Operación → Resumen

La portada del panel: salud de los componentes, llamadas de hoy, lo que está pasando. Es la primera
pantalla que ves al entrar.

---

## 23. Topología

» Menú lateral → Telefonía → Topología

El dibujo en vivo de tu instalación: qué componentes hay, en qué IP vive cada uno, cómo se conectan
y **cuáles están sanos**. Un componente en rojo es un problema antes de que alguien lo reporte.

Es la pantalla que conviene abrir primero cuando algo "no anda" y no sabés por dónde empezar.

![Topología de la instalación](img/cfg-43-topologia.png)

### 23.1 Red del núcleo: modo router o switch

» Menú lateral → Infraestructura → **Red**

Define **cómo se para la central en la red del cliente**. Son dos formas de trabajar, y la
elección depende de la instalación, no del gusto:

| Modo | Qué hace | Cuándo usarlo |
|---|---|---|
| **Router** | Dos placas separadas: una **WAN** (hacia internet) y una **LAN** (hacia la red interna). Opcionalmente enmascara (NAT) y rutea entre ellas | La central **es** el router de esa red, o querés separar la red de telefonía del resto |
| **Switch** | Las placas se unen en un **puente** de capa 2. La central no rutea ni enmascara: queda como un equipo más de la red existente | Lo habitual: ya hay un router en la oficina y la central sólo se cuelga de esa red |

En modo **router** elegís qué placa es WAN y cuál LAN, y si querés **NAT** (enmascarar la LAN al
salir) y **ruteo entre placas**. En modo **switch** se unen al puente todas las placas marcadas
como LAN — hacen falta **al menos dos**.

**El flujo es en tres tiempos, y es así a propósito:**

1. **Ver el plan.** Antes de ejecutar nada, el panel muestra los comandos exactos que va a
   correr, cada uno con su explicación. Un cambio de red no se aplica a ciegas.
2. **Aplicar.** Se ejecutan los pasos en orden; si uno falla, se corta ahí y te dice cuál fue.
3. **Confirmar.** Al aplicar arranca un **reloj de 2 minutos**. Si confirmás, el modo queda
   fijo. Si **no** confirmás, la central vuelve sola al modo anterior.

> **Por qué ese tercer paso existe.** Cambiar el modo de red puede dejarte sin acceso al panel:
> si te comés justo la placa por la que estás entrando, perdés la sesión y ya no podés arreglar
> nada. El reloj es la red de seguridad: **si te quedaste afuera, no hagas nada** y esperá; la
> central se revierte sola y volvés a entrar como antes.

> **Consejo de campo:** hacé el cambio con la consola del hipervisor (Proxmox, iDRAC, lo que
> tengas) abierta al lado. Si algo sale mal, entrás por ahí sin depender de la red.

![Modo de red: router y switch, con el plan de cambios](img/cfg-44-red-modo.png)

---

## 24. Teléfonos físicos (aprovisionamiento)

» Menú lateral → Telefonía → Teléfonos

### 24.1 Para qué existe

Configurar un teléfono de escritorio a mano —entrar a su web, buscar la IP, cargar servidor, usuario
y contraseña— lleva diez minutos por aparato y se presta a errores de tipeo. El **aprovisionamiento**
lo hace solo: vos cargás la **dirección MAC** (viene en la etiqueta de abajo del teléfono) y le
asignás una extensión. Cuando el teléfono arranca, **pide su configuración a la central y se configura
solo**. Sirve para Yealink y Grandstream, que son los que respetan este mecanismo.

**Ejemplo real:** llegan 20 teléfonos nuevos. Cargás las 20 MAC con su extensión, los enchufás, y en
dos minutos están todos registrados. Sin tocar ninguno.

### 24.2 Cómo lo hace, por dentro

1. Vos das de alta el teléfono en el panel: **MAC + fabricante + extensión**.
2. La central genera, para esa MAC, un archivo de configuración con **el servidor SIP, la extensión y
   su contraseña**, ya armado con la sintaxis de ese fabricante.
3. El teléfono, al arrancar, **pide ese archivo por HTTP** a una URL que contiene su propia MAC.
4. La central lo reconoce por la MAC, le entrega su archivo, y anota la fecha de contacto
   (*Último contacto* en la tabla).
5. El teléfono se reinicia, se registra contra Asterisk, y queda operativo.

El nombre del archivo depende del fabricante — es el que cada teléfono pide por su cuenta:

| Fabricante | Archivo que pide | URL que hay que darle |
|---|---|---|
| **Yealink** | `<mac>.cfg` (12 dígitos, sin separadores) | `http://<central>/prov/` |
| **Grandstream** | `cfg<mac>.xml` | `http://<central>/prov/` |

> Cada fila de la tabla tiene un botón para **copiar la URL exacta** del archivo de ese teléfono. Si
> querés verificar que la central lo está sirviendo bien, pegala en el navegador: tenés que ver la
> configuración. Si dice `not provisioned`, la MAC no está cargada (o está mal escrita).

### 24.3 Cómo llega el teléfono hasta la central: **DHCP opción 66**

Falta responder una pregunta: **¿cómo sabe el teléfono a qué servidor pedirle su configuración?**
Hay dos caminos.

**A) A mano (uno por uno).** Entrás a la web del teléfono y cargás la URL del servidor de
aprovisionamiento. Funciona, pero volvimos a los diez minutos por aparato.

**B) Por DHCP — la opción 66.** Este es el camino bueno, y es la razón por la que 20 teléfonos se
configuran solos. Cuando un teléfono se enchufa, lo primero que hace es pedir IP por DHCP. En esa
misma respuesta, el servidor DHCP le puede mandar la **opción 66** (*TFTP server name* / *provisioning
server*), que es literalmente **la dirección del servidor de configuración**. El teléfono la toma y
va a buscar su archivo ahí. **Nunca tocás el teléfono: lo enchufás y listo.**

Se configura **una sola vez, en tu servidor DHCP** (el router, el MikroTik, el Windows Server):

| Servidor DHCP | Dónde se pone | Valor |
|---|---|---|
| **MikroTik** | IP → DHCP Server → Network → *Next Server* o una *DHCP Option* nueva (código 66, tipo texto) | `http://<IP-de-la-central>/prov/` |
| **Windows Server** | Ámbito DHCP → Opciones de ámbito → **066 Nombre de host del servidor de arranque** | `http://<IP-de-la-central>/prov/` |
| **pfSense / OPNsense** | Services → DHCP Server → *TFTP server* / opciones avanzadas | `http://<IP-de-la-central>/prov/` |
| **isc-dhcp / dnsmasq** | `option tftp-server-name "http://<IP>/prov/";` | ídem |

> **Dos advertencias que ahorran una tarde:**
> 1. La opción 66 vale **para toda la red**: si tenés otros equipos que la usan (teléfonos de otra
>    marca, decodificadores), coordiná. Algunos fabricantes prefieren la **opción 160** (Grandstream)
>    o la **66 con URL http**; los dos formatos conviven.
> 2. Los teléfonos **sólo leen la opción 66 al arrancar**. Si cambiás el DHCP, hay que **reiniciar los
>    teléfonos** (o hacerles un *factory reset* si ya venían configurados contra otro servidor).

### 24.4 Los campos del alta

| Campo | Qué hace | Ejemplo |
|---|---|---|
| **Dirección MAC** | Identifica al teléfono. Es lo que la central usa para saber qué configuración entregarle. Se acepta con o sin separadores. **No se puede cambiar después**: si te equivocaste, borrá y cargá de nuevo. | `805ec0aabbcc` |
| **Fabricante** | Yealink o Grandstream. Define la sintaxis del archivo y el nombre que el teléfono va a pedir. | Yealink |
| **Modelo** (opcional) | Sólo informativo, para que sepas qué hay en cada escritorio. | `T31P`, `GRP2601` |
| **Extensión** | La extensión SIP que va a usar ese teléfono. Tiene que existir en **Extensiones**. La contraseña la toma sola: no la tipeás. | `1004` |
| **Nombre a mostrar** | Lo que aparece en la pantalla del teléfono y en el CallerID interno. | `Recepción` |
| **Etiqueta de línea** | El texto al lado de la tecla de línea. | `Recepción IES` |
| **Último contacto** | Cuándo fue la última vez que ese teléfono pidió su configuración. **Es el mejor diagnóstico**: si está vacío, el teléfono nunca llegó a la central (revisá la opción 66 o la red). | hace 2 min |

**Arriba de la tabla** hay dos campos globales que aplican a todos los teléfonos:

| Campo | Qué hace |
|---|---|
| **Servidor SIP para los teléfonos** | La IP o el host que se inyecta en la configuración de cada teléfono para que se registren (UDP 5060, contra Asterisk). Normalmente es la IP interna de la central: los teléfonos de escritorio están en la LAN y no necesitan salir a internet. |
| **Puerto SIP** | 5060, salvo que lo hayas cambiado. |

![Aprovisionamiento por MAC](img/cfg-44-telefonos.png)

![Opción 66 en el servidor DHCP](img/cfg-46-dhcp-66.png)

---

## 25. IVR · el menú de bienvenida

» Menú lateral → Telefonía → IVR

### 25.1 Para qué existe

*"Marque 1 para ventas, 2 para soporte."* El IVR atiende, saluda y reparte la llamada según lo que
marque la persona.

### 25.2 Cómo se arma

Se diseña visualmente: un audio de bienvenida y, por cada dígito, un destino (extensión, cola, otro
IVR, buzón). **El audio se escribe como texto** y lo sintetiza la central con su propia voz — no hay
que grabar nada ni subir archivos.

| Dígito | Destino típico |
|---|---|
| 1 | Cola de Ventas |
| 2 | Cola de Soporte |
| 0 | Recepción (una extensión) |
| (nada) | Después de N segundos, repite o va a recepción |

> Dejá **siempre** una salida para el que no marca nada (una persona mayor, alguien desde un teléfono
> viejo). Un IVR sin salida es una llamada perdida.

![Diseñador de IVR](img/cfg-34-ivr.png)

---

## 26. IA & Voz

» Menú lateral → Telefonía → IA & Voz

El motor de voz de la central (módulo `ai`). Hace dos cosas:

**Sintetizar voz (TTS).** Convierte texto en audio con voz natural. Es lo que usan los anuncios de
las colas y el IVR: escribís, escuchás, guardás. Acá elegís **la voz** de la central y la probás.

**Transcribir (STT).** Convierte audio en texto. Es lo que transcribe los mensajes de voz y las
grabaciones.

> Es un módulo **opcional**: si no lo activás, las colas y el IVR siguen funcionando, pero tenés que
> subir los audios a mano y no hay transcripciones.

![Motor de voz: voces y pruebas](img/cfg-45-ia-voz.png)

---

## 27. Click-to-Call

» Menú lateral → Telefonía → Click-to-Call

Un enlace o un código QR que ponés en tu web o en un cartel, y que **llama a tu central desde el
navegador del cliente**, sin que instale nada y sin gastarle crédito.

**Ejemplo:** un QR en la vidriera. El cliente lo escanea, toca "llamar", y suena el teléfono de
ventas. Del otro lado ves de dónde salió la llamada.

![Click-to-Call: enlaces y QR](img/cfg-46-click-to-call.png)

---

## 28. Notificaciones push

» Menú lateral → Sistema → Notificaciones

Sirve para que **suene el celular con la app cerrada**. Sin esto, la app tiene que estar abierta para
recibir llamadas — que es exactamente lo que nadie hace.

Se configuran los proveedores (Web Push, y FCM/APNs para las apps nativas). Es configuración técnica:
se hace una vez, con las credenciales que da Google o Apple.

![Notificaciones push](img/cfg-47-push.png)

---

## 29. Dialplan

» Menú lateral → Sistema → Dialplan

El **plan de marcación**: las reglas que dicen qué pasa con cada número que se marca. La central lo
genera solo a partir de lo que configurás (colas, IVR, rutas), y acá lo ves tal cual lo ejecuta
Asterisk.

**No es una pantalla para configurar, es para entender.** Cuando una llamada hace algo raro, este es
el lugar donde se ve *exactamente* qué reglas se aplicaron y en qué orden.

> Tocar el dialplan a mano solo tiene sentido para casos que la interfaz no cubre. Si lo hacés, tené
> presente que lo que generan las colas y las rutas **se regenera** al guardarlas.

![Dialplan generado](img/cfg-48-dialplan.png)

---

## 30. Empresas (multi-tenant)

» Menú lateral → Sistema → Empresas

Solo tiene sentido si instalaste la central en **modo multi-tenant**: varias empresas conviviendo en
la misma central, cada una con sus extensiones, sus troncales y su marca, sin verse entre sí.

En modo **PBX simple** (el habitual, una sola empresa) esta sección existe pero no la vas a usar: hay
una única empresa por defecto.

![Empresas](img/cfg-49-empresas.png)

---

## 31. Base de datos

» Menú lateral → Sistema → Base de datos

PostgreSQL guarda **todo**: la configuración de la central (las extensiones, las colas y las rutas no
viven en archivos, viven acá), el historial de llamadas, las grabaciones indexadas y el CRM.

Esta pantalla muestra el estado y permite consultar. Es una herramienta de diagnóstico, no de
configuración diaria.

> **El respaldo de esta base es el respaldo de la central.** Si tenés que elegir una sola cosa para
> respaldar, es esta. Un `pg_dump` periódico te devuelve la central completa; sin él, no tenés nada.

![Base de datos](img/cfg-50-basedatos.png)

---

## 32. Los paneles de agente y supervisor

» Navegador → https://tu-dominio (cada rol entra a su panel automáticamente)

Este manual es el del panel de **administración**. Pero la central tiene otros dos paneles, con
propósitos distintos. Los describimos acá para que sepas qué le estás entregando a cada persona
cuando le creás el usuario.

### 32.1 Panel de Agente

Es la pantalla de quien atiende llamadas todo el día. Está pensada para eso y nada más: un teléfono
con contexto, sin distracciones de administración.

Qué tiene:

- **El softphone embebido**: marca, atiende, transfiere, retiene, con o sin video — todo dentro del
  navegador, sin instalar nada.
- **La ficha del cliente en llamada**: cuando entra una llamada de un número conocido, aparece **quién
  es** antes de atender (viene del CRM). Si es un cliente con portero, ve también sus personas
  autorizadas y sus espacios.
- **Mis llamadas**: su historial personal, con estado (contestada, saliente, perdida) y duración.
- **La encuesta de la llamada**: al cortar, completa los campos que definió el administrador (motivo,
  resuelto, derivado). Puede omitirla si no aplica.
- **Cambiar contraseña** y **salir**.

Lo que **no** ve: la configuración de la central, las troncales, la seguridad, las llamadas de otros.
Su mundo es su teléfono y sus clientes.

![Panel del agente](img/cfg-53-panel-agente.png)

### 32.2 Panel de Supervisor

Es la pantalla del jefe de call center. Tiene su propio softphone, pero su verdadera función es
**vigilar y ayudar**.

Qué tiene:

- **Colas en vivo**: cuántas llamadas esperan, cuántos agentes hay conectados, los tiempos.
- **Los agentes y su estado**: quién está en llamada, quién libre, quién en pausa.
- **Escuchar / Susurrar / Irrumpir** sobre cualquier llamada en curso:

| Acción | Qué pasa | Para qué |
|---|---|---|
| **Escuchar** | El supervisor oye la llamada; nadie lo sabe | Control de calidad, capacitación |
| **Susurrar** | El supervisor le habla **solo al agente**; el cliente no lo oye | Ayudar en vivo sin que el cliente se entere |
| **Irrumpir** | Los tres hablan | Tomar una llamada que se complica |

- **La libreta de clientes** (el CRM completo, con permiso de edición).

![Panel del supervisor](img/cfg-54-panel-supervisor.png)

> **Recordá:** para que una persona entre a estos paneles, hay que crearle el **usuario** con su rol
> en *Usuarios* y asignarle un **extensión**. El rol decide a qué panel cae; la extensión es su teléfono.


---

## 33. Manuales

» Menú lateral → Sistema → Manuales

Los tres manuales viajan **adentro de la central**: no hay que buscarlos en un drive ni pedirlos por
correo, y siguen estando cuando la instalación no tiene salida a Internet. La sección los muestra
como tres tarjetas — instalación, configuración y usuario — con a quién va dirigido cada uno.

La sección la ven **todos los roles**, no solo el administrador: si un agente entra a la plataforma,
tiene su manual a mano sin que se lo mandes.

| Botón | Qué hace |
|---|---|
| **Abrir manual** | Lo abre en una pestaña nueva, con índice navegable y la barra *Cómo llegar* en cada capítulo |
| **PDF** | Abre el manual y lanza el diálogo de impresión del navegador: elegí **Guardar como PDF** |
| **Markdown** | Baja el archivo `.md` original — el mismo que está en el repositorio |

El manual está maquetado para imprimirse en A4: portada, índice en su propia hoja, y ni las tablas ni
las imágenes se parten entre páginas.

> **Si el PDF te sale en blanco y negro y sin portada**, no es el manual: es el navegador. En el
> diálogo de impresión, entrá en *Más opciones* y activá **"Gráficos de fondo"**. Sin eso, Chrome y
> Edge descartan todos los fondos de color — y la portada es fondo de color.

La portada del PDF lleva la **versión del producto** y la **fecha de compilación**. Sirve: cuando le
mandás el manual a un cliente, queda dicho a qué versión corresponde lo que está leyendo.

### 32.1 Los recuadros "Imagen pendiente"

Donde todavía falta una captura, el manual muestra un recuadro punteado que dice **Imagen pendiente**
con la descripción de lo que va ahí y el **nombre exacto del archivo** (por ejemplo
`cfg-17-proxy.png`). No es una falla: es la lista de tareas, a la vista.

Para completar una: guardá la captura con ese nombre en `docs/manual/img/` del repositorio, corré
`python3 scripts/build-manuals.py` desde la raíz y volvé a desplegar el panel.

> Los manuales se compilan y se empaquetan **junto con el panel**. Editar el Markdown no cambia nada
> de lo que ves en pantalla hasta que recompiles y despliegues. Y una vez desplegado, hacé
> **Ctrl+F5**: el navegador cachea las imágenes y vas a jurar que no se actualizó nada.

![Sección Manuales del panel](img/cfg-36-manuales.png)
