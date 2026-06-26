#!/bin/bash
# ============================================================
#  PBX-NG · sincroniza el código vivo al repo, sanea secretos,
#  commitea y pushea a GitHub (flavioGonz/pbx-ng).
#  Uso:  bash scripts/sync-and-push.sh "mensaje de commit"
# ============================================================
set -e
REPO=/opt/pbxng-repo
MSG="${1:-update}"
EXC="--exclude-dir=.git --exclude-dir=scripts --exclude-dir=node_modules --exclude-dir=.next"
command -v rsync >/dev/null 2>&1 || apt-get install -y rsync >/dev/null 2>&1 || true

# --- control plane (API) ---
mkdir -p $REPO/control-plane/ai
cp -f /opt/pbxng-api/app.js /opt/pbxng-api/ai-pipeline.js /opt/pbxng-api/push-providers.js $REPO/control-plane/ 2>/dev/null || true
cp -f /opt/pbxng-api/package.json /opt/pbxng-api/package-lock.json $REPO/control-plane/ 2>/dev/null || true
cp -f /opt/pbxng-api/ai/vosk_stt.py $REPO/control-plane/ai/ 2>/dev/null || true

# --- dashboard (sin node_modules/.next) ---
rsync -a --delete --exclude node_modules --exclude .next /opt/pbxng-dashboard/app/ $REPO/dashboard/app/ 2>/dev/null || cp -rf /opt/pbxng-dashboard/app/* $REPO/dashboard/app/
[ -d /opt/pbxng-dashboard/public ] && rsync -a --delete /opt/pbxng-dashboard/public/ $REPO/dashboard/public/ 2>/dev/null || true
cp -f /opt/pbxng-dashboard/package.json /opt/pbxng-dashboard/next.config.js $REPO/dashboard/ 2>/dev/null || true

# --- sanear secretos (NUNCA versionar credenciales reales); excluye scripts/ ---
grep -rlE "pbxng_db_2026|AriPbx#2026|AmiPbx#2026|TurnPbx#2026|ibJE_l34snyDSYb1adKtJ56UNskLUc_4DoTgVz3K2NQ|pbxng-jwt-secret-2026-cambialo" $REPO $EXC 2>/dev/null | while read f; do
  sed -i "s/pbxng-jwt-secret-2026-cambialo/__SET_JWT_SECRET__/g; s|ibJE_l34snyDSYb1adKtJ56UNskLUc_4DoTgVz3K2NQ|__SET_VAPID_PRIVATE__|g; s/pbxng_db_2026/__SET_DB_PASS__/g; s/AriPbx#2026/__SET_ARI_PASS__/g; s/AmiPbx#2026/__SET_AMI_PASS__/g; s/TurnPbx#2026/__SET_TURN_SECRET__/g" "$f"
done

# --- GUARD: abortar si quedó algún secreto (excluye scripts/) ---
if grep -rqE "pbxng_db_2026|AriPbx#2026|AmiPbx#2026|TurnPbx#2026|ibJE_l34snyDSYb1adKtJ|pbxng-jwt-secret-2026-cambialo" $REPO $EXC 2>/dev/null; then
  echo "ABORT: se detecto un secreto sin sanear. No se hace commit."; exit 1
fi

# --- commit + push ---
cd $REPO
git add -A
if git diff --cached --quiet; then echo "Sin cambios para commitear."; exit 0; fi
git commit -q -m "$MSG"
export GIT_SSH_COMMAND="ssh -i /root/.ssh/pbxng_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=no"
git push -q origin main
echo "OK - pushed: $MSG"
git log --oneline -1
