'use strict';
// Cloudflare WARP as the way out (Settings → Quyền riêng tư → Cloudflare WARP): with WARP's own app
// installed and in its proxy mode (a SOCKS5 proxy on this computer), TyranWeb's pages go through
// it: another IP, Cloudflare's network; other programs are left as they are. WARP is driven with
// its own command line (warp-cli): its mode is changed only when the user presses for it, and it
// is connected when the setting is on. While WARP cannot be reached the pages go out directly.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { session } = require('electron');
const data = require('./data');

const CLI = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Cloudflare', 'Cloudflare WARP', 'warp-cli.exe');
const run = (args) =>
  new Promise((ok) => execFile(CLI, args, { windowsHide: true, timeout: 20000 }, (err, out, errOut) => ok({ ok: !err, out: `${out || ''}${errOut || ''}` })));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// the pages' sessions (tabs, incognito, the video store): not the wallpapers'
function routed() {
  const s = require('./sessions');
  return [s.browsing(), session.fromPartition(s.PRIVATE_PARTITION), session.fromPartition('persist:tyran-store')].filter(Boolean);
}

async function state() {
  if (!fs.existsSync(CLI)) return { installed: false };
  const [st, set] = await Promise.all([run(['status']), run(['settings'])]);
  const port = Number(/Mode:\s*WarpProxy on port (\d+)/i.exec(set.out)?.[1] || 0);
  return { installed: true, connected: /Status update:\s*Connected/i.test(st.out), proxy: port > 0, port, mode: /Mode:\s*([^\r\n]+)/i.exec(set.out)?.[1]?.trim() || '' };
}

let current = '';
async function apply(rules) {
  const key = JSON.stringify(rules);
  if (key === current) return;
  current = key;
  await Promise.all(routed().map((ses) => ses.setProxy(rules).then(() => ses.closeAllConnections?.()).catch(() => {})));
}

// as the setting says: through WARP when it is on and WARP is ready (connected first if need be)
async function sync() {
  if (!data.settings.data.privacy?.warp) {
    await apply({ mode: 'direct' });
    return state();
  }
  let s = await state();
  if (s.installed && s.proxy && !s.connected) s = await connect();
  await apply(s.proxy && s.connected ? { proxyRules: `socks5://127.0.0.1:${s.port}`, proxyBypassRules: '<local>' } : { mode: 'direct' });
  return s;
}

async function connect() {
  await run(['connect']);
  let s = await state();
  for (let i = 0; i < 20 && s.installed && !s.connected; i++) {
    await sleep(500);
    s = await state();
  }
  return s;
}

// what the user pressed for: WARP into its proxy mode, or a new connection (often another IP)
async function action(what) {
  if (!fs.existsSync(CLI)) throw new Error('WARP');
  if (what === 'proxy') {
    const r = await run(['mode', 'proxy']);
    if (!r.ok) throw new Error(r.out.trim().split(/\r?\n/).pop() || 'warp-cli');
  }
  if (what === 'renew') {
    await run(['disconnect']);
    await sleep(1200);
  }
  if (what === 'proxy' || what === 'renew') await connect();
  current = ''; // (set the proxy again: the port may have changed)
  return sync();
}

// where the pages come from now, as Cloudflare sees it: { ip, loc, warp }
async function where() {
  try {
    const res = await require('./sessions').browsing().fetch('https://www.cloudflare.com/cdn-cgi/trace', { cache: 'no-store' });
    const text = await res.text();
    const get = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(text)?.[1]?.trim() || '';
    return { ip: get('ip'), loc: get('loc'), warp: get('warp') };
  } catch {
    return null;
  }
}

module.exports = { state, sync, action, where };
