'use strict';
// Whether something else is making sound, so the new tab page's music rests meanwhile and comes
// back once it has been quiet a moment (Settings → Hình nền → Nhạc nền → Khi có âm thanh khác):
//  - 'tabs': a tab, a web panel or a page's popup window in TyranWeb (Chromium says when a page is
//    audible); the music's own players (the sidebar's Nhạc nền panel) are not "something else"
//  - 'apps': ...or any other program on the PC (sounds.ps1: Windows' own meter of each app's sound,
//    read only while the music is meant to play)
//  - 'off': the music plays on
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, webContents } = require('electron');
const data = require('./data');

const SCRIPT = path.join(__dirname, 'sounds.ps1');
const QUIET = 4000; // ms of quiet before the music comes back (a call's pauses, the next video)
const APP_TICKS = 2; // another program heard this many times in a row (about 1.4 s): not just a ping

let send = () => {};
const pages = new Set(); // webContents ids of the pages watched
const mine = new Set(); // ...that are the music's own players
const listening = new Set(); // UI webContents ids whose music is meant to play
let inApp = false;
let appTicks = 0;
let other = false;
let quietTimer = null;
let helper = null;

const mode = () => data.settings.data.wallpaper.pauseForSound || 'apps';

function update() {
  const m = mode();
  if (m === 'off') {
    clearTimeout(quietTimer);
    quietTimer = null;
    return set(false);
  }
  inApp = [...pages].some((id) => {
    const wc = webContents.fromId(id);
    return wc && !wc.isDestroyed() && !mine.has(id) && wc.isCurrentlyAudible();
  });
  const now = inApp || (m === 'apps' && appTicks >= APP_TICKS);
  if (now) {
    clearTimeout(quietTimer);
    quietTimer = null;
    set(true);
  } else if (other && !quietTimer) {
    quietTimer = setTimeout(() => {
      quietTimer = null;
      set(false);
    }, QUIET);
  }
}

function set(v) {
  if (v === other) return;
  other = v;
  send(v);
}

// (web-contents-created) a tab, web panel or popup in the browsing sessions
function watch(wc) {
  pages.add(wc.id);
  const id = wc.id;
  wc.on('audio-state-changed', update);
  wc.once('destroyed', () => {
    pages.delete(id);
    mine.delete(id);
    update();
  });
}

function markMine(wc) {
  mine.add(wc.id);
  update();
}

// ---- other programs: the helper runs while some window's music is meant to play
function listen(ui, on) {
  const id = ui.id;
  if (on && !listening.has(id)) ui.once('destroyed', () => listen({ id }, false));
  if (on) listening.add(id);
  else listening.delete(id);
  syncHelper();
}

function syncHelper() {
  const want = mode() === 'apps' && listening.size > 0;
  if (want && !helper) startHelper();
  if (!want && helper) {
    helper.kill();
    helper = null;
    clearInterval(tickTimer);
    appTicks = 0;
    update();
  }
}

function startHelper() {
  let script;
  try {
    script = `$parent = ${process.pid}\n` + fs.readFileSync(SCRIPT, 'utf8');
  } catch {
    return;
  }
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  helper = p;
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    if (lines.length && helper === p) heard(lines[lines.length - 1]);
  });
  p.on('error', () => {});
  p.on('exit', () => {
    if (helper !== p) return;
    helper = null; // (PowerShell missing or stopped: TyranWeb's own tabs still count)
    clearInterval(tickTimer);
    appTicks = 0;
    update();
  });
}

// the programs heard now, TyranWeb's own processes left out (its sound is the tabs' above)
let tickTimer = null;
function heard(line) {
  const ours = new Set(app.getAppMetrics().map((m) => m.pid));
  const loud = line.split(',').map(Number).some((pid) => pid && !ours.has(pid));
  // (the helper prints changes only: while something stays heard, its ticks are counted here)
  clearInterval(tickTimer);
  appTicks = loud ? 1 : 0;
  if (loud) {
    tickTimer = setInterval(() => {
      appTicks++;
      if (appTicks >= APP_TICKS) clearInterval(tickTimer);
      update();
    }, 700);
  }
  update();
}

function init(broadcast) {
  send = (v) => broadcast('audio:other', v);
}

// (settings changed: the mode)
function settingsChanged() {
  syncHelper();
  update();
}

const isOther = () => other;

// a page of this window (a tab, a web panel) making sound now, not one of the music's own players
function audibleGuest(host) {
  for (const id of pages) {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed() && !mine.has(id) && wc.hostWebContents === host && wc.isCurrentlyAudible()) return wc;
  }
  return null;
}

module.exports = { init, watch, markMine, listen, settingsChanged, isOther, audibleGuest };
