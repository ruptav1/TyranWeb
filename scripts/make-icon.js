// Run with: npm run icon — renders src/shared/logo.svg to PNG app icons.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const svg = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'logo.svg'), 'utf8');
const out = path.join(__dirname, '..', 'assets', 'icon');

async function render(size) {
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, backgroundColor: '#00000000', useContentSize: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return img.resize({ width: size, height: size });
}

// .ico with PNG-compressed entries (supported since Windows Vista).
function toIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const big = await render(512);
  fs.writeFileSync(path.join(out, 'icon.png'), big.toPNG());
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  fs.writeFileSync(path.join(out, 'icon.ico'), toIco(sizes.map((size) => ({ size, data: big.resize({ width: size, height: size, quality: 'best' }).toPNG() }))));
  console.log('icon.png + icon.ico written to', out);
  app.quit();
});
