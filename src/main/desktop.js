'use strict';
// The Windows desktop's picture, for the wallpaper that shows it (Settings → Hình nền → Nền desktop):
// the copy Windows keeps of it (%APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper, else the
// file the registry names) copied into TyranWeb's wallpapers folder when it changes, and how
// Windows lays it out (HKCU\Control Panel\Desktop WallpaperStyle / TileWallpaper).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { USER_WALLPAPERS } = require('./protocol');

const TRANSCODED = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
const COPY = 'desktop-wallpaper.jpg';
// WallpaperStyle: 10 Fill, 6 Fit, 2 Stretch, 0 Center (Tile with TileWallpaper 1), 22 Span
const STYLES = { 10: 'fill', 6: 'fit', 2: 'stretch', 0: 'center', 22: 'span' };

function registry() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Control Panel\\Desktop'], { windowsHide: true, timeout: 4000 }, (err, out) => {
      const val = (name) => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'mi').exec(out || '')?.[1]?.trim() ?? '';
      resolve(err ? {} : { file: val('WallPaper'), style: val('WallpaperStyle'), tile: val('TileWallpaper') });
    });
  });
}

async function desktopWallpaper() {
  const reg = await registry();
  const src = [TRANSCODED, reg.file].find((f) => f && fs.existsSync(f) && fs.statSync(f).size > 0);
  if (!src) return null;
  const dst = path.join(USER_WALLPAPERS, COPY);
  const st = fs.statSync(src);
  const have = fs.existsSync(dst) ? fs.statSync(dst) : null;
  if (!have || have.size !== st.size || have.mtimeMs < st.mtimeMs) {
    fs.mkdirSync(USER_WALLPAPERS, { recursive: true });
    fs.copyFileSync(src, dst);
  }
  const style = reg.tile === '1' ? 'tile' : STYLES[Number(reg.style)] || 'fill';
  return { url: `tyran://userdata/${COPY}?${Math.round(st.mtimeMs)}`, style };
}

module.exports = { desktopWallpaper };
