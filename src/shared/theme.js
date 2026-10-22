// Turns appearance settings into CSS custom properties. Shared by the shell and internal pages.

export function hexToRgb(hex) {
  let h = String(hex || '#000').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgba = (hex, a) => `rgba(${hexToRgb(hex).join(',')},${a})`;

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mix(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

export function rgbToHsl(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

export function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// window background, surfaces and text in one hue, for a light or a dark interface
const tones = (h, s, dark) =>
  dark
    ? { bg: hsl(h, Math.min(s, 0.4), 0.085), surface: hsl(h, Math.min(s, 0.32), 0.14), text: hsl(h, 0.14, 0.93) }
    : { bg: hsl(h, Math.min(s, 0.45), 0.94), surface: hsl(h, Math.min(s, 0.4), 0.985), text: hsl(h, 0.28, 0.14) };

// The colours the interface really uses. With automatic colours on they come from the wallpaper
// (appearance.auto: its main tone and its liveliest colour); either way they suit the light or
// dark mode, so switching mode always gives a real light or dark interface without picking colours.
export function colorsOf(a) {
  const dark = !!a.dark;
  let { accent, bg, surface, text } = a;
  if (a.autoColor && a.auto?.base) {
    const [h, s] = rgbToHsl(a.auto.base);
    ({ bg, surface, text } = tones(h, s, dark));
    const [ah, as, al] = rgbToHsl(a.auto.accent || a.accent);
    accent = hsl(ah, Math.max(as, 0.45), dark ? Math.min(0.75, Math.max(0.6, al)) : Math.min(0.58, Math.max(0.42, al)));
  } else if (dark ? luminance(surface) > 0.4 : luminance(surface) < 0.4) {
    // in the accent's hue, so a pink theme turns plum rather than brown
    const [h] = rgbToHsl(accent);
    ({ bg, surface, text } = tones(h, Math.max(0.18, rgbToHsl(surface)[1]), dark));
  }
  return { accent, bg, surface, text };
}

const DENSITY = {
  compact: { topbar: 36, toolbar: 40, tab: 28, control: 28, gap: 4 },
  comfortable: { topbar: 40, toolbar: 46, tab: 32, control: 32, gap: 6 },
  spacious: { topbar: 46, toolbar: 54, tab: 36, control: 36, gap: 8 },
};

export function themeVars(s) {
  const a = { ...s.appearance, ...colorsOf(s.appearance) }; // (automatic or mode-fitted colours)
  const l = s.layout || {};
  const d = DENSITY[a.density] || DENSITY.comfortable;
  const dark = !!a.dark;
  const op = a.chromeStyle === 'solid' ? 1 : a.chromeStyle === 'clear' ? 0 : a.surfaceOpacity;
  const onAccent = luminance(a.accent) > 0.45 ? '#16131a' : '#ffffff';
  return {
    '--accent': a.accent,
    '--accent-rgb': hexToRgb(a.accent).join(','),
    '--on-accent': onAccent,
    '--accent-soft': rgba(a.accent, dark ? 0.22 : 0.16),
    '--accent-strong': mix(a.accent, dark ? '#ffffff' : '#000000', 0.12),
    '--bg': a.bg,
    '--surface-solid': a.surface,
    '--surface': rgba(a.surface, op),
    '--surface-2': rgba(a.surface, Math.max(op, 0.86)),
    '--surface-3': rgba(a.surface, 0.97),
    '--surface-rgb': hexToRgb(a.surface).join(','),
    '--field': dark ? rgba('#ffffff', 0.07) : rgba('#ffffff', 0.62),
    '--field-focus': dark ? rgba('#ffffff', 0.11) : rgba('#ffffff', 0.92),
    '--text': a.text,
    '--text-rgb': hexToRgb(a.text).join(','),
    '--text-2': rgba(a.text, 0.68),
    '--text-3': rgba(a.text, 0.46),
    '--line': rgba(a.text, dark ? 0.12 : 0.1),
    '--line-strong': rgba(a.text, dark ? 0.2 : 0.16),
    '--hover': rgba(a.text, dark ? 0.08 : 0.06),
    '--active': rgba(a.text, dark ? 0.13 : 0.1),
    '--shadow-color': dark ? 'rgba(0,0,0,.45)' : 'rgba(40,30,50,.16)',
    '--blur': `${a.chromeStyle === 'glass' ? a.blur : 0}px`,
    // "clear" chrome: each control floats on its own frosted island over the wallpaper
    '--bg-rgb': hexToRgb(a.bg).join(','),
    '--island': rgba(a.surface, Math.min(0.95, Math.max(0.2, a.surfaceOpacity * 0.8))),
    '--island-strong': rgba(a.surface, Math.min(0.97, Math.max(0.2, a.surfaceOpacity * 0.8) + 0.25)),
    '--island-blur': `${Math.max(4, Math.round(a.blur * 0.45))}px`, // liquid glass: light blur so the picture stays readable through it
    '--frost-blur': `${Math.max(12, a.blur)}px`, // frosted glass where liquid glass is turned off (the bookmarks bar, the clock)
    '--scrim': String(a.clearScrim ?? 0.3),
    // liquid glass (clear chrome): nearly no fill until hovered or focused; a bright rim and a soft
    // shade around text and icons keep them readable on any picture
    '--liquid-fill': rgba(a.surface, dark ? 0.03 : 0.04),
    '--liquid-hi': dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.18)',
    '--liquid-rim': dark ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.5)',
    '--liquid-shade': rgba(a.bg, dark ? 0.75 : 0.7),
    '--font': a.font,
    '--font-size': `${a.fontSize}px`,
    '--radius': `${a.radius}px`,
    '--radius-sm': `${Math.round(a.radius * 0.66)}px`,
    '--radius-lg': `${Math.round(a.radius * 1.4)}px`,
    '--topbar-h': `${d.topbar}px`,
    '--toolbar-h': `${d.toolbar}px`,
    '--tab-h': `${d.tab}px`,
    '--control-h': `${d.control}px`,
    '--gap': `${d.gap}px`,
    '--content-inset': `${l.contentInset ?? 8}px`,
    '--content-radius': `${l.contentRadius ?? 12}px`,
    '--vtabs-w': `${l.verticalTabsWidth ?? 248}px`,
    '--sidebar-w': `${l.sidebarWidth ?? 340}px`,
  };
}

export function applyTheme(s, root = document.documentElement) {
  const vars = themeVars(s);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.scheme = s.appearance.dark ? 'dark' : 'light';
  root.dataset.chrome = s.appearance.chromeStyle;
  root.classList.toggle('no-anim', !s.appearance.animations);
  root.style.colorScheme = s.appearance.dark ? 'dark' : 'light';
  return vars;
}

export function densityOf(s) {
  return DENSITY[s.appearance.density] || DENSITY.comfortable;
}

// Which wallpaper a song belongs to (Settings → Hình nền → Nhạc nền): '' for one that cannot have one.
export function musicKey(w) {
  const web = w.web || {};
  if (w.type === 'image') return w.image ? 'image:' + w.image : '';
  if (w.type === 'video') return w.video ? 'video:' + w.video : '';
  if (w.type !== 'web') return '';
  if (web.preset === 'bluearchive') return web.model ? 'ba:' + web.model : '';
  if (web.preset === 'package') return web.package ? 'package:' + web.package : '';
  if (web.preset === 'nikke') return 'nikke:' + (web.nikke || 'c010');
  if (web.preset === 'azurlane') return web.azur ? 'azur:' + web.azur : '';
  if (web.preset === 'sekai') return web.sekai ? 'sekai:' + web.sekai : '';
  return web.url ? 'web:' + web.url : '';
}
export const ownMusic = (w) => w.music?.[musicKey(w)] || null;

// A picture or video framed by hand (Settings → Cắt / phóng to): zoom z (1 = just covering the
// window) and where the window sits in what is left over, x / y from 0 (left / top) to 1.
export function frameOf(w) {
  const f = w.frames?.[w.type === 'video' ? w.video : w.image];
  return f && f.z >= 1 ? f : null;
}
// background-position / object-position, and the zoom drawn around that same point
export function frameCss(w) {
  const f = frameOf(w);
  if (!f) return { position: w.position || 'center', transform: '' };
  return { position: `${(f.x * 100).toFixed(2)}% ${(f.y * 100).toFixed(2)}%`, transform: f.z > 1.001 ? `scale(${f.z.toFixed(4)})` : '' };
}

// CSS for the wallpaper layer (used by the shell, and as a preview in Settings).
export function wallpaperStyle(w, appearance) {
  const style = {};
  switch (w.type) {
    case 'image':
      style.backgroundImage = w.image ? `url("${w.image.replace(/"/g, '%22')}")` : 'none';
      style.backgroundColor = appearance.bg;
      style.backgroundSize = 'cover';
      style.backgroundPosition = frameCss(w).position;
      style.transform = frameCss(w).transform;
      break;
    case 'gradient':
      style.backgroundImage = `linear-gradient(${w.gradientAngle}deg, ${w.gradientFrom}, ${w.gradientTo})`;
      break;
    case 'color':
      style.backgroundColor = w.color;
      style.backgroundImage = 'none';
      break;
    case 'video':
    case 'web':
      // drawn by a <video> / <webview> layer; the colour shows while it loads
      style.backgroundColor = appearance.bg;
      style.backgroundImage = 'none';
      style.backgroundPosition = w.position || 'center';
      break;
    default:
      style.backgroundColor = 'transparent';
      style.backgroundImage = 'none';
  }
  const filters = [];
  if (w.blur) filters.push(`blur(${w.blur}px)`);
  if (w.saturate !== 1) filters.push(`saturate(${w.saturate})`);
  style.filter = filters.join(' ') || 'none';
  style.dim = w.type === 'mica' || w.type === 'acrylic' ? 0 : w.dim;
  return style;
}

export function contrastText(hex) {
  return luminance(hex) > 0.45 ? '#16131a' : '#ffffff';
}
