#!/usr/bin/env bash
# ============================================================================
#  PBX-NG · trae el ultimo instalador del softphone de escritorio (GitHub Release
#  softphone-vX.Y.Z) para que la central lo sirva en https://<central>/descargas/softphone/
#  (el boton del login y el feed OTA). Idempotente: si ya esta esa version, no baja.
#
#  DOS DESTINOS, Y HAY QUE ELEGIR BIEN:
#
#    control-plane/softphone/   (default) viaja DENTRO de la imagen api. Lo usa release.sh
#                               antes del build.
#    docker/softphone/          la carpeta del host que docker-compose MONTA sobre
#                               /app/softphone. El montaje TAPA lo que traiga la imagen,
#                               asi que en una central levantada con compose es esta la
#                               que manda, este o no horneado el instalador.
#
#  Por eso un clon nuevo del repo no muestra los botones de descarga en el login: los
#  instaladores son binarios y no se versionan, `docker/softphone/` nace vacia, el montaje
#  tapa cualquier cosa que tenga la imagen, y /api/softphone/latest contesta que no hay
#  nada. No esta roto: falta bajarlo una vez.
#
#  Uso: docker/fetch-softphone.sh [--version=0.5.0] [--dest=docker/softphone]
#       (default: el ultimo release, a control-plane/softphone/)
#
#  En un clon nuevo que se levanta con compose:  docker/fetch-softphone.sh --dest=docker/softphone
# ============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; RAIZ="$(cd "$HERE/.." && pwd)"
DEST="$RAIZ/control-plane/softphone"
REPO="flavioGonz/pbx-ng"; VER=""
for a in "$@"; do case "$a" in
  --version=*) VER="${a#*=}";;
  # Un destino relativo se resuelve contra la RAIZ del repo, no contra el directorio desde
  # el que se invoco: asi `--dest=docker/softphone` significa lo mismo se corra desde donde
  # se corra, que es como lo va a escribir cualquiera que lea el comentario de arriba.
  --dest=*) d="${a#*=}"; case "$d" in /*) DEST="$d";; *) DEST="$RAIZ/$d";; esac;;
esac; done
BASE="https://github.com/$REPO/releases/$( [[ -n "$VER" ]] && echo "download/softphone-v$VER" || echo "latest/download" )"
mkdir -p "$DEST"
if ! curl -fsSL "$BASE/latest.yml" -o "$DEST/latest.yml.new"; then
  echo "fetch-softphone: no hay release del softphone en $BASE (se sigue sin instalador)"; rm -f "$DEST/latest.yml.new"; exit 0
fi
file="$(grep -E '^path:' "$DEST/latest.yml.new" | head -1 | sed 's/^path:[[:space:]]*//' | tr -d "'\"\r")"
ver="$(grep -E '^version:' "$DEST/latest.yml.new" | head -1 | sed 's/^version:[[:space:]]*//' | tr -d "\r")"
[[ -n "$file" ]] || { echo "fetch-softphone: latest.yml sin 'path'"; rm -f "$DEST/latest.yml.new"; exit 1; }
if [[ -f "$DEST/$file" && -f "$DEST/latest.yml" ]] && cmp -s "$DEST/latest.yml" "$DEST/latest.yml.new"; then
  echo "fetch-softphone: ya esta la version $ver ($file)"; rm -f "$DEST/latest.yml.new"; exit 0
fi
echo "fetch-softphone: bajando softphone $ver -> $file"
# GitHub publica los assets con los espacios como puntos; electron-builder los referencia igual en latest.yml
enc="$(printf '%s' "$file" | sed 's/ /./g')"
curl -fL "$BASE/$enc" -o "$DEST/$file.part" && mv "$DEST/$file.part" "$DEST/$file"
curl -fsL "$BASE/$enc.blockmap" -o "$DEST/$file.blockmap" || echo "fetch-softphone: sin blockmap (la actualizacion sera completa, no diferencial)"
# limpiar versiones viejas
find "$DEST" -maxdepth 1 -type f \( -name '*.exe' -o -name '*.blockmap' -o -name '*.msi' \) ! -name "$file" ! -name "$file.blockmap" -delete
mv "$DEST/latest.yml.new" "$DEST/latest.yml"
echo "fetch-softphone: listo ($(du -h "$DEST/$file" | cut -f1)) en $DEST"
# El APK de Android se firma y se publica aparte, asi que no esta en este release: si la
# central tiene que ofrecerlo tambien, el .apk se deja a mano en la misma carpeta.
ls "$DEST"/*.apk >/dev/null 2>&1 || echo "fetch-softphone: sin APK de Android en $DEST (se publica aparte; el boton de Android no va a aparecer)"
