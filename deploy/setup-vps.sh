#!/usr/bin/env bash
#
# PokeCall - instalacao automatica no VPS (Ubuntu 24, nginx)
# Ja configurado para: call.centraluniko.com.br / IP 187.127.27.98
#
# Como usar (veja as instrucoes que o Claude te passou):
#   sudo bash -c "cd /root/deploy && sed -i 's/\r$//' *.sh *.conf *.cjs 2>/dev/null; bash setup-vps.sh"

set -uo pipefail

DOMAIN="call.centraluniko.com.br"
EMAIL="nicolas.andrade.barboza@gmail.com"
GREEN="\033[1;32m"; RED="\033[1;31m"; YEL="\033[1;33m"; NC="\033[0m"
step() { echo -e "\n${YEL}==> $1${NC}"; }
ok()   { echo -e "${GREEN}OK: $1${NC}"; }
fail() { echo -e "${RED}FALHOU: $1${NC}"; }

if [ "$(id -u)" -ne 0 ]; then echo "Rode com sudo/root."; exit 1; fi

# ---------------------------------------------------------------------------
step "1/7  Copiando arquivos para /opt/pokecall"
mkdir -p /opt/pokecall
cp -r /root/server /opt/pokecall/ 2>/dev/null || true
cp -r /root/deploy /opt/pokecall/ 2>/dev/null || true
# Remove eventuais quebras de linha do Windows (\r) que quebrariam os configs.
sed -i 's/\r$//' /opt/pokecall/deploy/*.conf /opt/pokecall/deploy/*.cjs 2>/dev/null || true
ok "arquivos em /opt/pokecall"

# ---------------------------------------------------------------------------
step "2/7  Instalando Node, nginx, certbot e coturn"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
# Node so se ainda nao existir (evita conflito com instalacoes via NodeSource).
command -v node >/dev/null 2>&1 || apt-get install -y nodejs npm
# Instala cada grupo separado: se um falhar, nao derruba os outros.
apt-get install -y nginx certbot python3-certbot-nginx curl || true
apt-get install -y coturn || true
ok "pacotes instalados ($(node -v 2>/dev/null))"

# ---------------------------------------------------------------------------
step "3/7  Servidor de sinalizacao + PM2"
cd /opt/pokecall/server
rm -rf node_modules
npm install --omit=dev
npm install -g pm2
pm2 delete pokecall 2>/dev/null || true
pm2 start /opt/pokecall/deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null | tail -n 1 | bash 2>/dev/null || true
sleep 1
if curl -s http://127.0.0.1:8080/health | grep -q OK; then ok "sinalizacao rodando na porta 8080"; else fail "sinalizacao nao respondeu (veja: pm2 logs pokecall)"; fi

# ---------------------------------------------------------------------------
step "4/7  Nginx (proxy do subdominio)"
cp /opt/pokecall/deploy/nginx-pokecall.conf /etc/nginx/sites-available/pokecall
ln -sf /etc/nginx/sites-available/pokecall /etc/nginx/sites-enabled/pokecall
if nginx -t 2>/dev/null; then systemctl reload nginx; ok "nginx recarregado"; else fail "nginx -t falhou"; nginx -t; fi

# ---------------------------------------------------------------------------
step "5/7  Certificado SSL (Let's Encrypt)"
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
  ok "SSL emitido para $DOMAIN"
  CERT_OK=1
else
  fail "certbot falhou (DNS ainda propagando ou porta 80 fechada?). Rode de novo mais tarde: sudo certbot --nginx -d $DOMAIN"
  CERT_OK=0
fi

# ---------------------------------------------------------------------------
step "6/7  TURN (coturn)"
grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn 2>/dev/null || echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
[ -f /etc/turnserver.conf ] && cp /etc/turnserver.conf "/etc/turnserver.conf.bak.$(date +%s)" 2>/dev/null || true
cp /opt/pokecall/deploy/turnserver.conf /etc/turnserver.conf
# Se o SSL saiu, liga o TURN sobre TLS (porta 5349) reaproveitando o certificado.
if [ "${CERT_OK:-0}" = "1" ]; then
  sed -i 's|^#cert=|cert=|; s|^#pkey=|pkey=|' /etc/turnserver.conf
  # da permissao para o coturn ler os certificados
  chgrp -R turnserver /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || true
  chmod -R g+rX /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || true
fi
systemctl restart coturn
systemctl enable coturn 2>/dev/null || true
if systemctl is-active --quiet coturn; then ok "coturn ativo"; else fail "coturn nao subiu (veja: journalctl -u coturn)"; fi

# ---------------------------------------------------------------------------
step "7/7  Firewall"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 443/tcp; ufw allow 3478; ufw allow 5349; ufw allow 49152:65535/udp
  ok "portas liberadas no ufw"
else
  echo -e "${YEL}ufw inativo. Se a Hostinger tiver firewall no hPanel, libere: 443, 3478, 5349 e UDP 49152-65535.${NC}"
fi

# ---------------------------------------------------------------------------
echo -e "\n${GREEN}================ RESUMO ================${NC}"
echo -n "Sinalizacao local : "; curl -s http://127.0.0.1:8080/health || echo "sem resposta"; echo
echo -n "coturn            : "; systemctl is-active coturn
echo    "Teste no navegador: https://$DOMAIN/health  (deve mostrar 'PokeCall signaling OK')"
echo -e "${GREEN}=======================================${NC}"
