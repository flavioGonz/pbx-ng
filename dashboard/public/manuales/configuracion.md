# Manual de Configuración

> **Para quién es este manual**
> Para el administrador de la central: la persona que la pone en marcha, conecta las troncales,
> crea los internos y decide cómo entran y salen las llamadas. Se lee en orden la primera vez, y
> después se usa como referencia por sección.

---

## 1. Qué es PBX-NG

### 1.1 No es una central: es el director de orquesta

PBX-NG **no reemplaza** a las piezas clásicas de la telefonía IP: las **coordina**. Debajo del capó
corren tres motores libres, cada uno excelente en lo suyo y ninguno pensado para conversar con el
otro. PBX-NG es la capa que los hace trabajar juntos, y la única cara que ves.

| Motor | Qué resuelve | Qué NO hace |
|---|---|---|
| **Asterisk 22** | Las llamadas: dialplan, colas, IVR, buzón, grabación, conferencias | No sabe defenderse de Internet ni hablar con navegadores |
| **Kamailio** (el SBC) | El borde: seguridad SIP, enrutamiento por operador, ocultamiento de topología | No procesa llamadas ni maneja audio |
| **rtpengine** | El audio: ancla los medios, resuelve NAT, cifra y traduce | No entiende de señalización |
| **coturn** | STUN y TURN: que un teléfono detrás de cualquier NAT tenga audio | No es una central |
| **go2rtc** | Traduce el video RTSP de porteros y cámaras a WebRTC | Solo video |
| **PostgreSQL** | La memoria: configuración, llamadas, grabaciones, CRM | — |

Y por encima de todos, el **control-plane** de PBX-NG: el panel que ves, la API, las alertas, el CRM
y los correos. Es quien traduce "creá una cola de ventas" en las decenas de líneas de configuración
que cada motor necesita.

### 1.2 Cómo se hablan entre sí

El recorrido de **una llamada que entra desde la calle** cuenta la historia mejor que cualquier
diagrama:

1. El operador manda la llamada a tu IP pública. **La recibe el SBC (Kamailio)**, no Asterisk.
2. El SBC decide si es legítima (¿viene del operador o de un robot?), le esconde la topología
   interna, y la manda al Asterisk que corresponde (*dispatcher*).
3. **El audio no lo toca Asterisk**: queda anclado en **rtpengine**, en el borde. Por eso el núcleo
   nunca queda expuesto.
4. **Asterisk** hace lo suyo: mira el dialplan, decide si va a un interno, una cola o un IVR, graba
   si corresponde, deja el mensaje en el buzón si nadie atiende.
5. Si el que atiende es un **softphone WebRTC**, el navegador negocia el audio con **coturn**, que le
   da un camino aunque esté detrás del NAT de su casa.
6. Todo lo que pasó queda en **PostgreSQL**: el registro de la llamada, la grabación, la encuesta.
7. Y el **control-plane** lo muestra en el panel, y te manda un correo si algo salió mal.

![Cómo se comunican los componentes](img/inst-01-arquitectura.svg)

### 1.3 Qué implica esto para vos

- **Cada motor se puede prender y apagar** (Configuración → Módulos). Sin SBC, la central sigue
  andando en una LAN; sin TURN, los softphones remotos se quedan sin audio; sin el motor de IA, hay
  que subir los audios a mano.
- **Cada motor tiene su panel de diagnóstico** en PBX-NG. Cuando algo falla, la pregunta correcta es
  *"¿qué motor falló?"*, y este manual te lleva a la pantalla de ese motor.
- **No hay que configurar Asterisk ni Kamailio a mano.** El panel genera su configuración. Si editás
  archivos por debajo, el panel los va a sobrescribir la próxima vez que guardes algo.


---

## 2. Orden de puesta en marcha

Este es el recorrido completo. Si lo seguís en este orden, cada paso se apoya en el anterior y no
vas a tener que volver atrás.

| # | Paso | Dónde | Por qué va acá |
|---|---|---|---|
| 0 | **Entrar al panel** | `https://tu-dominio` · usuario `admin` | La contraseña la imprimió el instalador; el sistema te obliga a cambiarla |
| 1 | Módulos activos | Configuración → Módulos | Define qué contenedores existen |
| 2 | Dominio y certificado | Configuración → Proxy / TLS | Sin TLS no hay softphone web |
| 3 | Componentes (IPs) | Configuración → Componentes | El panel necesita saber dónde vive cada pieza |
| 4 | Marca | Configuración → Branding | Aparece en el panel y en los correos |
| 5 | **SBC** | SBC-NG | El borde: seguridad, operadores, medios |
| 6 | Troncal | Troncales | La línea con el mundo |
| 7 | Rutas salientes | Rutas → Salientes | Qué se marca y por dónde sale |
| 8 | Rutas entrantes | Rutas → Entrantes | Qué pasa cuando te llaman |
| 9 | Internos | Internos | Las personas |
| 10 | Correo | Configuración → Email | Sin esto no hay QR, ni buzón por mail, ni alertas |
| 11 | Entrega de teléfonos | Internos → Enviar acceso | El QR y el enlace |
| 12 | Aplicaciones | Aplicaciones | Colas, IVR, buzones, conferencias |
| 13 | Alertas | Configuración → Alertas | Que la central te avise a vos |


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

> **Esta es la advertencia más importante de todo el despliegue.**
>
> **Sin un dominio con certificado SSL válido, los internos WebRTC no funcionan.** Ninguno. Ni el
> softphone del navegador, ni el del celular, ni el de escritorio en modo WebRTC.
>
> No es un capricho nuestro: los navegadores **prohíben** el acceso al micrófono y el WebSocket
> seguro (`wss://`) fuera de un origen seguro (HTTPS con certificado válido). Un certificado
> autofirmado tampoco alcanza.

**Qué pasa si instalás sin dominio:** la central funciona, pero **solo con teléfonos SIP** — los de
escritorio, los ATA, las bocinas IP y el softphone en modo SIP nativo dentro de la red. Perdés todo
lo que hace atractiva a la central: el softphone web, el celular, el teletrabajo, el QR de acceso, el
click-to-call.

| Con dominio + SSL | Sin dominio |
|---|---|
| Internos WebRTC (navegador, celular, escritorio) | ❌ |
| Teletrabajo sin VPN | ❌ |
| Acceso por QR / enlace | ❌ (el enlace apunta a la nada) |
| Click-to-Call | ❌ |
| Teléfonos SIP en la LAN | ✅ |
| Troncales SIP | ✅ |

**Por eso, en un despliegue nuevo, el orden correcto es**: dominio → certificado → resto. No dejes el
dominio "para después": vas a tener que rehacer la configuración de los teléfonos.

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
| **Administración** | Administrador | Configurar la central: internos, troncales, rutas, colas, seguridad. Es este manual. |
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
| `30000-40000` | UDP | Audio de las troncales (rtpengine) |

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

## 5. SBC-NG · el borde de la central

» Menú lateral → Telefonía → SBC-NG

Esta es la sección más importante del sistema, y la que menos se entiende. Vale la pena leerla
entera **antes** de conectar la primera troncal.

### 5.1 ¿Qué es el SBC y por qué existe?

Un **SBC** (Session Border Controller) es un guardián que se para entre Internet y tu central.
Asterisk sabe manejar llamadas, pero no está pensado para estar desnudo frente a Internet: en
cuestión de horas empieza a recibir miles de intentos de registro de robots buscando internos con
contraseñas débiles.

El SBC hace cinco cosas que Asterisk no debería hacer solo:

1. **Escudo.** Filtra, limita y bloquea antes de que el tráfico llegue a la central.
2. **Ocultamiento de topología.** El operador y los atacantes ven al SBC, nunca a tu Asterisk. Las
   IPs internas no salen a la luz.
3. **Enrutamiento por operador (LCR).** Elige por qué proveedor sale cada llamada, con failover si
   uno se cae.
4. **Traducción SIP.** Cada operador pide las cosas a su manera; el SBC reescribe las cabeceras
   para que la llamada sea aceptada.
5. **Anclaje de medios.** El audio pasa por el SBC (rtpengine), no directo a Asterisk: eso resuelve
   NAT y evita exponer los puertos RTP del núcleo.

> **Regla práctica:** si la central está expuesta a Internet, el SBC **no es opcional**. Es la
> diferencia entre una central que dura años y una que te vacían la cuenta un fin de semana.

![SBC-NG · panel principal](img/cfg-19-sbc-inicio.png)

### 5.2 Monitoreo

» SBC-NG → Monitoreo

La pantalla de entrada del SBC. Muestra en vivo:

| Indicador | Qué te dice |
|---|---|
| **Uptime** | Hace cuánto que el SBC está levantado (si se reinicia solo, hay un problema) |
| **Requests SIP / s** | El pulso del borde. Un pico sin llamadas = ataque |
| **Sesiones de medios** | Cuántas llamadas tienen el audio anclado ahora mismo |
| **IPs bloqueadas** | Cuántos atacantes están en la lista negra |
| **Conexiones TCP** | Registros por TCP/TLS activos |
| **Memoria compartida** | Salud interna del SBC |

![SBC · Monitoreo](img/cfg-20-sbc-monitoreo.png)

### 5.3 Seguridad

» SBC-NG → Seguridad

Tres mecanismos, y conviene entender la diferencia porque se complementan:

**Anti-flood (pike).** Automático. Si una IP manda paquetes SIP a un ritmo anormal, se la corta en
el acto. Es la defensa contra la inundación.

**IPs bloqueadas (ipban).** La lista negra dinámica: quien falla el registro varias veces cae acá.
El panel muestra **la IP, su país (con bandera) y el ISP**, y permite desbloquear, bloquear a mano,
o **bloquear el país entero** de un clic — si nunca vas a recibir llamadas legítimas desde ese
país, no hay razón para dejarlo tocar el timbre.

**Lista de bloqueo SIP (secfilter).** Filtro por contenido: bloquea *user-agents* de escaneo
conocidos (`friendly-scanner`, `sipvicious`), usuarios que se prueban a mansalva (`100`, `admin`,
`test`) o países en la cabecera. Es la defensa quirúrgica.

![SBC · Seguridad e IPs bloqueadas](img/cfg-21-sbc-seguridad.png)

### 5.4 Ruteo → Operadores (LCR)

» SBC-NG → Ruteo → Operadores

Acá se define **por dónde sale cada llamada**.

**Un operador** se carga con:

| Campo | Qué es | Ejemplo |
|---|---|---|
| **Dirección** | Host y puerto del proveedor | `sip.operador.com:5060` |
| **Strip** | Cuántos dígitos sacarle al número marcado | `1` (para quitar el 0 de salida) |
| **Prefijo** | Qué agregarle antes de mandarlo | `598` |
| **Descripción** | Para que se entienda en la lista | `Antel SIP` |

**Una regla** dice: "lo que empieza con este prefijo, mandalo a estos operadores, en este orden".
Si el primero no responde, la llamada **se va sola al siguiente** (failover). Ahí está la gracia:
podés tener el operador barato primero y el confiable de respaldo.

> El SBC sondea a los operadores con **OPTIONS** constantemente. Un operador caído se saltea antes
> de intentar la llamada, no después de que el cliente escuchó silencio.

![SBC · Operadores y reglas LCR](img/cfg-22-sbc-lcr.png)

### 5.5 Ruteo → Manipulación SIP

» SBC-NG → Ruteo → Manipulación SIP

**El problema.** Cada operador quiere las cabeceras SIP a su manera. Uno exige el número de origen en
`P-Asserted-Identity`; otro lo lee de `From`; otro rechaza la llamada si ve un `Remote-Party-ID`.
Cuando el operador dice *"me llegan las llamadas sin identificar"* o *"rechazadas 403"*, casi siempre
se arregla acá.

**El principio.** Por defecto **no hay ninguna manipulación**: el SBC manda el SIP tal cual. Eso es a
propósito — una regla de más rompe llamadas que funcionaban. Se agrega solo lo que el operador exija.

#### Las 7 acciones disponibles

| Acción | Qué hace | Cuándo la vas a necesitar |
|---|---|---|
| **Quitar header** | Elimina una cabecera de la llamada saliente | El operador rechaza una cabecera que no entiende |
| **Agregar header** | Inserta una cabecera con un valor fijo | El operador exige una cabecera propietaria |
| **Modificar (regex)** | Busca un patrón dentro de una cabecera y lo reemplaza | Arreglar un formato de número |
| **Forzar From-user** | Reemplaza el usuario del `From` por un valor fijo | El operador exige que el `From` sea **tu número de cuenta**, no el del interno |
| **P-Asserted-Identity** | Agrega `P-Asserted-Identity` con el número de origen | El operador toma de ahí el identificador del llamante |
| **P-Preferred-Identity** | Igual, pero con `P-Preferred-Identity` | Algunos operadores usan esta y no la anterior |
| **Diversion** | Agrega la cabecera `Diversion` | Desvíos: el operador necesita saber que la llamada fue redirigida |

#### Las cabeceras que se tocan habitualmente

| Cabecera | Para qué la usa el operador | Nota |
|---|---|---|
| `From` | El identificador "público" de quien llama | Muchos operadores exigen que sea tu cuenta SIP |
| `P-Asserted-Identity` (PAI) | Identidad **verificada** por la red | La más pedida en Uruguay y la región |
| `P-Preferred-Identity` (PPI) | Identidad **sugerida** por el cliente | El operador decide si la respeta |
| `Remote-Party-ID` (RPID) | Identidad, cabecera **antigua** | Muchos operadores la **rechazan**: conviene quitarla |
| `Diversion` | Indica que la llamada viene desviada | Necesaria para desvíos y buzones remotos |
| `Contact` | Dónde contestar | La reescribe el SBC solo (ocultamiento de topología) |
| `Allow` | Qué métodos soporta el equipo | Se puede quitar; algunos operadores prefieren no verla |
| `User-Agent` | Qué software sos | Se quita para no revelar la versión |
| `Privacy` | Llamada anónima | Va junto con PAI cuando se oculta el número |

#### Variables que podés usar en el valor

| Variable | Qué contiene |
|---|---|
| `$fU` | El **usuario del From**: el número del interno que llama |
| `$rU` | El usuario del destino (a quién se llama) |
| `$si` | La IP de origen |
| texto fijo | Lo que escribas tal cual (por ejemplo, tu número de cuenta) |

**Ejemplo real.** El operador te da la cuenta `59824001234` y exige que **todas** las llamadas salgan
identificadas con ella, sin importar qué interno llame:

| Acción | Valor |
|---|---|
| Forzar From-user | `59824001234` |
| P-Asserted-Identity | `59824001234` |
| Quitar header | `Remote-Party-ID` |

#### El botón "Generar reglas compatibles"

Carga una **librería de reglas comunes** de una sola vez. Vienen **desactivadas**, salvo la única que
es 100% segura (quitar `Remote-Party-ID`). La idea es que no tengas que escribirlas: las activás una
por una según lo que tu operador pida, y probás.

> **Cómo se prueba una regla:** activás **una sola**, hacés una llamada, y mirás en
> **SBC → SIP debug** qué salió realmente. Cambiar tres reglas juntas y llamar es la forma más rápida
> de no entender nada.

![SBC · Manipulación SIP](img/cfg-23-sbc-manipulacion.png)

### 5.6 Ruteo → Dispatcher

» SBC-NG → Ruteo → Dispatcher

El **dispatcher** es lo que el SBC usa para saber **hacia qué Asterisk mandar las llamadas que
entran**. Podés tener más de uno, con **prioridad**: el de mayor prioridad recibe todo, y si deja
de responder, el SBC pasa al siguiente. Es alta disponibilidad del núcleo.

El SBC mide la latencia de cada destino con OPTIONS automáticamente.

> **Ojo con el sentido:** el dispatcher cubre lo que **entra** hacia el núcleo. Lo que **sale**
> (Asterisk → operador) se resuelve con las reglas de LCR de la sección anterior. Son dos caminos
> distintos y se configuran por separado.

![SBC · Dispatcher](img/cfg-24-sbc-dispatcher.png)

### 5.7 Ruteo → Remotos

» SBC-NG → Ruteo → Remotos

**Qué es.** La lista, en vivo, de los internos que **no están en la oficina**: el que trabaja desde
su casa, el vendedor con el softphone en el celular, la sucursal chica sin central propia. Todos
esos no se registran directo contra el Asterisk — se registran **a través del SBC**, que es el único
que da la cara a Internet.

**Por qué existe esta pantalla.** Porque un interno remoto es el punto más frágil de la central, y
el que más preguntas genera:

- *"¿Está conectado o no?"* Acá lo ves, con la hora del último registro.
- *"¿Desde dónde se conecta?"* Muestra la **IP de origen**. Si el teleworker de Montevideo aparece
  conectándose desde otro país, tenés un problema de seguridad — y esta es la pantalla donde se ve.
- *"¿Por qué no le entran las llamadas?"* Si el interno no figura acá, no está registrado: no es un
  problema de rutas ni del operador, es que el teléfono no llegó a la central.

**Ejemplo de uso real.** Un vendedor dice que "el teléfono no le suena". Antes de revisar colas,
rutas y troncales, mirás Remotos: si su interno no está en la lista, el diagnóstico terminó ahí —
su softphone no está registrado (se quedó sin internet, cerró la app, o se le venció el acceso). Si
**sí** está en la lista, entonces el problema es aguas abajo y seguís buscando.

> **La diferencia con "Internos" del menú principal:** aquella pantalla lista **todos** los internos
> que existen (la configuración). Esta lista solo los que están **registrados desde afuera, ahora**
> (la realidad). Una es el padrón; la otra, quién vino a votar.

![SBC · Extensiones remotas](img/cfg-25-sbc-remotos.png)

### 5.8 Red y Media → Red

» SBC-NG → Red y Media → Red

El SBC puede tener **varias salidas a Internet** (multi-WAN). Acá ves las interfaces, la **tabla de
ruteo del kernel en vivo**, y podés agregar **rutas estáticas** — por ejemplo: "el tráfico hacia la
red del operador sale por la WAN 2".

![SBC · Red y multi-WAN](img/cfg-26-sbc-red.png)

### 5.9 Red y Media → rtpengine

» SBC-NG → Red y Media → rtpengine

**rtpengine es por donde pasa el audio.** El SBC ancla los medios: la llamada entra por él y sale
por él, y así el Asterisk nunca queda expuesto ni tiene que pelear con el NAT.

Acá se ve el estado del motor, las sesiones activas, y se configura el rango de puertos y la IP
que se anuncia. **Ese rango de puertos tiene que estar abierto en el firewall** (`30000-40000/UDP`
por defecto): si no, la llamada conecta pero nadie escucha nada.

![SBC · rtpengine](img/cfg-27-sbc-rtpengine.png)

### 5.10 Red y Media → SIP debug

» SBC-NG → Red y Media → SIP debug

La herramienta de diagnóstico. Muestra el **diálogo SIP como una escalera** (quién le dijo qué a
quién, en orden), permite **capturar el tráfico** en un archivo `.pcap` para abrirlo con Wireshark,
y reproducir el audio de la captura.

Cuando el operador dice "el problema es de ustedes", acá está la prueba de qué mandó cada uno.

![SBC · Diálogo SIP y captura](img/cfg-28-sbc-sipdebug.png)

### 5.11 TURN

» SBC-NG → TURN

El TURN (coturn) es lo que hace que un softphone **detrás de cualquier NAT** tenga audio. Acá se
configuran el *realm*, los puertos, el rango de relay y las credenciales.

Y hay un **diagnóstico ICE en vivo**: el panel levanta una conexión real desde tu navegador y te
dice si el TURN está **alcanzable y autenticado** (candidato *relay*), o si falla y por qué. El
verde no es decorativo: significa que funciona de verdad.

![SBC · TURN y diagnóstico ICE](img/cfg-29-sbc-turn.png)

### 5.12 Sistema → Módulos y Configuración

» SBC-NG → Sistema → Módulos  /  SBC-NG → Sistema → Configuración

**Módulos**: qué módulos de Kamailio están cargados.
**Configuración**: el archivo de configuración del SBC, para verlo o editarlo cuando hace falta algo
que la interfaz no cubre. Es la puerta de escape; usala con cuidado.

---

## 6. Asterisk · el núcleo

» Menú lateral → Telefonía → Asterisk

La consola de Asterisk (**Asterisk** en el menú) es la ventana al motor de llamadas:

| Pestaña | Qué muestra |
|---|---|
| **Núcleo** | Versión, uptime, llamadas activas, canales |
| **Internos** | Estado real de cada endpoint (registrado, en llamada, no alcanzable) |
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

» Menú lateral → Telefonía → SBC-NG → Troncales

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
| **Destino** | Interno, cola, IVR, buzón o conferencia |

**Ejemplo:** el `24001234` (línea principal) va al **IVR** de bienvenida; el `24001299` (ventas
directo) va a la **cola de Ventas**.

> Si una llamada entrante "no llega a ningún lado", el 90% de las veces es que **falta la ruta
> entrante** para ese DID, o que el operador te está mandando el número en otro formato del que
> cargaste (con o sin el código de país). Miralo en **SBC → SIP debug**.

![Rutas entrantes](img/cfg-05-rutas.png)

---

## 10. Internos

» Menú lateral → Telefonía → Internos

### 10.1 Crear un interno

En **Internos → Nuevo**. Lo mínimo es el número y el nombre. Cada interno nace con su contraseña
SIP generada y su **buzón de voz activado** (PIN inicial = su número).

![Alta de un interno](img/cfg-02-nuevo-interno.png)

### 10.2 ¿WebRTC o SIP?

Es la decisión más importante del alta y define qué recibe el usuario en su enlace.

| | **WebRTC** | **SIP clásico** |
|---|---|---|
| Para qué | Softphone en navegador, celular o escritorio | Teléfonos de escritorio, ATAs, bocinas IP |
| Cómo viaja | Cifrado (DTLS-SRTP) sobre WebSocket, puerto 443 | SIP sobre UDP/TCP/TLS |
| Detrás de NAT | Anda sin abrir nada (usa TURN) | Requiere red preparada |
| Cuándo | **Por defecto**, para personas | Para **hardware** |

> **No los mezcles.** Un interno WebRTC registrado en modo SIP **autentica pero se queda sin
> audio**: el endpoint exige cifrado. Es una confusión clásica y difícil de diagnosticar. El enlace
> de acceso ya viene con el modo correcto según el interno.

![Tipo de interno](img/cfg-15-tipo-interno.png)

### 10.3 Teléfonos físicos

En **Teléfonos** se aprovisionan por MAC (Yealink, Grandstream): el teléfono baja su configuración
solo al arrancar.

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

» Menú lateral → Telefonía → Internos → (elegir el interno) → Enviar acceso por correo

Este es el proceso que reemplaza al "te paso la contraseña por WhatsApp".

### 12.1 Cómo se manda

En **Internos**, sobre el interno, botón **Enviar acceso por correo**. Escribís la dirección de la
persona y listo.

### 12.2 Qué recibe la persona

Un correo con **un código QR** y **un enlace**. Con cualquiera de los dos, su teléfono queda
configurado solo.

![Correo de acceso con el QR](img/cfg-03-email-acceso.png)

### 12.3 Qué lleva adentro el enlace

Es importante que sepas qué estás mandando, porque explica por qué funciona sin que el usuario
configure nada:

- El **transporte correcto según el interno**: si es WebRTC, va con el servidor WebSocket y las
  credenciales del TURN; si es SIP, va con el servidor SIP, el puerto y el transporte. **El sistema
  lo deduce del endpoint real**, no lo asume.
- El **interno y su contraseña**.
- La **sesión en la plataforma** (si el interno tiene un usuario asociado): así la persona ve el
  directorio, la ficha de los clientes y el intercom sin volver a loguearse.

### 12.4 Reglas del enlace

- **Vence en 24 horas.** Si expira, se genera uno nuevo.
- **Sirve para los tres clientes**: navegador, celular (agregar a la pantalla de inicio) y app de
  escritorio (botón QR → "Pegar código").
- Se puede reenviar las veces que haga falta.

> **Para que el usuario vea clientes e intercom**, el interno tiene que tener un **usuario asociado**
> en **Usuarios** (con su rol). Si no lo tiene, el enlace configura el teléfono igual, pero sin
> sesión en la plataforma.

![Enviar acceso desde el panel](img/cfg-33-enviar-acceso.png)

---

## 13. Aplicaciones

» Menú lateral → Telefonía → Aplicaciones

### 13.1 Colas

En **Aplicaciones → Colas → Nueva cola**. Tres pestañas.

**Básico:**

| Campo | Recomendación |
|---|---|
| Estrategia | *Round-robin con memoria* reparte parejo |
| Timbrado del agente | 20-25 segundos |
| **Descanso del agente** | **Al menos 10 s**; en 0 el agente se quema |
| Capacidad máxima | 0 = sin límite |
| Espera máxima + destino | Buzón o interno de respaldo |

![Editor de colas · Básico](img/cfg-06-cola-basico.png)

**Anuncios:** acá está la diferencia con otras centrales — **no se suben archivos de audio**.
Escribís el texto, elegís la voz, lo escuchás, y el sistema lo sintetiza y lo publica solo.

![Editor de colas · Anuncios](img/cfg-07-cola-anuncios.png)

**Avanzado:** qué hacer si no hay agentes, SLA objetivo, pausa automática al que no atiende.

### 13.2 IVR

El menú de bienvenida ("marque 1 para ventas"). Se arma visualmente y los audios se generan por
texto, igual que en las colas.

![IVR](img/cfg-34-ivr.png)

### 13.3 Buzones de voz

Cada interno ya tiene el suyo (`*97` para escucharlo). En **Aplicaciones → Buzones**, panel
*"Mensaje de voz al correo"*: cargás la dirección y cada mensaje nuevo llega por mail con **el audio
adjunto y la transcripción automática**.

![Buzón de voz al correo](img/cfg-09-buzon-email.png)

### 13.4 Conferencias, grupos de timbrado, paging y códigos

Salas de conferencia con PIN, grupos que suenan a la vez, voceo por parlantes, y los códigos de
función (`*97`, `*98`, etc.).

---

## 14. Alertas

» Menú lateral → Sistema → Configuración → Alertas

En **Configuración → Alertas**. Cargá el destinatario y encendé lo que quieras. Cada alerta tiene un
botón de **prueba** que manda el correo sin necesidad de activarla.

| Alerta | Cuándo llega |
|---|---|
| **Estamos bajo ataque** | Ráfaga de registros fallidos. Llega **una** alerta agrupada, no una por IP |
| IP bloqueada | El firewall bloqueó una IP (con país e ISP) |
| Inicio de sesión al panel | Por defecto, **solo desde una IP nueva** |
| Intentos fallidos al panel | Posible fuerza bruta |
| **Troncal caída / recuperada** | Se cortó (o volvió) la línea |
| Servicio caído | Base de datos o Asterisk sin conexión |
| Cola sin agentes | En horario laboral no hay quien atienda |
| Llamada muy larga | Primer síntoma de fraude telefónico |
| Salientes fuera de horario | El patrón clásico: ráfaga de madrugada |
| Llamada internacional | Destinos que no deberían marcarse |
| Resumen diario | Un correo a la mañana con lo de ayer |

![Panel de alertas](img/cfg-11-alertas.png)

---

## 15. Grabaciones

» Menú lateral → Telefonía → Grabaciones

Se graba por interno, por cola o todo. Se escuchan desde **Grabaciones**, con reproductor y
**transcripción por IA** a pedido.

> El disco crece rápido: alrededor de **0,5 MB por minuto** grabado. Hacé la cuenta antes.

![Grabaciones](img/cfg-12-grabaciones.png)

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

En **Usuarios**. Cada persona puede tener un **interno asociado** — y eso es lo que habilita que su
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

- **Registro SIP** (interno + contraseña): le permite llamar y recibir llamadas. Nada más.
- **Sesión de plataforma** (usuario del panel): le permite ver directorio, clientes e intercom.

El enlace de acceso que mandás por correo trae **las dos cosas** — pero la segunda **solo si el
interno tiene un usuario asociado** en *Usuarios*. Si no lo tiene, el teléfono funciona igual, pero
el softphone no muestra clientes ni intercom.

> **Consecuencia práctica:** si querés que un agente vea la ficha del cliente que lo llama, no
> alcanza con crearle el interno. Hay que crearle **también el usuario** y asignarle ese interno.

### 19.2 Qué puede hacer cada rol

| Acción | Agente | Supervisor | Administrador |
|---|---|---|---|
| Ver el directorio de internos | ✅ | ✅ | ✅ |
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
los datos de otros internos. El softphone es un teléfono con contexto, no una consola de
administración.

---

## 20. Intercom · porteros y cámaras

» Menú lateral → Telefonía → Intercom

### 20.1 Para qué existe

Un **portero** que llama al interno de recepción es una llamada como cualquier otra: se escucha,
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

---

## 24. Teléfonos físicos (aprovisionamiento)

» Menú lateral → Telefonía → Teléfonos

### 24.1 Para qué existe

Configurar un teléfono de escritorio a mano —entrar a su web, cargar servidor, usuario, contraseña—
lleva diez minutos por aparato y se presta a errores. El **aprovisionamiento** lo hace solo: cargás
la **dirección MAC** (viene en una etiqueta abajo del teléfono) y le asignás un interno. Cuando el
teléfono arranca, pide su configuración a la central y se configura solo.

Sirve para Yealink y Grandstream, que son los que respetan este mecanismo.

**Ejemplo:** llegan 20 teléfonos nuevos. Cargás las 20 MAC con su interno, los enchufás, y en dos
minutos están todos registrados. Sin tocar ninguno.

![Aprovisionamiento por MAC](img/cfg-44-telefonos.png)

---

## 25. IVR · el menú de bienvenida

» Menú lateral → Telefonía → IVR

### 25.1 Para qué existe

*"Marque 1 para ventas, 2 para soporte."* El IVR atiende, saluda y reparte la llamada según lo que
marque la persona.

### 25.2 Cómo se arma

Se diseña visualmente: un audio de bienvenida y, por cada dígito, un destino (interno, cola, otro
IVR, buzón). **El audio se escribe como texto** y lo sintetiza la central con su propia voz — no hay
que grabar nada ni subir archivos.

| Dígito | Destino típico |
|---|---|
| 1 | Cola de Ventas |
| 2 | Cola de Soporte |
| 0 | Recepción (un interno) |
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
la misma central, cada una con sus internos, sus troncales y su marca, sin verse entre sí.

En modo **PBX simple** (el habitual, una sola empresa) esta sección existe pero no la vas a usar: hay
una única empresa por defecto.

![Empresas](img/cfg-49-empresas.png)

---

## 31. Base de datos

» Menú lateral → Sistema → Base de datos

PostgreSQL guarda **todo**: la configuración de la central (los internos, las colas y las rutas no
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
> en *Usuarios* y asignarle un **interno**. El rol decide a qué panel cae; el interno es su teléfono.


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
