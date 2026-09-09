// PokeCall - configuracao do PM2 (mantem o servidor de sinalizacao sempre no ar)
//
// Uso no VPS:
//   cd /opt/pokecall/server
//   pm2 start /opt/pokecall/deploy/ecosystem.config.cjs
//   pm2 save
//   pm2 startup   (e rode o comando que ele imprimir, p/ subir sozinho apos reboot)

module.exports = {
  apps: [
    {
      name: 'pokecall',
      script: 'signaling.js',
      cwd: '/opt/pokecall/server',
      env: {
        PORT: 8080,
      },
      autorestart: true,
      max_memory_restart: '200M',
    },
  ],
};
