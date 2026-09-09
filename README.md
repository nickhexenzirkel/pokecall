# ⚡ PokeCall

App de desktop (Electron) para ficar em ligação com os amigos e **compartilhar a tela em alta qualidade e baixa latência**, no estilo Discord.

- 🎙️ Voz em grupo (WebRTC P2P, com cancelamento de eco e ruído)
- 🖥️ Compartilhamento de tela até **1440p / 60fps** com bitrate alto
- 🔊 Compartilha também o áudio do sistema (jogo/música)
- 💬 Chat de texto
- 🔗 Salas por código — quem digita o mesmo código entra junto

A voz e a tela vão **direto de um amigo para o outro** (peer-to-peer). O servidor só faz o "aperto de mão" inicial, então é leve e barato de hospedar.

---

## 1. Instalar

Precisa do [Node.js](https://nodejs.org) (v18+). Você já tem o v25.

```bash
# na pasta do projeto
npm install                 # dependências do app Electron
cd server && npm install    # dependências do servidor de sinalização
cd ..
```

## 2. Testar na sua máquina

Abra **dois terminais**:

```bash
# Terminal 1 — servidor de sinalização
npm run server

# Terminal 2 — o app PokeCall
npm start
```

No app: coloque um nome, um código de sala (ex: `kanto`) e clique em **Entrar**.
Para testar sozinho com "dois participantes", rode `npm start` de novo em outro
terminal — abre uma segunda janela que entra na mesma sala.

## 3. Usar com os amigos pela internet

Os seus amigos precisam:

1. Do app PokeCall instalado (veja "Gerar instalador" abaixo).
2. Apontar para o **mesmo servidor de sinalização público**.

### 3.1 Publicar o servidor de sinalização (grátis)

O servidor está em `server/`. Ele funciona em qualquer hospedagem Node. Opções fáceis:

- **Render.com** ou **Railway.app** (grátis para começar):
  - Suba a pasta `server/` num repositório.
  - Comando de start: `node signaling.js`
  - A hospedagem te dá uma URL como `https://pokecall-abc.onrender.com`.
  - No PokeCall, em **Servidor (avançado)**, use `wss://pokecall-abc.onrender.com`
    (note o `wss://`, com dois "s", que é WebSocket seguro).

### 3.2 TURN (importante para funcionar em qualquer rede)

Alguns roteadores bloqueiam a conexão P2P direta. Para garantir que sempre
funcione, use um servidor **TURN**. O código já vem com um TURN público de
exemplo, mas ele pode ficar lento/fora do ar.

**Recomendado:** crie uma conta grátis em [metered.ca](https://www.metered.ca/tools/openrelay/)
e cole suas credenciais em `renderer/app.js`, na constante `ICE_SERVERS`.

Para quem quer hospedar o próprio: [coturn](https://github.com/coturn/coturn).

## 4. Gerar instalador (.exe) para os amigos

```bash
npm run dist
```

Gera um instalador do Windows na pasta `dist/`. Antes de gerar, edite
`renderer/app.js` e troque a constante `DEFAULT_SERVER` para a URL pública
do seu servidor — assim seus amigos não precisam configurar nada.

---

## Estrutura

```
pokecall/
├─ main.js              # processo principal do Electron (janela + captura de tela)
├─ preload.js           # ponte segura renderer <-> main
├─ renderer/
│  ├─ index.html        # interface
│  ├─ styles.css        # tema escuro
│  └─ app.js            # WebRTC (mesh + negociação perfeita), sinalização, UI
├─ server/
│  ├─ signaling.js      # servidor de sinalização WebSocket
│  └─ package.json
└─ package.json
```

## Dicas de qualidade / latência

- Ao compartilhar, escolha **Fluidez** para jogos/vídeo (prioriza 60fps) ou
  **Nitidez** para texto/código (prioriza resolução).
- Para menos delay, prefira conexão por **cabo** e feche apps que usam banda.
- O modo malha (mesh) é ótimo até ~5-6 pessoas. Acima disso, a CPU/banda de
  quem compartilha a tela pode pesar (cada espectador recebe uma cópia).

## Limitações conhecidas

- Mesh não escala para dezenas de pessoas (precisaria de um servidor SFU).
- O TURN público de exemplo não é confiável — configure o seu.
