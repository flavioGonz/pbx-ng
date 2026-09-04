#!/usr/bin/env bash
# ============================================================================
#  PBX-NG · trae el ultimo instalador del softphone de escritorio (GitHub Release
#  softphone-vX.Y.Z) a control-plane/softphone/, para que viaje DENTRO de la imagen
#  api y cada central lo sirva en https://<central>/descargas/softphone/ (login + OTA).
#  Lo corre release.sh antes del build. Idempotente: si ya esta esa version, no baja.
#  Uso: docker/fetch-softphone.sh [--version=0.5.0]   (default: el ultimo release)
# ============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; DEST="$HERE/../control-plane/softphone"
REPO="flavioGonz/pbx-ng"; VER=""
for a in "$@"; do case "$a" in --version=*) VER="${a#*=}";; esac; done
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
echo "fetch-softphone: listo ($(du -h "$DEST/$file" | cut -f1))"
