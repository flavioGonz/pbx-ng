#!/usr/bin/env bash
# ============================================================================
#  PBX-NG · Política de secretos, en UN solo lugar.
#
#  POR QUÉ EXISTE ESTE ARCHIVO
#  ---------------------------
#  La lista de secretos por-deployment y la de valores de fábrica vivían dentro de
#  `install.sh`, y el camino de ACTUALIZACIÓN (`deploy.sh`) no las miraba. O sea: el
#  chequeo existía exactamente en el único momento en que el instalador acababa de
#  generar los secretos, y no en los cien arranques siguientes. Así sobrevive un secreto
#  de ejemplo: nadie lo pone a propósito, se hereda de un `.env` copiado a mano, de una
#  central clonada, o de un `.env.example` que alguien completó a medias.
#
#  Medido en una central en producción: `TURN_PASS` seguía siendo `pbxng-turn-changeme`
#  —el valor de fábrica— y `/api/ice` se lo estaba repartiendo a cada softphone. El
#  instalador nunca lo habría dejado pasar; el problema es que nadie lo volvió a mirar.
#
#  Lo comparten `install.sh` y `deploy.sh`. Si hay que agregar un secreto, se agrega acá
#  una vez y los dos caminos lo exigen.
# ==========================================================================

# Los SEIS secretos por-deployment: si dos centrales comparten uno de estos, el que
# entra a una entra a la otra. `install.sh` los genera; los dos caminos los exigen.
#   DB_PASS/JWT_SECRET/AMI_PASS/ARI_PASS · la central entera
#   TURN_PASS/TURN_CLI_PASS              · el relay de medios (se reparte por /api/ice)
PBXNG_SECRETOS="DB_PASS JWT_SECRET AMI_PASS ARI_PASS TURN_PASS TURN_CLI_PASS"

# ADMIN_DEFAULT_PASS se consume UNA sola vez: siembra el primer admin, que tiene que
# cambiarla al entrar. Se exige al INSTALAR (ahí sí importa que no sea `admin`) y no al
# actualizar: una central de hace seis meses ya no la tiene en el .env, y exigirla ahí
# convertiría este chequeo en algo que la gente aprende a saltear.
PBXNG_SECRETOS_ALTA="ADMIN_DEFAULT_PASS"

# Valores de fábrica, de ejemplo y de prueba. Un secreto igual a cualquiera de estos es
# lo mismo que no tener secreto: están escritos en el repo, que es público.
PBXNG_WEAK="cambia_esta_clave cambia_este_secreto_jwt changeme admin pbxng-turn-changeme pbxng-cli pbxng-turn-cli x test testpass pbxng secret password 123456 build"

# Valor de una clave en un .env (vacío si no está).
pbxng_env_get(){ grep "^$1=" "${2:-.env}" 2>/dev/null | head -1 | cut -d= -f2-; }

# ¿Este secreto está ausente, vacío o es uno de fábrica?  0 = hay que arreglarlo.
pbxng_secreto_flojo(){
  local v w; v="$(pbxng_env_get "$1" "${2:-.env}")"
  [ -z "$v" ] && return 0
  for w in $PBXNG_WEAK; do [ "$v" = "$w" ] && return 0; done
  return 1
}

# Corta si alguno no sirve. $1 = archivo .env (def: .env); $2 = `instalacion` para exigir
# además los de alta. Imprime TODOS los que fallan, no sólo el primero: si hay que editar
# el .env, que sea una sola vez.
pbxng_preflight_secrets(){
  local f="${1:-.env}" modo="${2:-}" lista="$PBXNG_SECRETOS" k malos=""
  [ "$modo" = "instalacion" ] && lista="$lista $PBXNG_SECRETOS_ALTA"
  for k in $lista; do pbxng_secreto_flojo "$k" "$f" && malos="$malos $k"; done
  if [ -n "$malos" ]; then
    printf '\033[1;31m  ✗ Secretos ausentes, vacíos o de fábrica:%s\033[0m\n' "$malos" >&2
    printf '\033[1;31m    Abortado. Generalos con ./install.sh (no edites %s a mano),\033[0m\n' "$f" >&2
    printf '\033[1;31m    o escribí uno propio por cada uno: openssl rand -hex 16\033[0m\n' >&2
    return 1
  fi
  printf '\033[1;32m  ✓ Los %s secretos por-deployment son propios de esta central\033[0m\n' "$(echo $lista | wc -w)"
  return 0
}
