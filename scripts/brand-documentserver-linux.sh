#!/usr/bin/env bash
# Replace the ONLYOFFICE logo inside the editor header with the BMO logo and
# hide the editor's "About" button, on a Linux (rpm/deb) Document Server.
#
# Why a script and not a config setting: customization.logo and the About
# button are licence-gated in Community Edition, so the config is ignored and
# the files have to be swapped on disk. AGPL permits this; keep the licence
# and source-offer intact (we do not remove either).
#
# Re-run this after EVERY Document Server upgrade — the rpm restores its own
# files. Original files are backed up next to the replacements (.orig).
#
# Usage:  sudo bash scripts/brand-documentserver-linux.sh /path/to/bmo-logo.svg
set -euo pipefail

LOGO_SRC="${1:-}"
DS_ROOT=/var/www/onlyoffice/documentserver
IMG_DIR="$DS_ROOT/web-apps/apps/common/main/resources/img/header"
CSS="$DS_ROOT/web-apps/apps/documenteditor/main/resources/css/app.css"

[ -n "$LOGO_SRC" ] || { echo "Usage: $0 <bmo-logo.svg>"; exit 1; }
[ -f "$LOGO_SRC" ]  || { echo "ERROR: logo file not found: $LOGO_SRC"; exit 1; }
[ -d "$IMG_DIR" ]   || { echo "ERROR: Document Server not found at $DS_ROOT"; exit 1; }

for f in header-logo_s.svg dark-logo_s.svg; do
  [ -f "$IMG_DIR/$f.orig" ] || cp -p "$IMG_DIR/$f" "$IMG_DIR/$f.orig"
  install -m 0440 -o ds -g ds "$LOGO_SRC" "$IMG_DIR/$f"
  echo "replaced $f"
done

# Hide the About button (licence-gated in CE, so customization.about is ignored)
if ! grep -q "riskgpt-hide-about" "$CSS" 2>/dev/null; then
  [ -f "$CSS.orig" ] || cp -p "$CSS" "$CSS.orig"
  chmod u+w "$CSS"
  printf '\n/* riskgpt-hide-about */\n#left-btn-about{display:none !important}\n' >> "$CSS"
  chmod 0440 "$CSS"
  echo "hid About button"
fi

# Document Server caches assets behind a version hash; a restart regenerates it
systemctl restart ds-docservice ds-converter nginx
echo "OK — restarted Document Server. Hard-refresh the browser (Ctrl+Shift+R)."
