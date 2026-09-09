// Gera assets/icon.png (256) e assets/icon.ico (multi-tamanho) a partir de icon-source.png
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;

const root = path.join(__dirname, '..');
const src = path.join(root, 'assets', 'icon-source.png');
const out = path.join(root, 'assets');

async function main() {
  const sizes = [16, 32, 48, 64, 128, 256];
  const buffers = [];
  for (const s of sizes) {
    const buf = await sharp(src)
      .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    buffers.push(buf);
    if (s === 256) fs.writeFileSync(path.join(out, 'icon.png'), buf);
  }
  const ico = await pngToIco(buffers);
  fs.writeFileSync(path.join(out, 'icon.ico'), ico);
  console.log('Gerado: assets/icon.png (256x256) e assets/icon.ico');
}

main().catch((e) => { console.error(e); process.exit(1); });
