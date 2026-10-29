'use strict';
// Web động → Special: interactive web wallpapers on GitHub. Repositories tagged as wallpapers
// for Wallpaper Engine or Lively (or as live wallpapers) are found with GitHub's search; whether one
// holds a wallpaper at its top (a Wallpaper Engine project.json of the web type, a Lively
// LivelyInfo.json of a web type, or a bare index.html) is read from its raw files; one is installed
// from GitHub's zip of it as a web wallpaper package (services.installLiveFolder). Its own scripts
// run as any web wallpaper's do: in the wallpaper session, on an origin of their own, with
// Wallpaper Engine's / Lively's API given by TyranWeb (protocol.js liveApi).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { net } = require('electron');
const data = require('./data');

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const TOPICS = ['wallpaper-engine', 'lively-wallpaper', 'live-wallpaper'];
const ZIP_MAX = 400 * 1024 * 1024;
const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'TyranWeb' };
const REPO = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^[\w./-]{1,100}$/;

async function gh(p) {
  const res = await net.fetch(API + p, { headers: HEADERS });
  if (res.status === 403 || res.status === 429) throw new Error('rate');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// a search's page: the repositories of the three tags, the most starred first
async function search(q, page) {
  q = String(q || '').replace(/[^\p{L}\p{N}\s._-]/gu, ' ').trim().slice(0, 80);
  page = Math.max(1, Math.min(30, page | 0));
  let rate = false;
  const lists = await Promise.all(
    TOPICS.map((topic) =>
      gh(`/search/repositories?q=${encodeURIComponent(`${q ? q + ' ' : ''}topic:${topic} fork:false`)}&sort=stars&order=desc&per_page=30&page=${page}`).catch((err) => {
        if (err.message === 'rate') rate = true;
        return null;
      })
    )
  );
  if (lists.every((l) => !l)) throw new Error(rate ? 'rate' : 'offline');
  const seen = new Map();
  for (const r of lists.flatMap((l) => l?.items || [])) {
    if (seen.has(r.full_name) || r.archived && !r.stargazers_count) continue;
    seen.set(r.full_name, {
      id: r.full_name,
      name: r.name,
      owner: r.owner?.login || '',
      desc: String(r.description || '').slice(0, 300),
      stars: r.stargazers_count | 0,
      license: r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : '',
      size: (r.size | 0) * 1024,
      branch: r.default_branch || 'main',
      pushed: r.pushed_at || '',
      topics: (r.topics || []).slice(0, 12),
      url: r.html_url,
    });
  }
  return { items: [...seen.values()].sort((a, b) => b.stars - a.stars), partial: lists.some((l) => !l) };
}

// What a repository holds: { kind: 'we' | 'lively' | 'web', title, preview, dir } or { kind: '' }. Its
// files are listed by jsDelivr (it reads GitHub repositories, without GitHub's hourly limit), and the
// wallpaper is the shallowest folder with a Wallpaper Engine web project.json, else a Lively
// LivelyInfo.json of a web type, else an index.html at the top; a repository too big for that list
// is looked at its top only.
const looked = new Map();
const json = (t) => {
  try {
    return t ? JSON.parse(t.replace(/^\uFEFF/, '')) : null;
  } catch {
    return null;
  }
};
async function filesOf(full, branch) {
  try {
    const res = await net.fetch(`https://data.jsdelivr.com/v1/packages/gh/${full}@${encodeURIComponent(branch)}?structure=flat`);
    const j = res.ok ? await res.json() : null;
    return Array.isArray(j?.files) ? j.files.map((f) => String(f.name || '').replace(/^\/+/, '')) : null;
  } catch {
    return null;
  }
}
async function inspect(full, branch) {
  if (!REPO.test(full || '') || !BRANCH.test(branch || '')) throw new Error('bad repo');
  const key = `${full}@${branch}`;
  if (looked.has(key)) return looked.get(key);
  const base = `${RAW}/${full}/${encodeURI(branch)}/`;
  const text = (f) => net.fetch(base + f.split('/').map(encodeURIComponent).join('/')).then((r) => (r.ok ? r.text() : null), () => null);
  const files = await filesOf(full, branch);
  const depth = (f) => f.split('/').length;
  const dirOf = (f) => f.split('/').slice(0, -1).join('/');
  const pick = (name) => (files || []).filter((f) => f.split('/').pop().toLowerCase() === name.toLowerCase() && !/(^|\/)(node_modules|\.github)\//.test(f)).sort((a, b) => depth(a) - depth(b)).slice(0, 3);
  const weFiles = files ? pick('project.json') : ['project.json'];
  const livelyFiles = files ? pick('LivelyInfo.json') : ['LivelyInfo.json'];
  const file = (dir, f) => (typeof f === 'string' && f && !/^[a-z]+:|\.\./i.test(f) ? base + [dir, f.replace(/\\/g, '/').replace(/^\/+/, '')].filter(Boolean).join('/') : '');
  let out = { kind: '' };
  for (const f of weFiles) {
    const we = json(await text(f));
    if (we && String(we.type || '').toLowerCase() === 'web') {
      out = { kind: 'we', title: String(we.title || ''), preview: file(dirOf(f), we.preview), dir: dirOf(f) };
      break;
    }
    if (we?.type && !out.why) out.why = String(we.type); // (a scene or a video for Wallpaper Engine: not a web page)
  }
  if (!out.kind) {
    for (const f of livelyFiles) {
      const lv = json(await text(f));
      if (lv && [1, 2].includes(lv.Type)) {
        out = { kind: 'lively', title: String(lv.Title || ''), preview: file(dirOf(f), lv.Thumbnail || lv.Preview), dir: dirOf(f) };
        break;
      }
    }
  }
  if (!out.kind && !out.why) {
    const index = files ? files.includes('index.html') : await net.fetch(base + 'index.html', { method: 'HEAD' }).then((r) => r.ok, () => false);
    if (index) out = { kind: 'web', title: '', preview: '', dir: '' };
  }
  looked.set(key, out);
  return out;
}

// GitHub's zip of it, unpacked (Windows' own tar, as Settings' zip import), installed as a package
const jobs = new Map();
async function install(sender, item) {
  const { id, full, branch } = item || {};
  if (!REPO.test(full || '') || !BRANCH.test(branch || '')) throw new Error('bad repo');
  const ctrl = new AbortController();
  jobs.set(String(id), ctrl);
  const tmp = path.join(data.dir, `special-${data.uid()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const res = await net.fetch(`https://codeload.github.com/${full}/zip/refs/heads/${encodeURI(branch)}`, { signal: ctrl.signal, headers: { 'user-agent': 'TyranWeb' } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || Number(item.size) || 0;
    const zip = path.join(tmp, 'repo.zip');
    const out = fs.createWriteStream(zip);
    let got = 0;
    let told = 0;
    for await (const chunk of res.body) {
      const b = Buffer.from(chunk);
      got += b.length;
      if (got > ZIP_MAX) throw new Error('too big');
      if (!out.write(b)) await new Promise((ok) => out.once('drain', ok));
      if (Date.now() - told > 200 && !sender.isDestroyed()) {
        told = Date.now();
        sender.send('livewalls:progress', { id, got, total });
      }
    }
    await new Promise((ok, fail) => out.end((err) => (err ? fail(err) : ok())));
    const dir = path.join(tmp, 'x');
    fs.mkdirSync(dir);
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    await new Promise((ok, fail) => execFile(tar, ['-xf', zip, '-C', dir], { windowsHide: true }, (err) => (err ? fail(new Error('zip')) : ok())));
    // (GitHub's zip has one folder: <repo>-<branch>)
    const tops = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    const root = tops.length === 1 ? path.join(dir, tops[0].name) : dir;
    // (the folder the wallpaper is in, as inspect found it: public/, wallpaper/, the top...)
    const found = (await inspect(full, branch)).dir || '';
    const folder = path.normalize(path.join(root, ...found.split('/').filter(Boolean)));
    if (folder !== root && !folder.startsWith(root + path.sep)) throw new Error('bad folder');
    if (!sender.isDestroyed()) sender.send('livewalls:progress', { id, got, total: got });
    return await require('./services').installLiveFolder(fs.existsSync(folder) ? folder : root, { title: full.split('/')[1], page: `https://github.com/${full}`, repo: full, license: item.license || '', source: 'GitHub' });
  } finally {
    jobs.delete(String(id));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const cancel = (id) => jobs.get(String(id))?.abort();

module.exports = { search, inspect, install, cancel };
