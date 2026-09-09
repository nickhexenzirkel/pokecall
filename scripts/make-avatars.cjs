// Gera versoes 256x256 dos avatares em renderer/avatars/ a partir de arquivos soltos.
// Uso: node scripts/make-avatars.cjs <arquivo1.png> <arquivo2.png> ...
// O nome do arquivo (sem extensao) vira o id do avatar (ex: emolga.png -> "emolga").
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const outDir = path.join(__dirname, '..', 'renderer', 'avatars');
fs.mkdirSync(outDir, { recursive: true });

const files = process.argv.slice(2);
if (files.length === 0) { console.error('Passe os caminhos das imagens.'); process.exit(1); }

(async () => {
  for (const f of files) {
    const id = path.basename(f).replace(/\.[^.]+$/, '').toLowerCase();
    const dest = path.join(outDir, id + '.png');
    await sharp(f)
      .resize(256, 256, { fit: 'cover', position: 'top' })
      .png({ quality: 90 })
      .toFile(dest);
    console.log('avatar:', id, '->', dest);
  }
})().catch((e) => { console.error(e); process.exit(1); });
