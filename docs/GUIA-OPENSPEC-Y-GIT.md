# Guía: OpenSpec + git en PBX-NG

Para Mauricio y Fede. Explica cómo organizamos el trabajo ahora que somos más de uno en el
repo, y el mínimo de git que hace falta para no pisarnos.

---

## Por qué esto existe

Hasta ahora el «qué vamos a hacer y por qué» vivía en la conversación y en los mensajes de
commit. Con dos personas eso no alcanza: uno arranca algo, el otro no sabe que existe, y la
decisión que explica por qué está hecho así se pierde.

OpenSpec obliga a escribir tres cosas **antes** del código: la propuesta (por qué),
el contrato de comportamiento (qué tiene que hacer el sistema) y las tareas (en qué orden).
Quedan en el repo, versionadas, al lado del código que las cumple.

No es burocracia por deporte. El valor concreto: cuando alguien —persona o IA— toca el
código dentro de seis meses, la razón sigue ahí.

---

## Las cinco etapas

| Etapa | Qué se hace | Qué queda escrito |
|---|---|---|
| **explore** | Entender el problema y el código que lo rodea. Todavía no se decide nada. | Nada obligatorio |
| **propose** | Escribir la propuesta, el spec y las tareas | `openspec/changes/<nombre>/` |
| **apply** | Recién acá se escribe código, tachando tareas | El código + `tasks.md` al día |
| **verify** | Comprobar contra el spec, no contra la impresión de que anda | — |
| **archive** | El cambio terminado pasa al histórico y su spec se integra al oficial | `openspec/specs/` + `changes/archive/` |

La regla que más cuesta al principio y más sirve: **propose no escribe código**. Si en
medio de la propuesta aparecen ganas de arreglar algo, se anota como tarea.

---

## Cómo está armado acá

```
openspec/
├── config.yaml     ajustes del proyecto (acá: artefactos en español)
├── specs/          lo que el sistema YA hace, estable
└── changes/
    ├── <cambio>/   lo que está en curso
    └── archive/    lo terminado
```

Cada cambio en curso tiene cuatro piezas:

- `proposal.md` — por qué y qué cambia
- `specs/<capacidad>/spec.md` — el contrato: requisitos con escenarios `WHEN / THEN`
- `design.md` — el cómo, con las decisiones y lo que se descartó
- `tasks.md` — los pasos, en casillas para ir tachando

### El comando

La central no tiene Node y el disco está al 89 %, así que OpenSpec no se instaló en el
sistema: vive en `/opt/openspec` y corre dentro del contenedor `node:22-alpine` que ya
estaba. Hay un envoltorio en `/usr/local/bin/openspec`, así que se usa como cualquier
comando:

```bash
openspec list                                  # cambios en curso
openspec list --specs                          # capacidades ya especificadas
openspec show <cambio>                         # ver un cambio entero
openspec status --change <cambio>              # qué falta de las cuatro piezas
openspec validate <cambio> --strict            # ¿está bien formado?
openspec new change <nombre-en-kebab-case>     # arrancar uno nuevo
openspec archive <cambio>                      # cerrarlo cuando está hecho
```

En tu Windows, si querés tenerlo nativo: `npm install -g @fission-ai/openspec@latest`.

### Los comandos `/opsx:`

OpenSpec instaló en `.claude/` y `.agents/` los comandos `/opsx:explore`, `/opsx:propose`,
`/opsx:apply` y `/opsx:archive`. **Sólo existen dentro de un agente de código** — Claude
Code, Cursor, Copilot. En una conversación de Cowork no se tipean; ahí simplemente se pide
lo que se quiere y se sigue el mismo procedimiento a mano, que es lo que hicimos con el
primer cambio.

---

## El ejemplo que ya está en el repo

`openspec/changes/cerrar-build-softphone/` es un cambio real y completo. Vale leerlo entero
antes de escribir el primero propio: sale de algo que nos pasó de verdad —el instalador del
softphone se compila con un tag manual, nadie lo creó, y dos commits quedaron sin llegar a
la gente durante dos días mientras el actualizador informaba, con razón, que estaba al día.

Mirá en particular cómo está escrito el spec: dice **qué tiene que pasar**, no cómo se
programa. «Cuando llegan commits sin cambio de versión, entonces debe avisar que hay código
sin llegar a la gente» se puede verificar. «Agregar un if en el workflow» no.

---

## El mínimo de git

Son seis comandos. Con estos alcanza para trabajar de a dos.

```bash
git pull                              # traer lo que hizo el otro. SIEMPRE antes de empezar
git checkout -b arreglo-del-timbre    # abrir una rama propia
git add -A                            # marcar lo que cambiaste
git commit -m "mensaje"               # guardarlo con su explicación
git push -u origin arreglo-del-timbre # subir la rama
git checkout main                     # volver al tronco
```

### Cómo entra el trabajo

1. `git pull` en `main`
2. `git checkout -b <rama>` — una rama por cambio, con el nombre del cambio de OpenSpec
3. Trabajás y hacés commits ahí
4. `git push -u origin <rama>`
5. En GitHub, **Pull Request** hacia `main`. El otro lo mira y lo aprueba
6. Merge, y la rama se borra

Nadie pushea directo a `main`. No es desconfianza: es lo que hace que exista un momento en
el que alguien mira el cambio antes de que sea el código que se vende. Conviene dejarlo
puesto como regla en GitHub (Settings → Rules → Rulesets sobre `main`: requerir PR y
bloquear force push), así no depende de acordarse.

### El mensaje de commit

Lo que cuesta entender después no es qué cambió —eso lo muestra el diff— sino **por qué**.
Un mensaje bueno explica el problema; el código explica la solución.

```
El indexador no tomaba las grabaciones de cola

El patrón de nombre sólo aceptaba alfanuméricos, y el UNIQUEID de Asterisk trae
un punto. Medido: 252 WAV en disco contra 108 filas indexadas.
```

### Las tres situaciones que te van a pasar

**«Me pide hacer pull antes de pushear».** Alguien subió algo mientras trabajabas.
`git pull` y volvé a pushear.

**«Dice conflicto».** Los dos tocaron las mismas líneas. Git marca el archivo con
`<<<<<<<` y `>>>>>>>`; se elige qué queda, se borran las marcas, `git add` y `git commit`.
Si es en un archivo grande, mejor preguntá antes de resolverlo a ojo.

**«Hice un commit que no quería».** Si no lo pusheaste todavía,
`git reset --soft HEAD~1` lo deshace y te devuelve los cambios. Si ya lo pusheaste, no lo
borres del historial: hacé otro commit que lo corrija.

---

## Cómo se ve un cambio de principio a fin

```bash
git pull
git checkout -b cerrar-build-softphone

openspec new change cerrar-build-softphone   # crea la carpeta
# se escriben proposal.md, specs/, design.md y tasks.md
openspec validate cerrar-build-softphone --strict

git add -A
git commit -m "propuesta: cerrar el build automático del softphone"
git push -u origin cerrar-build-softphone
# -> Pull Request. El otro lee la propuesta ANTES de que exista el código.

# aprobada la propuesta, recién ahí:
# se implementan las tareas, tachando tasks.md a medida
# se verifica contra el spec
openspec archive cerrar-build-softphone
```

El corte importante está en el Pull Request de la propuesta. Discutir si algo vale la pena
cuesta cinco minutos cuando es un `proposal.md` y cuesta una semana cuando ya es código.

---

## Lo que no hay que hacer

- Empezar a programar y escribir la propuesta después para cumplir. El orden es el valor.
- Specs que nombran funciones o librerías. Eso va en `design.md`.
- Cambios enormes. Si `tasks.md` pasa de veinte casillas, probablemente son dos cambios.
- Dejar `tasks.md` sin tachar. Es lo único que dice por dónde va la cosa cuando alguien
  retoma el trabajo tres semanas después.
