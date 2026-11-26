'use strict';
// Đổi vị trí (privacy.vpn): TyranWeb's own pages go out through Tor, so websites see a Tor exit in
// the country chosen (privacy.vpnCountry; '' any) instead of this computer's address. Only
// TyranWeb's sessions use it (tabs, incognito, the video store); files are downloaded on this
// computer's own network (the router below, the user's choice), other programs and its address
// are left alone.
// tor.exe (the Tor Project, BSD-3-Clause) is fetched on first use from its Expert Bundle on
// dist.torproject.org into <data>/tools/tor: the bundle's SHA-256 is fixed here, taken from the one
// whose PGP signature by the Tor Browser Developers' key (EF6E 286D DA85 EA2A 4BA7 DE68 4E2C 6E87
// 9329 8290) was checked. It runs as a SOCKS5 proxy on this computer only (names looked up through
// it too: no DNS leak), owned by TyranWeb's process (it stops when TyranWeb does, crash included).
// While Tor connects, the pages wait for it rather than go out directly.
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { app, session, net: enet } = require('electron');
const data = require('./data');

const BUNDLE = {
  version: '16.0.3',
  url: 'https://dist.torproject.org/torbrowser/16.0.3/tor-expert-bundle-windows-x86_64-16.0.3.tar.gz',
  sha256: 'b70cabe2b93b5b1fd144466e42afaabe7a1a470228912657b3b5776e9cb7a9f1',
};
const DIR = path.join(data.dir, 'tools', 'tor');
const EXE = path.join(DIR, 'tor', 'tor.exe');
const STAMP = path.join(DIR, 'version.txt');
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
// countries with enough Tor exits to be picked (the user's choice among them)
const COUNTRIES = ['us', 'ca', 'gb', 'de', 'nl', 'fr', 'ch', 'se', 'fi', 'no', 'at', 'pl', 'cz', 'ro', 'lu', 'is', 'es', 'it', 'dk', 'bg', 'md', 'jp', 'sg', 'hk', 'au'];

let child = null; // the running tor.exe
let socksPort = 0;
let ctrlPort = 0;
let runningFor = null; // the country tor was started for ('' any)
const st = { downloading: 0, bootstrap: 0, error: '', exit: null }; // what the popup shows
const routeFns = [];
const changeFns = [];
let routedNow = false;
// (told at most every 200 ms, the last change always)
let telling = null;
function changed() {
  telling ??= setTimeout(() => {
    telling = null;
    for (const fn of changeFns) fn();
  }, 200);
}

// ---------------------------------------------------------------- the program
const installed = () => fs.existsSync(EXE) && (() => {
  try {
    return fs.readFileSync(STAMP, 'utf8').trim() === BUNDLE.version;
  } catch {
    return false;
  }
})();

let fetching = null;
function ensure() {
  if (installed()) return Promise.resolve();
  fetching ??= (async () => {
    st.downloading = 0.01;
    changed();
    const res = await enet.fetch(BUNDLE.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
      got += value.length;
      if (total) {
        st.downloading = Math.max(0.01, got / total);
        changed();
      }
    }
    const buf = Buffer.concat(parts);
    if (crypto.createHash('sha256').update(buf).digest('hex') !== BUNDLE.sha256) throw new Error('Tor: SHA-256');
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, 'bundle.tar.gz');
    fs.writeFileSync(file, buf);
    // (only what is used: the program, the countries of addresses, its licence)
    await new Promise((ok, fail) => execFile(TAR, ['-xzf', file, '-C', DIR, 'tor/tor.exe', 'data/geoip', 'data/geoip6', 'docs/tor.txt'], { windowsHide: true }, (err) => (err ? fail(err) : ok())));
    fs.rmSync(file, { force: true });
    fs.writeFileSync(STAMP, BUNDLE.version);
  })().finally(() => {
    fetching = null;
    st.downloading = 0;
    changed();
  });
  return fetching;
}

// a port free on this computer now
const freePort = () =>
  new Promise((ok, fail) => {
    const s = net.createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const quoted = (p) => `"${p.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;

async function start(country) {
  stop();
  await ensure();
  socksPort = await freePort();
  ctrlPort = await freePort();
  const store = path.join(DIR, 'state');
  fs.mkdirSync(store, { recursive: true });
  const conf = [
    `SocksPort 127.0.0.1:${socksPort}`,
    `ControlPort 127.0.0.1:${ctrlPort}`,
    'CookieAuthentication 1',
    `DataDirectory ${quoted(store)}`,
    `GeoIPFile ${quoted(path.join(DIR, 'data', 'geoip'))}`,
    `GeoIPv6File ${quoted(path.join(DIR, 'data', 'geoip6'))}`,
    'ClientOnly 1',
    'AvoidDiskWrites 1',
    `__OwningControllerProcess ${process.pid}`, // (it stops when TyranWeb does)
    'Log notice stdout',
    ...(country ? [`ExitNodes {${country}}`, 'StrictNodes 1'] : []),
  ];
  const torrc = path.join(DIR, 'torrc');
  fs.writeFileSync(torrc, conf.join('\n') + '\n');
  st.bootstrap = 0;
  st.error = '';
  st.exit = null;
  runningFor = country;
  await openRouter();
  const p = spawn(EXE, ['-f', torrc], { cwd: path.dirname(EXE), windowsHide: true });
  child = p;
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = /Bootstrapped (\d+)%/.exec(line);
      if (m) {
        st.bootstrap = Number(m[1]);
        changed();
        if (st.bootstrap === 100) lookExit();
      }
      if (/\[err\]/.test(line)) st.error = line.replace(/^.*\[err\]\s*/, '').slice(0, 200);
    }
  });
  p.once('exit', (code) => {
    if (child !== p) return;
    child = null;
    if (code && !st.error) st.error = `tor ${code}`;
    route();
    changed();
  });
  route();
}

function stop() {
  const p = child;
  child = null;
  closeRouter();
  runningFor = null;
  st.bootstrap = 0;
  st.exit = null;
  if (p) {
    try {
      p.kill();
    } catch {
      /* gone */
    }
  }
}

// ---------------------------------------------------------------- the router
// The sessions do not talk to Tor itself but to a SOCKS5 server of TyranWeb's own on 127.0.0.1,
// which sends each connection on its way:
//  - straight out (this computer's own network, at its full speed): files being downloaded (their
//    hosts, for a while: direct()), local addresses, and the sites left out (privacy.vpnMode
//    'all': privacy.vpnSkip) or not chosen ('only': only privacy.vpnOnly go through Tor);
//  - else into Tor, spread over a few circuits at once (a SOCKS username per group of sites:
//    Tor keeps streams with different usernames on different circuits), so a page fetching from
//    many hosts does not queue on one slow circuit.
const { getDomain } = require(require.resolve('tldts-experimental', { paths: [path.dirname(require.resolve('@ghostery/adblocker-electron'))] }));
const BUCKETS = 4;
const directUntil = new Map(); // host -> until when it goes straight out (downloads)
let router = null;
let routerPort = 0;

const siteOf = (host) => getDomain(host) || host;
const inList = (list, host) => (list || []).some((d) => host === d || host.endsWith('.' + d));
const local = (host) => host === 'localhost' || /^(127\.|10\.|192\.168\.|169\.254\.|::1$|\[)/.test(host) || /\.(local|localhost|lan|home|internal)$/i.test(host) || !host.includes('.');
function goesDirect(host) {
  host = String(host || '').toLowerCase();
  const until = directUntil.get(host);
  if (until && until > Date.now()) return true;
  if (until) directUntil.delete(host);
  if (local(host)) return true;
  const p = data.settings.data.privacy || {};
  return p.vpnMode === 'only' ? !inList(p.vpnOnly, host) : inList(p.vpnSkip, host);
}
// a host whose files are being downloaded: straight out for `ms` (yt-dlp, the downloads, the
// pictures and streams TyranWeb fetches itself: mediaprobe.fetchFrom)
function direct(urlOrHost, ms = 30 * 60e3) {
  let host = String(urlOrHost || '');
  try {
    host = new URL(host).hostname;
  } catch {
    /* a host already */
  }
  if (host) directUntil.set(host.toLowerCase(), Date.now() + ms);
}

// a SOCKS5 conversation, one message at a time: reads exactly n bytes
function reader(sock) {
  let buf = Buffer.alloc(0);
  let want = null;
  const pump = () => {
    if (!want || buf.length < want.n) return;
    const out = buf.subarray(0, want.n);
    buf = buf.subarray(want.n);
    const w = want;
    want = null;
    w.ok(out);
  };
  const onData = (d) => ((buf = Buffer.concat([buf, d])), pump());
  sock.on('data', onData);
  sock.once('close', () => want && want.fail(new Error('closed')));
  return {
    read: (n) => new Promise((ok, fail) => ((want = { n, ok, fail }), pump())),
    // stops reading: what came after the conversation is given back to be piped on
    done: () => (sock.off('data', onData), buf),
  };
}
const reply = (code) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

// into Tor for host:port, on the circuit group of its site
async function viaTor(host, port) {
  const t = net.connect(socksPort, '127.0.0.1');
  await new Promise((ok, fail) => (t.once('connect', ok), t.once('error', fail)));
  const r = reader(t);
  let n = 0;
  for (const ch of siteOf(host)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const user = Buffer.from(`tyran${n % BUCKETS}`);
  t.write(Buffer.from([5, 1, 2])); // (username / password: the circuit group)
  if ((await r.read(2))[1] !== 2) throw new Error('tor auth');
  t.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([1, 0x78])]));
  if ((await r.read(2))[1] !== 0) throw new Error('tor auth');
  const name = Buffer.from(host);
  t.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
  const head = await r.read(4);
  if (head[1] !== 0) throw Object.assign(new Error('tor connect'), { code: head[1] });
  await r.read(head[3] === 1 ? 6 : head[3] === 4 ? 18 : (await r.read(1))[0] + 2);
  return { sock: t, rest: r.done() };
}
function straight(host, port) {
  return new Promise((ok, fail) => {
    const s = net.connect(port, host);
    s.once('connect', () => ok({ sock: s, rest: Buffer.alloc(0) }));
    s.once('error', fail);
  });
}

async function serve(client) {
  client.on('error', () => {});
  const r = reader(client);
  try {
    const [ver, nm] = await r.read(2);
    if (ver !== 5) return client.destroy();
    await r.read(nm);
    client.write(Buffer.from([5, 0]));
    const [, cmd, , atyp] = await r.read(4);
    let host;
    if (atyp === 1) host = [...(await r.read(4))].join('.');
    else if (atyp === 3) host = (await r.read((await r.read(1))[0])).toString();
    else if (atyp === 4) host = (await r.read(16)).toString('hex').match(/.{4}/g).join(':');
    const port = (await r.read(2)).readUInt16BE(0);
    if (cmd !== 1 || !host) return client.end(reply(7));
    let up;
    try {
      up = goesDirect(host) ? await straight(host, port) : await viaTor(host, port);
    } catch (err) {
      return client.end(reply(err.code || 5));
    }
    const early = r.done();
    client.write(reply(0));
    if (early.length) up.sock.write(early);
    if (up.rest.length) client.write(up.rest);
    up.sock.on('error', () => client.destroy());
    client.on('close', () => up.sock.destroy());
    up.sock.on('close', () => client.destroy());
    client.pipe(up.sock);
    up.sock.pipe(client);
  } catch {
    client.destroy();
  }
}

// An address that names a file (an archive, a program, a video, a disc image...): its host goes
// straight out before the request leaves, so the download starts on this computer's own network
// at once rather than after a first try through Tor (sessions.js asks again for one that did go
// through Tor, once the browser knows it is a download).
const FILE = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|iso|img|exe|msi|msix|apk|dmg|pkg|deb|rpm|bin|dat|jar|mp4|m4v|mkv|avi|mov|webm|flv|ts|mp3|flac|wav|m4a|aac|ogg|opus|pdf|epub|cbz|cbr|torrent)$/i;
function fileStep(d, cb) {
  try {
    const u = new URL(d.url);
    if (/^https?:$/.test(u.protocol) && FILE.test(u.pathname)) direct(u.hostname, 10 * 60e3);
  } catch {
    /* not an address */
  }
  cb({});
}

async function openRouter() {
  if (router) return;
  routerPort = await freePort();
  router = net.createServer(serve);
  await new Promise((ok, fail) => (router.once('error', fail), router.listen(routerPort, '127.0.0.1', ok)));
  const { step } = require('./webrequest');
  for (const ses of routed()) step(ses, 'onBeforeRequest', 'vpnfiles', fileStep);
}
function closeRouter() {
  router?.close();
  router = null;
  const { step } = require('./webrequest');
  for (const ses of routed()) step(ses, 'onBeforeRequest', 'vpnfiles', null);
}

// ---------------------------------------------------------------- the pages' way out
// (the pages' sessions: tabs, incognito, the video store; not the wallpapers')
function routed() {
  const s = require('./sessions');
  return [s.browsing(), session.fromPartition(s.PRIVATE_PARTITION), session.fromPartition('persist:tyran-store')].filter(Boolean);
}
let applied = '';
async function route() {
  const rules = child && router ? { proxyRules: `socks5://127.0.0.1:${routerPort}`, proxyBypassRules: '<local>' } : { mode: 'direct' };
  const key = JSON.stringify(rules);
  if (key === applied) return;
  applied = key;
  routedNow = !!child;
  for (const fn of routeFns) fn(routedNow);
  await Promise.all(routed().map((ses) => ses.setProxy(rules).then(() => ses.closeAllConnections?.()).catch(() => {})));
}

// (which sites go where changed: the pages' open connections dropped, so the next ones go the new way)
function reroute() {
  for (const ses of routed()) ses.closeAllConnections?.().catch?.(() => {});
}

// as the setting says: started (for its country) or stopped
async function sync() {
  const p = data.settings.data.privacy || {};
  const country = COUNTRIES.includes(p.vpnCountry) ? p.vpnCountry : '';
  if (!p.vpn) {
    stop();
    await route();
    changed();
    return state();
  }
  if (!child || runningFor !== country) {
    try {
      await start(country);
    } catch (err) {
      stop();
      st.error = err.message || String(err);
      await route();
    }
  }
  changed();
  return state();
}

// ---------------------------------------------------------------- tor's control port
// commands answered by tor (authenticated with its cookie), each reply's lines
function control(cmds) {
  return new Promise((ok, fail) => {
    if (!child || !ctrlPort) return fail(new Error('Tor'));
    let cookie;
    try {
      cookie = fs.readFileSync(path.join(DIR, 'state', 'control_auth_cookie')).toString('hex');
    } catch (err) {
      return fail(err);
    }
    const sock = net.connect(ctrlPort, '127.0.0.1');
    const all = [`AUTHENTICATE ${cookie}`, ...cmds, 'QUIT'];
    const replies = [];
    let cur = [];
    let buf = '';
    sock.setTimeout(10000, () => (sock.destroy(), fail(new Error('Tor control timeout'))));
    sock.on('error', fail);
    sock.on('connect', () => sock.write(all.join('\r\n') + '\r\n'));
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        cur.push(line);
        if (/^\d{3} /.test(line)) {
          replies.push(cur);
          cur = [];
        }
      }
    });
    sock.on('close', () => (replies[0]?.[0]?.startsWith('250') ? ok(replies.slice(1, 1 + cmds.length)) : fail(new Error(replies[0]?.[0] || 'Tor control'))));
  });
}

// where the pages come from now: { ip, country } (asked through the pages' own session)
async function lookExit() {
  try {
    const res = await require('./sessions').browsing().fetch('https://check.torproject.org/api/ip', { cache: 'no-store' });
    const j = await res.json();
    let country = '';
    try {
      const [r] = await control([`GETINFO ip-to-country/${j.IP}`]);
      country = /=([a-z?]{2})/.exec(r?.[0] || '')?.[1] || '';
    } catch {
      /* (no country known) */
    }
    st.exit = { ip: j.IP || '', tor: !!j.IsTor, country: country === '??' ? '' : country };
  } catch {
    st.exit = { ip: '', tor: false, country: '' };
  }
  changed();
  return st.exit;
}

// what the user pressed for: a new address (new circuits, often another exit)
async function action(what) {
  if (what === 'renew') {
    await control(['SIGNAL NEWNYM']);
    await new Promise((ok) => setTimeout(ok, 1500));
    await require('./sessions').browsing().closeAllConnections?.();
    await lookExit();
  }
  return state();
}

function state() {
  return {
    installed: installed(),
    on: !!data.settings.data.privacy?.vpn,
    running: !!child,
    ready: !!child && st.bootstrap === 100,
    bootstrap: st.bootstrap,
    downloading: st.downloading,
    error: st.error,
    exit: st.exit,
    country: runningFor ?? '',
    countries: COUNTRIES,
  };
}

// the proxy TyranWeb's pages go through now ('' none)
const proxy = () => (child && router ? `socks5://127.0.0.1:${routerPort}` : '');

app.on('will-quit', stop);

module.exports = {
  state,
  sync,
  action,
  where: () => st.exit,
  lookExit,
  proxy,
  direct,
  reroute,
  goesDirect: (url) => {
    try {
      return goesDirect(new URL(url).hostname);
    } catch {
      return true;
    }
  },
  routed: () => routedNow,
  onRouteChange: (fn) => routeFns.push(fn),
  onChange: (fn) => changeFns.push(fn),
  COUNTRIES,
};
