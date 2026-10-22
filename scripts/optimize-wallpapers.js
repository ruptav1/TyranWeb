// Run with: npm run wallpapers
// Resizes the downloaded wallpapers in assets/wallpapers/_raw (max 3840px wide, JPEG),
// writes 480px thumbnails and the wallpapers.json catalogue with credits.
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const dir = path.join(__dirname, '..', 'assets', 'wallpapers');
const rawDir = path.join(dir, '_raw');
const thumbDir = path.join(dir, 'thumbs');

app.whenReady().then(() => {
  const picks = JSON.parse(fs.readFileSync(path.join(dir, '_picks.json'), 'utf8'));
  fs.mkdirSync(thumbDir, { recursive: true });
  const catalogue = [];
  for (const p of picks) {
    const raw = fs.readdirSync(rawDir).find((f) => f.startsWith(p.slug + '.'));
    if (!raw) {
      console.warn('missing', p.slug);
      continue;
    }
    let img = nativeImage.createFromPath(path.join(rawDir, raw));
    if (img.isEmpty()) {
      console.warn('cannot decode', raw);
      continue;
    }
    const { width, height } = img.getSize();
    if (width > 3840) img = img.resize({ width: 3840, quality: 'best' });
    fs.writeFileSync(path.join(dir, p.slug + '.jpg'), img.toJPEG(90));
    fs.writeFileSync(path.join(thumbDir, p.slug + '.jpg'), img.resize({ width: 480, quality: 'best' }).toJPEG(80));
    catalogue.push({
      file: p.slug + '.jpg',
      title: p.anime,
      anime: p.anime,
      year: p.year,
      original: `${width}x${height}`,
      uploaded: p.uploaded,
      wallhaven: p.wallhaven,
      source: p.source,
    });
    console.log('ok', p.slug, `${width}x${height}`);
  }
  fs.writeFileSync(path.join(dir, 'wallpapers.json'), JSON.stringify(catalogue, null, 2));
  console.log('done', catalogue.length);
  app.quit();
});
