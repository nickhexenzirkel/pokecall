# 🚀 PokeCall no seu VPS Hostinger (Ubuntu 24)

Guia para hospedar o **servidor de sinalização** + **TURN próprio** no mesmo VPS
que já roda seu site, **sem afetar o site**. Cada serviço usa uma porta e um
processo separados.

> Substitua em todos os passos:
> - `call.SEUDOMINIO.com` → o subdomínio que você vai usar
> - `SEU_IP_PUBLICO` → o IP do VPS (aparece no hPanel da Hostinger)

---

## Passo 0 — Descobrir qual servidor web você usa

Conecte no VPS por SSH e rode:

```bash
sudo systemctl is-active nginx 2>/dev/null && echo "=> Voce usa NGINX"
sudo systemctl is-active apache2 2>/dev/null && echo "=> Voce usa APACHE"
```

Guarde a resposta — você vai usar o arquivo `nginx-pokecall.conf` **ou**
`apache-pokecall.conf` conforme o caso.

---

## Passo 1 — Apontar o subdomínio (DNS)

No **hPanel da Hostinger → Domínios → DNS**, crie um registro:

| Tipo | Nome   | Valor (aponta para) |
|------|--------|---------------------|
| A    | `call` | `SEU_IP_PUBLICO`    |

Isso cria `call.seudominio.com`. Espere alguns minutos para propagar. Teste:

```bash
ping call.SEUDOMINIO.com    # deve responder com o IP do VPS
```

---

## Passo 2 — Enviar os arquivos do PokeCall para o VPS

No seu PC (não no VPS), dentro da pasta do projeto:

```bash
# copia a pasta inteira para /opt/pokecall no VPS
scp -r . SEU_USUARIO@SEU_IP_PUBLICO:/tmp/pokecall
```

No VPS:

```bash
sudo mv /tmp/pokecall /opt/pokecall
cd /opt/pokecall/server
sudo apt update && sudo apt install -y nodejs npm
npm install
```

---

## Passo 3 — Deixar o servidor de sinalização sempre no ar (PM2)

```bash
sudo npm install -g pm2
pm2 start /opt/pokecall/deploy/ecosystem.config.cjs
pm2 save
pm2 startup      # rode o comando que ele imprimir (sobe sozinho após reboot)
```

Confira que está rodando na porta 8080 (só local, por enquanto):

```bash
curl http://127.0.0.1:8080/health     # deve responder: PokeCall signaling OK
```

---

## Passo 4 — Expor via subdomínio com SSL

### Se você usa NGINX
```bash
# 1. copie o modelo e troque o dominio
sudo cp /opt/pokecall/deploy/nginx-pokecall.conf /etc/nginx/sites-available/pokecall
sudo sed -i 's/call.SEUDOMINIO.com/call.SEUDOMINIO.com/g' /etc/nginx/sites-available/pokecall
sudo nano /etc/nginx/sites-available/pokecall     # confira o subdominio

# 2. ative o site
sudo ln -s /etc/nginx/sites-available/pokecall /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 3. crie o certificado SSL (grátis, Let's Encrypt)
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d call.SEUDOMINIO.com
```

### Se você usa APACHE
```bash
sudo a2enmod proxy proxy_http proxy_wstunnel ssl rewrite
sudo cp /opt/pokecall/deploy/apache-pokecall.conf /etc/apache2/sites-available/pokecall.conf
sudo nano /etc/apache2/sites-available/pokecall.conf   # confira o subdominio
sudo a2ensite pokecall && sudo systemctl reload apache2

sudo apt install -y certbot python3-certbot-apache
sudo certbot --apache -d call.SEUDOMINIO.com
```

**Teste:** abra `https://call.SEUDOMINIO.com/health` no navegador → deve mostrar
`PokeCall signaling OK`. Pronto, seu WebSocket seguro é `wss://call.SEUDOMINIO.com`.

---

## Passo 5 — TURN próprio (coturn)

```bash
sudo apt install -y coturn

# habilita o serviço
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn

# faz backup e instala nossa config
sudo mv /etc/turnserver.conf /etc/turnserver.conf.bak 2>/dev/null
sudo cp /opt/pokecall/deploy/turnserver.conf /etc/turnserver.conf
sudo nano /etc/turnserver.conf    # troque SEU_IP_PUBLICO, o dominio e a SENHA
```

Depois que o Passo 4 já criou o certificado, **descomente as linhas `cert=` e
`pkey=`** no `/etc/turnserver.conf` para ter TURN sobre TLS (porta 5349).

```bash
sudo systemctl restart coturn
sudo systemctl enable coturn
```

---

## Passo 6 — Abrir as portas no firewall

```bash
sudo ufw allow 443/tcp
sudo ufw allow 3478
sudo ufw allow 5349
sudo ufw allow 49152:65535/udp
sudo ufw reload
```

> Se a Hostinger tiver um firewall no hPanel (**VPS → Firewall**), libere também
> lá as portas: 443, 3478, 5349 e a faixa UDP 49152-65535.

---

## Passo 7 — Apontar o app PokeCall para o seu servidor

No seu PC, edite `renderer/app.js`:

```js
// 1. servidor padrão (assim seus amigos não precisam digitar nada):
const DEFAULT_SERVER = 'wss://call.SEUDOMINIO.com';

// 2. troque a lista ICE_SERVERS pela do seu VPS:
const ICE_SERVERS = [
  { urls: 'stun:call.SEUDOMINIO.com:3478' },
  { urls: 'turn:call.SEUDOMINIO.com:3478', username: 'pokecall', credential: 'TROQUE_ESTA_SENHA' },
  { urls: 'turns:call.SEUDOMINIO.com:5349', username: 'pokecall', credential: 'TROQUE_ESTA_SENHA' },
];
```

Gere o instalador (`npm run dist`) e mande o `.exe` da pasta `dist/` para os amigos.
Todo mundo com o mesmo código de sala entra junto. 🎮

---

## Como saber que o TURN está funcionando

Abra <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>,
coloque `turn:call.SEUDOMINIO.com:3478` com usuário/senha e clique em *Gather
candidates*. Se aparecer uma linha do tipo **`relay`**, seu TURN está OK.

## Robô de Música (atualizar o servidor)

O Robô de Música **não precisa instalar nada novo** no VPS: o servidor só
procura o vídeo no YouTube e diz para os apps o que tocar e em que segundo.
O áudio sai no PC de cada pessoa, pelo player oficial do YouTube (escondido).

Para atualizar o servidor depois de mexer no código:

```bash
cd /opt/pokecall
git pull                 # ou envie os arquivos de novo (Passo 2)
pm2 restart pokecall
curl -s https://call.SEUDOMINIO.com.br/player.html | head -3   # deve devolver HTML
```

Se o `player.html` não abrir, a música não toca — confira se o nginx/apache
está encaminhando **tudo** para o Node (e não só o WebSocket).

---

## Manutenção rápida

```bash
pm2 logs pokecall        # ver logs do servidor de sinalização
pm2 restart pokecall     # reiniciar
sudo systemctl status coturn
sudo tail -f /var/log/turnserver.log
```
