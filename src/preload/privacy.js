'use strict';
// Brave's protections inside the pages (main/fingerprint.js), in every frame of the tabs: what the
// page reads back of its drawings, its sounds and the processor is changed a little (Chống nhận
// dạng trình duyệt), it is told one language (Ẩn bớt ngôn ngữ), it sees Global Privacy Control with
// "Không theo dõi", and an AMP page is left for the page it copies (Mở trang gốc thay cho trang AMP).
// Runs in an isolated world; what pages see is put in their own world before their scripts run.
const { ipcRenderer, contextBridge } = require('electron');

// The page's world: `cfg` from main/fingerprint.js. Whole by itself (it is run from its source).
function protect(cfg, langs) {
  const MARK = Symbol.for('tyranweb.farbled');
  const natives = new WeakMap(); // stand-in -> the function it stands for (what toString shows)
  const seed = cfg.seed >>> 0;
  // (sounds: a factor a hair under 1, the same for the site all along)
  const fudge = 1 - (1 + (cfg.seed2 % 1000) / 112) * 1e-5;
  const rng = (a) => () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const stand = (orig, apply) => {
    const fake = new Proxy(orig, { apply });
    natives.set(fake, orig);
    return fake;
  };
  function wrap(obj, name, make) {
    const d = obj && Object.getOwnPropertyDescriptor(obj, name);
    if (d && typeof d.value === 'function') Object.defineProperty(obj, name, { ...d, value: stand(d.value, make(d.value)) });
  }
  function wrapGet(obj, name, make) {
    const d = obj && Object.getOwnPropertyDescriptor(obj, name);
    if (d && typeof d.get === 'function') Object.defineProperty(obj, name, { ...d, get: stand(d.get, make(d.get)) });
  }

  // RGBA pixels changed a little: the same picture gives the same result on this site in this run
  function farble(px) {
    const n = px.length >> 2;
    if (!n) return;
    let h = (seed ^ n) >>> 0;
    const stride = Math.max(1, Math.floor(n / 64));
    for (let i = 0; i < n; i += stride) h = (Math.imul(h ^ (px[i * 4] | (px[i * 4 + 1] << 8) | (px[i * 4 + 2] << 16) | (px[i * 4 + 3] << 24)), 0x5bd1e995) ^ (h >>> 13)) >>> 0;
    const r = rng(h);
    const count = Math.max(1, Math.min(2048, n >> 8));
    let changed = 0;
    for (let k = 0; k < count; k++) {
      // (an opaque pixel keeps its change when the picture is drawn again)
      let p = Math.floor(r() * n) * 4;
      for (let tries = 0; tries < 8 && px[p + 3] !== 255; tries++) p = Math.floor(r() * n) * 4;
      if (px[p + 3] === 0) continue;
      const c = p + Math.floor(r() * 3);
      px[c] ^= 1;
      changed++;
    }
    if (changed) return;
    // (mostly see-through: the first pixel there is from a point of its own)
    const start = Math.floor(r() * n);
    for (let k = 0; k < n; k++) {
      const p = ((start + k) % n) * 4;
      if (px[p + 3] === 255) return void (px[p] ^= 1);
      if (px[p + 3] > 1) return void (px[p + 3] ^= 1);
    }
  }

  function install(w) {
    try {
      if (!w || w[MARK]) return;
      Object.defineProperty(w, MARK, { value: true });
    } catch {
      return; // (a frame of another site: it does this itself)
    }
    // toString of a stand-in shows the function it stands for
    wrap(w.Function.prototype, 'toString', () => (t, self, args) => Reflect.apply(t, natives.get(self) || self, args));

    const nav = w.Navigator && w.Navigator.prototype;
    if (cfg.fp) {
      const C2D = w.CanvasRenderingContext2D && w.CanvasRenderingContext2D.prototype;
      const O2D = w.OffscreenCanvasRenderingContext2D && w.OffscreenCanvasRenderingContext2D.prototype;
      const getImageData = C2D && C2D.getImageData;
      const getOffImageData = O2D && O2D.getImageData;
      const createElement = w.Document.prototype.createElement;
      const readBack = () => (t, self, args) => {
        const img = Reflect.apply(t, self, args);
        if (img && img.data) farble(img.data);
        return img;
      };
      wrap(C2D, 'getImageData', readBack);
      wrap(O2D, 'getImageData', readBack);
      // a changed copy of a canvas to export instead of it (null: as it is; one that may not be read
      // keeps failing as it would)
      const copy = (canvas) => {
        try {
          const cw = canvas.width;
          const ch = canvas.height;
          if (!cw || !ch || cw * ch > 4096 * 4096) return null;
          const off = typeof w.OffscreenCanvas === 'function' && canvas instanceof w.OffscreenCanvas;
          const c = off ? new w.OffscreenCanvas(cw, ch) : createElement.call(w.document, 'canvas');
          c.width = cw;
          c.height = ch;
          const ctx = c.getContext('2d');
          ctx.drawImage(canvas, 0, 0);
          const img = (off ? getOffImageData : getImageData).call(ctx, 0, 0, cw, ch);
          farble(img.data);
          ctx.putImageData(img, 0, 0);
          return c;
        } catch {
          return null;
        }
      };
      const exported = () => (t, self, args) => Reflect.apply(t, copy(self) || self, args);
      const CE = w.HTMLCanvasElement && w.HTMLCanvasElement.prototype;
      wrap(CE, 'toDataURL', exported);
      wrap(CE, 'toBlob', exported);
      wrap(w.OffscreenCanvas && w.OffscreenCanvas.prototype, 'convertToBlob', exported);
      // WebGL: the pixels read back (RGBA bytes)
      for (const G of [w.WebGLRenderingContext, w.WebGL2RenderingContext]) {
        wrap(G && G.prototype, 'readPixels', () => (t, self, args) => {
          const out = Reflect.apply(t, self, args);
          const px = args[6];
          if (ArrayBuffer.isView(px) && px.BYTES_PER_ELEMENT === 1 && args[4] === 0x1908 && args[5] === 0x1401) {
            const at = args[7] >>> 0;
            const len = Math.min(px.length - at, Math.max(0, (args[2] | 0) * (args[3] | 0) * 4));
            if (len > 0) farble(new Uint8Array(px.buffer, px.byteOffset + at, len));
          }
          return out;
        });
      }
      // sounds: the samples a page reads, once per channel of a buffer
      const AB = w.AudioBuffer && w.AudioBuffer.prototype;
      const done = new WeakMap(); // AudioBuffer -> channels changed
      wrap(AB, 'getChannelData', () => (t, self, args) => {
        const out = Reflect.apply(t, self, args);
        let chans = done.get(self);
        if (!chans) done.set(self, (chans = new Set()));
        const ch = args[0] >>> 0;
        if (!chans.has(ch)) {
          chans.add(ch);
          for (let i = 0; i < out.length; i++) out[i] *= fudge;
        }
        return out;
      });
      wrap(AB, 'copyFromChannel', () => (t, self, args) => {
        try {
          self.getChannelData(args[1]); // (changed in place first: the same samples either way)
        } catch {
          /* the copy itself tells what is wrong */
        }
        return Reflect.apply(t, self, args);
      });
      const AN = w.AnalyserNode && w.AnalyserNode.prototype;
      for (const name of ['getFloatFrequencyData', 'getFloatTimeDomainData']) {
        wrap(AN, name, () => (t, self, args) => {
          const out = Reflect.apply(t, self, args);
          const a = args[0];
          if (a && a.length) for (let i = 0; i < a.length; i++) a[i] *= fudge;
          return out;
        });
      }
      // processor cores: between 2 and the real number
      wrapGet(nav, 'hardwareConcurrency', () => (t, self, args) => {
        const real = Reflect.apply(t, self, args);
        return real > 2 ? 2 + (cfg.seed2 % (real - 1)) : real;
      });
      try {
        if (nav) delete nav.getBattery;
      } catch {
        /* kept */
      }
    }
    if (langs) {
      const list = Object.freeze(langs.slice());
      wrapGet(nav, 'languages', () => () => list);
    }
    if (cfg.gpc && nav && !('globalPrivacyControl' in nav)) {
      const get = Object.getOwnPropertyDescriptor({ get globalPrivacyControl() { return true; } }, 'globalPrivacyControl').get;
      Object.defineProperty(nav, 'globalPrivacyControl', { get, configurable: true, enumerable: true });
    }

    // Frames of the page's own origin reached from here (a fresh about:blank one, as a way round)
    // get the same at once.
    const reach = (win) => {
      try {
        install(win);
      } catch {
        /* another origin */
      }
    };
    const IF = w.HTMLIFrameElement && w.HTMLIFrameElement.prototype;
    wrapGet(IF, 'contentWindow', () => (t, self, args) => {
      const win = Reflect.apply(t, self, args);
      reach(win);
      return win;
    });
    wrapGet(IF, 'contentDocument', () => (t, self, args) => {
      const doc = Reflect.apply(t, self, args);
      if (doc) reach(doc.defaultView);
      return doc;
    });
    // ...and as soon as they are put in the page (window.frames[i] goes round the getters)
    const frameWindow = Object.getOwnPropertyDescriptor(IF || {}, 'contentWindow');
    const scan = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.nodeName === 'IFRAME') reach(frameWindow.get.call(node));
      else if (node.firstElementChild && node.getElementsByTagName) for (const f of node.getElementsByTagName('iframe')) reach(frameWindow.get.call(f));
    };
    if (frameWindow) {
      const after = (pick) => () => (t, self, args) => {
        const out = Reflect.apply(t, self, args);
        try {
          pick(self, args);
        } catch {
          /* nothing to look at */
        }
        return out;
      };
      const N = w.Node.prototype;
      const E = w.Element.prototype;
      for (const name of ['appendChild', 'insertBefore', 'replaceChild']) wrap(N, name, after((self, args) => scan(args[0])));
      for (const name of ['append', 'prepend', 'after', 'before', 'replaceWith']) wrap(E, name, after((self, args) => args.forEach(scan)));
      wrap(E, 'insertAdjacentElement', after((self, args) => scan(args[1])));
      wrap(E, 'insertAdjacentHTML', after((self) => scan(self.parentNode || self)));
      for (const name of ['innerHTML', 'outerHTML']) {
        const d = Object.getOwnPropertyDescriptor(E, name);
        if (d && d.set) Object.defineProperty(E, name, { ...d, set: stand(d.set, after((self) => scan(name === 'outerHTML' ? self.parentNode : self))()) });
      }
    }
  }
  install(window);
}

// ---------------------------------------------------------------- AMP pages
// An AMP page (<html amp> or <html ⚡>) is left for its canonical page as soon as both are known.
function deAmp() {
  if (!/^https?:$/.test(location.protocol)) return;
  let obs = null;
  const stop = () => {
    obs?.disconnect();
    obs = null;
  };
  const check = () => {
    const html = document.documentElement;
    if (!html) return;
    if (!html.hasAttribute('amp') && !html.hasAttribute('⚡')) return stop();
    const link = document.querySelector('link[rel~="canonical"][href]');
    if (!link) return;
    stop();
    let to;
    try {
      to = new URL(link.getAttribute('href'), location.href);
    } catch {
      return;
    }
    if (!/^https?:$/.test(to.protocol) || to.href.split('#')[0] === location.href.split('#')[0]) return;
    if (ipcRenderer.sendSync('privacy:deamp', location.href, to.href)) location.replace(to.href);
  };
  obs = new MutationObserver(check);
  obs.observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => (check(), stop()), { once: true });
  check();
}

// ---------------------------------------------------------------- start
// (the tab's page: this frame's own address, or the origin of the topmost frame)
function topOf() {
  if (window === window.top) return location.href;
  const a = location.ancestorOrigins;
  return a && a.length ? a[a.length - 1] : '';
}

let cfg = null;
try {
  cfg = ipcRenderer.sendSync('privacy:frame', topOf());
} catch {
  cfg = null;
}
if (cfg) {
  // (the first language only, as the Accept-Language header main/fingerprint.js sends)
  const first = navigator.language || '';
  const langs = cfg.langs && first ? [first] : null;
  if (cfg.fp || langs || cfg.gpc) {
    try {
      contextBridge.executeInMainWorld({ func: protect, args: [cfg, langs] });
    } catch (err) {
      console.warn('[privacy]', err && err.message);
    }
  }
  if (cfg.deamp && window === window.top) deAmp();
}
