'use strict';
// tyran://  — the browser UI, internal pages and wallpapers (trusted, gets the internal API).
// livewp:// — user-installed HTML wallpaper packages (untrusted, isolated origin per package).
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { net, protocol } = require('electron');
const { dir: userDir } = require('./data');

const ROOT = path.join(__dirname, '..', '..');
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
// The user's wallpapers live in userData/wallpapers, or wherever they were moved to (Settings →
// Hình nền → Thư mục lưu), recorded in userData/wallpaper-folder.json.
const WALLPAPER_FOLDER_FILE = path.join(userDir, 'wallpaper-folder.json');
const movedTo = readJson(WALLPAPER_FOLDER_FILE)?.dir;
const USER_WALLPAPERS = movedTo && fs.existsSync(movedTo) ? movedTo : path.join(userDir, 'wallpapers');
const LIVE_WALLPAPERS = path.join(userDir, 'live');
// Folders linked as wallpapers (used in place, not copied): id -> folder, served as tyran://linked/<id>/...
const LINKED_FILE = path.join(userDir, 'linked-folders.json');
const linkedRoot = (id) => (readJson(LINKED_FILE) || []).find((f) => f.id === id)?.path || '';
const PAGES = ['newtab', 'settings', 'history', 'bookmarks', 'downloads'];

const HOSTS = {
  app: path.join(ROOT, 'src', 'ui'),
  shared: path.join(ROOT, 'src', 'shared'),
  assets: path.join(ROOT, 'assets'),
  userdata: USER_WALLPAPERS,
  fonts: path.join(userDir, 'fonts'), // (the user's own fonts: main/fonts.js)
};
for (const p of PAGES) HOSTS[p] = path.join(ROOT, 'src', 'pages', p);

// (codeCache: V8 keeps the pages' compiled scripts between loads and starts, as it does for http)
const PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true };

function registerPrivileges() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'tyran', privileges: PRIVILEGES },
    { scheme: 'livewp', privileges: PRIVILEGES },
  ]);
}

// Serve `rel` from inside `root` (never outside it). Range headers pass through so
// <video> can seek and loop.
async function serveFile(request, root, rel, cache) {
  if (!rel || rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
  try {
    if (!fs.statSync(file).isFile()) throw new Error('not a file');
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const range = request.headers.get('range');
  const res = await net.fetch(pathToFileURL(file).toString(), range ? { headers: { range } } : undefined);
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', cache);
  // the browser window itself (and only it) may read the pixels of a wallpaper, to take the
  // interface's colours from it
  headers.set('Access-Control-Allow-Origin', 'tyran://app');
  return new Response(res.body, { status: res.status, headers });
}

function parse(request) {
  try {
    const url = new URL(request.url);
    return { url, rel: decodeURIComponent(url.pathname) };
  } catch {
    return null;
  }
}

async function handle(request) {
  const p = parse(request);
  if (!p) return new Response('Bad request', { status: 400 });
  if (p.url.hostname === 'linked') {
    // only files inside a folder the user linked
    const [, id, ...rest] = p.rel.split('/');
    const root = /^[a-z0-9-]+$/.test(id || '') ? linkedRoot(id) : '';
    if (!root) return new Response('Not found', { status: 404 });
    return serveFile(request, path.resolve(root), '/' + rest.join('/'), 'no-cache');
  }
  const root = HOSTS[p.url.hostname];
  if (!root) return new Response('Not found', { status: 404 });
  const longCache = p.url.hostname === 'assets' || p.url.hostname === 'userdata';
  return serveFile(request, root, p.rel, longCache ? 'max-age=31536000' : 'no-cache');
}

// livewp://<package-id>/index.html
async function handleLive(request) {
  const p = parse(request);
  if (!p || !/^[a-z0-9-]+$/.test(p.url.hostname)) return new Response('Bad request', { status: 400 });
  const res = await serveFile(request, path.join(LIVE_WALLPAPERS, p.url.hostname), p.rel, 'no-cache');
  // (the Azur Lane lobby songs, shared by its pages, may be measured by them for the spectrum bar)
  if (p.url.hostname === 'azur-music') res.headers.set('Access-Control-Allow-Origin', '*');
  return res;
}

function install(ses) {
  if (!ses.protocol.isProtocolHandled('tyran')) ses.protocol.handle('tyran', handle);
}

function installLive(ses) {
  if (!ses.protocol.isProtocolHandled('livewp')) ses.protocol.handle('livewp', handleLive);
}

module.exports = { registerPrivileges, install, installLive, ROOT, USER_WALLPAPERS, LIVE_WALLPAPERS, PAGES, WALLPAPER_FOLDER_FILE, LINKED_FILE };
