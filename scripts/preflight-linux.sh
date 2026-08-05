#!/usr/bin/env bash
# RiskGPT on-prem preflight (Linux). Run:  bash scripts/preflight-linux.sh
# Prints PASS/FAIL/WARN per dependency. FAIL = must fix before installing.
echo "=== RiskGPT preflight $(date) ==="

ok(){ echo "PASS  $1"; }; bad(){ echo "FAIL  $1"; }; warn(){ echo "WARN  $1"; }

# 1 admin
[ "$(id -u)" = "0" ] && ok "running as root" || { sudo -n true 2>/dev/null && ok "passwordless sudo available" || warn "not root — run installs with sudo"; }

# 2 OS / package family
. /etc/os-release 2>/dev/null
echo "INFO  OS: ${PRETTY_NAME:-unknown}  arch: $(uname -m)"
case "$ID_LIKE$ID" in *debian*|*ubuntu*) ok "deb family (apt install onlyoffice-documentserver)";;
  *rhel*|*fedora*|*centos*) ok "rpm family (yum install onlyoffice-documentserver)";;
  *) warn "unrecognised distro — use Docker path";; esac
[ "$(uname -m)" = "x86_64" ] || bad "Document Server needs x86_64 (found $(uname -m))"

# 3 node
if command -v node >/dev/null; then
  v=$(node -p "process.versions.node.split('.').slice(0,2).join('.')")
  awk "BEGIN{exit !($v >= 22.5)}" && ok "node $(node -v)" || bad "node $(node -v) — need v22.5+"
else bad "node not installed"; fi

# 4 python (optional, for PDF tables)
command -v python3 >/dev/null && ok "python3 $(python3 -V 2>&1 | cut -d' ' -f2) (optional)" || warn "no python3 — PDF tables degraded (optional)"

# 5 ports
for p in 80 3001 3999; do
  (command -v ss >/dev/null && ss -lnt "( sport = :$p )" | grep -q LISTEN) && bad "port $p IN USE" || ok "port $p free"
done

# 6 resources
free_gb=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')
[ "${free_gb:-0}" -ge 10 ] && ok "disk ${free_gb}G free on /" || bad "only ${free_gb}G free on / (need 10G+)"
ram_gb=$(( $(grep MemTotal /proc/meminfo | tr -dc '0-9') / 1024 / 1024 ))
[ "$ram_gb" -ge 4 ] && ok "RAM ${ram_gb}G" || bad "RAM ${ram_gb}G (need 4G+, 8G recommended)"

# 7 network
code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 https://github.com 2>/dev/null)
[ "$code" = "200" ] || [ "$code" = "301" ] && ok "github.com reachable ($code)" || bad "github.com unreachable ($code) — set HTTPS_PROXY"
code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 https://api.deepseek.com 2>/dev/null)
[ "$code" = "000" ] && warn "api.deepseek.com unreachable — LLM answers will be mocked (optional)" || ok "api.deepseek.com reachable ($code)"

# 8 already installed?
[ -d /var/www/onlyoffice/documentserver ] && warn "Document Server already present" || ok "no existing Document Server"
command -v docker >/dev/null && ok "docker present ($(docker -v | cut -d, -f1)) — compose path available" || warn "no docker — use native package path"

echo "=== done. Fix every FAIL, then follow ONPREM-DEPLOY.md ==="
