'use strict';
// Settings → Quyền riêng tư, Brave's protections inside the pages (src/preload/privacy.js, in every
// frame of the tabs' sessions):
//  - Chống nhận dạng trình duyệt (privacy.fingerprint): as Brave's "farbling", what a page reads back
//    of what it drew (canvas, WebGL) or of the sound it made (Web Audio), and the number of processor
//    cores, are changed a little: the same for a site all along a run of TyranWeb, another for every
//    other site and every run, so sites cannot follow the browser from one to the next by them.
//    The battery's state is not told (Brave took the API away).
//  - Ẩn bớt ngôn ngữ (privacy.languages): pages are told only the first language, as Brave does
//    (navigator.languages and the Accept-Language header).
//  - Chống lộ IP qua WebRTC (privacy.webrtc): calls in a page (WebRTC) do not give away this
//    computer's addresses on the local network; while the pages go through Cloudflare WARP, nor the
//    real address: WebRTC then goes through the proxy or not at all.
//  - Mở trang gốc thay cho trang AMP (privacy.deAmp): an AMP page is left for the page it is a copy
//    of (the preload finds it; here only the check that it does not go round in circles).
// The shield in the address bar turned off for a site turns these off on its pages too (WebRTC aside).
const crypto = require('crypto');
const path = require('path');
const { app, ipcMain, webContents } = require('electron');
const data = require('./data');
const { getDomain } = require(require.resolve('tldts-experimental', { paths: [path.dirname(require.resolve('@ghostery/adblocker-electron'))] }));

const PRELOAD = path.join(__dirname, '..', 'preload', 'privacy.js');
const keys = new WeakMap(); // session -> its random key for this run (the private session has its own)
const off = (url) => require('./adblock').isOff(url);

function siteOf(url) {
  try {
    return getDomain(url) || new URL(url).hostname;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- what a frame is to do
let ipcReady = false;
const deAmped = new WeakMap(); // tab -> { to, at } of where an AMP page last sent it
const plain = (u) => String(u).split('#')[0];

function ipc() {
  if (ipcReady) return;
  ipcReady = true;
  // (synchronous: the page's own scripts must not run first) `top`: the address of the tab's page,
  // as the frame knows it (its own, or the origin of its topmost frame)
  ipcMain.on('privacy:frame', (e, top) => {
    let out = null;
    try {
      const p = data.settings.data.privacy;
      const key = keys.get(e.sender.session);
      if (key && typeof top === 'string' && /^https?:/i.test(top) && !off(top) && (p.fingerprint || p.languages || p.doNotTrack || p.deAmp)) {
        const h = crypto.createHmac('sha256', key).update(siteOf(top)).digest();
        out = { fp: !!p.fingerprint, seed: h.readUInt32LE(0), seed2: h.readUInt32LE(4), langs: !!p.languages, gpc: !!p.doNotTrack, deamp: !!p.deAmp };
      }
    } catch {
      out = null;
    }
    e.returnValue = out;
  });
  // an AMP page (`from`) about to be left for its own page (`to`): not twice in a row to the same place
  ipcMain.on('privacy:deamp', (e, from, to) => {
    let ok = false;
    try {
      const last = deAmped.get(e.sender);
      ok = !!data.settings.data.privacy.deAmp && /^https?:/i.test(to) && !off(from) && !off(to) && !(last && last.to === plain(to) && Date.now() - last.at < 15000);
      if (ok) deAmped.set(e.sender, { to: plain(to), at: Date.now() });
    } catch {
      ok = false;
    }
    e.returnValue = ok;
  });
}

// ---------------------------------------------------------------- WebRTC
function webrtcPolicy() {
  if (!data.settings.data.privacy.webrtc) return 'default';
  return require('./vpn').routed() ? 'disable_non_proxied_udp' : 'default_public_interface_only';
}
function webrtc(wc) {
  try {
    if (!wc.isDestroyed() && keys.has(wc.session)) wc.setWebRTCIPHandlingPolicy(webrtcPolicy());
  } catch {
    /* (gone) */
  }
}
// every page again (the setting changed, or the way out: WARP)
function refreshWebrtc() {
  for (const wc of webContents.getAllWebContents()) webrtc(wc);
}

// ---------------------------------------------------------------- languages
// "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7" → "vi-VN"
const oneLanguage = (header) => String(header || '').split(',')[0].split(';')[0].trim();
function langStep(d, cb) {
  const k = Object.keys(d.requestHeaders).find((x) => x.toLowerCase() === 'accept-language');
  // (none there: the network adds the session's own later, which is then left as it is)
  const value = k ? oneLanguage(d.requestHeaders[k]) : '';
  if (!value || d.requestHeaders[k] === value) return cb({});
  let page = '';
  try {
    page = d.resourceType === 'mainFrame' ? d.url : d.webContents?.getURL() || '';
  } catch {
    /* gone */
  }
  if (page && off(page)) return cb({});
  const headers = { ...d.requestHeaders };
  if (k) delete headers[k];
  headers['Accept-Language'] = value;
  cb({ requestHeaders: headers });
}

// ---------------------------------------------------------------- sessions
let watching = false;
function setup(ses) {
  if (keys.has(ses)) return;
  keys.set(ses, crypto.randomBytes(32));
  ipc();
  ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD });
  if (!watching) {
    watching = true;
    app.on('web-contents-created', (e, wc) => webrtc(wc));
    require('./vpn').onRouteChange(() => refreshWebrtc());
  }
}

module.exports = { setup, refreshWebrtc, langStep, oneLanguage };
