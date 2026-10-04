#!/usr/bin/env bash
# ============================================================================
#  PBX-NG Softphone · trae el binario de go2rtc que viaja DENTRO del instalador.
#
#  Es el MISMO motor que corre en la central (alexxit/go2rtc), para que una camara
#  cargada a mano en el softphone se vea por el mismo camino que una de la central y no
#  haya un segundo reproductor que mantener.
#
#  Corre en CI antes de electron-builder. Idempotente: si el binario ya esta y es de la
#  version pedida, no baja nada.
#
#  POR QUE NO ESTA COMMITEADO: son 15 MB de binario de terceros por plataforma. En el repo
#  engordan cada clon para siempre y quedan sin forma de auditar de donde salieron; acá
#  queda la version escrita, el origen y el hash a la vista.
#
#  Uso: softphone-app/scripts/fetch-go2rtc.sh [--version=1.9.14] [--plat=win64]
# ============================================================================
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
DEST="$AQUI/../vendor/go2rtc"
VER="1.9.14"            # fijada a proposito: una app de escritorio no cambia de motor sola
PLAT="win64"
for a in "$@"; do case "$a" in --version=*) VER="${a#*=}";; --plat=*) PLAT="${a#*=}";; esac; done

case "$PLAT" in
  win64|win32|win_arm64) EXE="go2rtc.exe"; ZIP=1;;
  mac_amd64|mac_arm64)   EXE="go2rtc";     ZIP=1;;
  linux_amd64|linux_arm64) EXE="go2rtc";   ZIP=0;;
  *) echo "fetch-go2rtc: plataforma desconocida: $PLAT"; exit 1;;
esac

mkdir -p "$DEST"
SELLO="$DEST/.version"
if [[ -f "$DEST/$EXE" && -f "$SELLO" ]] && [[ "$(cat "$SELLO")" == "$VER-$PLAT" ]]; then
  echo "fetch-go2rtc: ya esta go2rtc $VER ($PLAT)"; exit 0
fi

BASE="https://github.com/AlexxIT/go2rtc/releases/download/v$VER"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if [[ "$ZIP" == "1" ]]; then
  echo "fetch-go2rtc: bajando go2rtc_$PLAT.zip ($VER)"
  curl -fL "$BASE/go2rtc_$PLAT.zip" -o "$TMP/g.zip"
  unzip -oq "$TMP/g.zip" -d "$TMP"
  [[ -f "$TMP/$EXE" ]] || { echo "fetch-go2rtc: el zip no trae $EXE"; exit 1; }
  mv "$TMP/$EXE" "$DEST/$EXE"
else
  echo "fetch-go2rtc: bajando go2rtc_$PLAT ($VER)"
  curl -fL "$BASE/go2rtc_$PLAT" -o "$DEST/$EXE.part" && mv "$DEST/$EXE.part" "$DEST/$EXE"
fi
chmod +x "$DEST/$EXE"
echo "$VER-$PLAT" > "$SELLO"
# El hash queda escrito al lado: es lo unico que permite decir despues QUE binario se metio
# en un instalador que ya se distribuyo.
( cd "$DEST" && sha256sum "$EXE" > "$EXE.sha256" 2>/dev/null || shasum -a 256 "$EXE" > "$EXE.sha256" )
echo "fetch-go2rtc: listo $(du -h "$DEST/$EXE" | cut -f1) · $(cut -c1-16 < "$DEST/$EXE.sha256")…"
