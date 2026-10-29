'use strict';
// Sora's shop (Blue Archive), the store page's look while the wallpaper is Blue Archive's lobby: her
// shop picture (a Spine 4.2 rig with the Angel 24 shop behind her: asdfdsa12/BA-Spine-Viewer-Asset,
// the same as the lobbies' second source), her shop lines (in, out, and one for each of her seven
// talks) and the shop's theme, BGM 17 "Irasshaimase" (the game's BGMUIExcel gives it to the shop;
// ba-archive's copy of the game's files). Fetched once into userData/live/sora-shop and served from
// there (tyran://sorashop/), drawn with the official Spine runtime (balobby's checked copy).
const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const { LIVE_WALLPAPERS } = require('./protocol');

const HOME = path.join(LIVE_WALLPAPERS, 'sora-shop');
const ASSETS = 'https://raw.githubusercontent.com/asdfdsa12/BA-Spine-Viewer-Asset/main/new';
const FILES = {
  'sora_shop.skel': `${ASSETS}/assets/sora_shop.skel`,
  'sora_shop.atlas': `${ASSETS}/assets/sora_shop.atlas`,
  'sora_shop.png': `${ASSETS}/assets/sora_shop.png`,
  'sora_shop2.png': `${ASSETS}/assets/sora_shop2.png`,
  'theme.ogg': 'https://yuuka.cdn.diyigemt.com/image/ba-all-data/Audio/BGM/Theme_17.ogg',
};
for (const n of ['in_1', 'in_2', 'out_1', 'out_2', 'talk_1', 'talk_2', 'talk_3', 'talk_4', 'talk_5', 'talk_6', 'talk_7']) FILES[`sora_shop_${n}.ogg`] = `${ASSETS}/audio/sora/sora_shop_${n}.ogg`;

let preparing = null;
async function fetchTo(name, url) {
  const to = path.join(HOME, name);
  if (fs.existsSync(to)) return;
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${name}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(to + '.part', buf);
  fs.renameSync(to + '.part', to);
}

// the shop ready to be shown: its files here, the runtime beside them
function prepare() {
  preparing ||= (async () => {
    fs.mkdirSync(HOME, { recursive: true });
    const list = Object.entries(FILES);
    for (let i = 0; i < list.length; i += 4) await Promise.all(list.slice(i, i + 4).map(([n, u]) => fetchTo(n, u)));
    const balobby = require('./balobby');
    fs.mkdirSync(balobby.HOME, { recursive: true });
    await balobby.runtime();
    const rt = path.join(HOME, 'spine-webgl.js');
    if (!fs.existsSync(rt)) fs.copyFileSync(balobby.runtimeFile(), rt);
    return { base: 'tyran://sorashop/' };
  })();
  preparing.catch(() => (preparing = null));
  return preparing;
}

module.exports = { prepare };
