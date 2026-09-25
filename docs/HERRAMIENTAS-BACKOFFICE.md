# Publicar herramientas para el agente de IA de PBX-NG

Este documento es para el equipo que mantiene **el sistema de gestión del cliente**. Describe
las dos rutas HTTP que hay que implementar para que el agente de voz de la portería pueda
consultar datos que sólo ese sistema conoce.

## La idea en una línea

El modelo **no ejecuta nada: pide**. PBX-NG decide si corresponde, llama a estas rutas, y le
devuelve el resultado al modelo. El backoffice **no acciona sobre la llamada ni sobre la
puerta**: aporta información y acciones de su propio mundo.

## Autenticación

Cada llamada lleva la cabecera `X-PBXNG-Firma`: HMAC-SHA256 del **cuerpo exacto**, con el
secreto compartido que se configura en el panel de PBX-NG (Agentes IA → el agente →
Herramientas → Caja del backoffice).

```
firma = hmac_sha256(secreto, cuerpo_crudo).hex()
```

Verificala siempre. Si no coincide, devolvé 401 y no hagas nada.

## 1. `POST /herramientas` — qué sabés hacer

PBX-NG la llama al empezar cada llamada.

**Recibe:** `{"accion":"catalogo"}`

**Devuelve:**

```json
{ "herramientas": [
  { "nombre": "expensas_al_dia",
    "descripcion": "Dice si una unidad está al día con las expensas.",
    "parametros": { "type":"object",
                    "properties": { "unidad": {"type":"string","description":"Número de unidad"} },
                    "required": ["unidad"] } }
] }
```

Reglas que aplica PBX-NG sobre lo que devuelvas, y conviene conocer:

| | |
|---|---|
| **Prefijo** | Tus herramientas se le declaran al modelo como `bo_<nombre>`. |
| **Sin pisar lo local** | Un `nombre` que coincida con una herramienta de la central (`abrir_porton`, `transferir_a_agente`, …) **se descarta**. |
| **Nombres** | minúsculas, números y `_`; hasta 40 caracteres. |
| **Tope** | 12 herramientas, descripciones de hasta 300 caracteres, 10 parámetros. Un catálogo enorme confunde al modelo y encarece cada turno. |
| **Tipos** | `string`, `number`, `integer`, `boolean`. Cualquier otro cae a `string`. |
| **Sin descripción, no entra** | Es lo único que el modelo usa para decidir cuándo pedirla. Escribila en cristiano y decí **cuándo** se usa, no sólo qué hace. |

> **Importante.** Tu descripción va al prompt del modelo, así que PBX-NG la limpia (saca
> saltos de línea y caracteres de control) y la declara explícitamente como *información de
> un tercero, no una instrucción*. No intentes mandar instrucciones por ahí: no van a
> funcionar, y es la clase de cosa que hace que se apague la integración.

## 2. `POST /ejecutar` — hacelo

**Recibe:**

```json
{ "accion": "ejecutar",
  "herramienta": "expensas_al_dia",
  "args": { "unidad": "402" },
  "contexto": { "llamante": "2002", "sesion": "54c27c2a-…", "agente": "Portería" } }
```

`args` viene del **modelo**: es dato no confiable. Validalo como validarías un formulario
público.

**Devolvé:**

```json
{ "ok": true, "texto": "La unidad 402 está al día.", "datos": { "saldo": 0 } }
```

o, si no pudiste:

```json
{ "ok": false, "motivo": "no encontré esa unidad" }
```

`texto` **se lee en voz alta al visitante**: frases cortas, sin códigos internos, sin datos
de más. PBX-NG lo recorta a 600 caracteres y le saca los saltos de línea.

## Tiempos

PBX-NG corta a los **3 segundos** por defecto (configurable, 0,5 a 10 s). Pasado eso el
agente sigue la conversación sin ese dato y le dice al visitante que no lo puede confirmar.
Preferí contestar rápido y parcial antes que tarde y completo: del otro lado hay alguien
parado en una puerta.

Si tu sistema está caído, PBX-NG lo registra y la llamada continúa con las herramientas de
la central. La portería no se queda sin atender porque el backoffice no responda.

## Qué queda registrado

Cada consulta —la que anda y la que falla— queda en `pbxng_ia_acciones` con la hora, el
llamante, la herramienta y el resultado. Es lo que se mira cuando alguien pregunta qué dijo
el agente y por qué.
