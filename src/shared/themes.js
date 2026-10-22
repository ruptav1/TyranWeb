// Theme presets inspired by 2000–2010 anime. Each preset sets colours + a bundled wallpaper;
// every value can still be changed afterwards in Settings → Giao diện.
const W = (file) => `tyran://assets/wallpapers/${file}.jpg`;

export const PRESETS = [
  {
    id: 'clannad', name: 'Dango Daikazoku', sub: 'CLANNAD · 2007',
    appearance: { dark: false, accent: '#e0718f', bg: '#f7eeea', surface: '#fffaf7', text: '#2d2430' },
    wallpaper: { image: W('clannad-nagisa-sakura'), dim: 0.1 },
  },
  {
    id: 'haruhi', name: 'SOS Brigade', sub: 'Suzumiya Haruhi · 2006',
    appearance: { dark: false, accent: '#f0a00c', bg: '#f4f1ea', surface: '#fffdf7', text: '#262421' },
    wallpaper: { image: W('haruhi-sos-brigade'), dim: 0.08 },
  },
  {
    id: 'kon', name: 'Hōkago Tea Time', sub: 'K-ON! · 2009',
    appearance: { dark: false, accent: '#ec6f9b', bg: '#eef3fb', surface: '#ffffff', text: '#1f2433' },
    wallpaper: { image: W('kon-sakura'), dim: 0.06 },
  },
  {
    id: 'luckystar', name: 'Lucky☆Star XP', sub: 'Lucky☆Star · 2007',
    appearance: { dark: false, accent: '#3d7bea', bg: '#eaf2fb', surface: '#ffffff', text: '#1e2633' },
    wallpaper: { image: W('luckystar-akiba'), dim: 0.06 },
  },
  {
    id: 'kanon', name: 'Taiyaki Morning', sub: 'Kanon · 2006',
    appearance: { dark: false, accent: '#7c6fd6', bg: '#f7f0ea', surface: '#fffaf6', text: '#2a2433' },
    wallpaper: { image: W('kanon-breakfast'), dim: 0.08 },
  },
  {
    id: 'air', name: 'Natsu no Sora', sub: 'AIR · 2005',
    appearance: { dark: false, accent: '#2f9fe0', bg: '#eaf6fd', surface: '#ffffff', text: '#16293a' },
    wallpaper: { image: W('air-summer-beach'), dim: 0.05 },
  },
  {
    id: 'toradora', name: 'Palmtop Tiger', sub: 'Toradora! · 2008',
    appearance: { dark: false, accent: '#f07a2a', bg: '#fbefe2', surface: '#fffaf4', text: '#2c221b' },
    wallpaper: { image: W('toradora-taiga'), dim: 0.04 },
  },
  {
    id: 'spice', name: 'Wise Wolf', sub: 'Spice and Wolf · 2008',
    appearance: { dark: false, accent: '#c98a3c', bg: '#f6f1e6', surface: '#fffcf5', text: '#2b2418' },
    wallpaper: { image: W('spice-meadow'), dim: 0.06 },
  },
  {
    id: 'key', name: 'Tenshi', sub: 'Angel Beats! · 2010',
    appearance: { dark: false, accent: '#8a7fe0', bg: '#f4eef8', surface: '#fffbff', text: '#29243a' },
    wallpaper: { image: W('angelbeats-wings'), dim: 0 },
  },
  {
    id: 'natsume', name: 'Yuujinchou', sub: 'Natsume Yuujinchou · 2008',
    appearance: { dark: false, accent: '#2f9aa0', bg: '#e8f4f5', surface: '#fbffff', text: '#1d3134' },
    wallpaper: { image: W('natsume-nyanko'), dim: 0 },
  },
  {
    id: 'fumoffu', name: 'Fumoffu!', sub: 'Full Metal Panic? Fumoffu · 2003',
    appearance: { dark: false, accent: '#2e7de1', bg: '#eef3f9', surface: '#ffffff', text: '#1b2230' },
    wallpaper: { image: W('fmp-fumoffu'), dim: 0.04 },
  },
  {
    id: 'kyon', name: 'Bungei-bu', sub: 'Suzumiya Haruhi · 2006',
    appearance: { dark: true, accent: '#a99bff', bg: '#14121f', surface: '#1c1a2b', text: '#ecebf5' },
    wallpaper: { image: W('haruhi-nagato-asakura'), dim: 0.25 },
  },
  {
    id: 'monogatari', name: 'Senjougahara', sub: 'Bakemonogatari · 2009',
    appearance: { dark: true, accent: '#ff9f43', bg: '#0d0f1a', surface: '#151827', text: '#eef0f8' },
    wallpaper: { image: W('monogatari-hitagi'), dim: 0.18 },
  },
  {
    id: 'shana', name: 'Flame Haze', sub: 'Shakugan no Shana · 2005',
    appearance: { dark: true, accent: '#ff5a4f', bg: '#170d10', surface: '#211317', text: '#f6e8ea' },
    wallpaper: { image: W('shana-forest'), dim: 0.2 },
  },
];

export function presetPatch(preset) {
  return {
    appearance: { preset: preset.id, ...preset.appearance },
    wallpaper: { type: 'image', ...preset.wallpaper },
  };
}

export const ACCENTS = ['#e0718f', '#ff7aa8', '#f0a00c', '#f07a2a', '#e5534b', '#d9a25f', '#3fb27f', '#1fa4b5', '#5c9ccf', '#3d7bea', '#6b8cff', '#8f7cff', '#c6a7ff'];
