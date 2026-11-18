'use strict';
// Cookies sealed on disk. The packaged app encrypts its cookie store with Windows' own keys (the
// enableCookieEncryption fuse, as Chrome does), but only cookies written from then on: the ones kept
// in plain text by earlier versions stay so until a site sets them again. Once, they are all written
// again, so every saved login is encrypted at once and nobody is signed out. (Not in the developer
// build, whose Electron has no such fuse.)
const { app, session } = require('electron');
const data = require('./data');
const { PARTITION, WALLPAPER_PARTITION } = require('./sessions');

async function sealOne(ses) {
  let done = 0;
  for (const c of await ses.cookies.get({})) {
    // (session cookies are not kept on disk; partitioned ones cannot be set again as they are)
    if (!c.expirationDate || c.partitionKey) continue;
    const host = c.domain.replace(/^\./, '');
    try {
      await ses.cookies.set({
        url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        ...(c.hostOnly ? {} : { domain: c.domain }),
        path: c.path || '/',
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: c.expirationDate,
        sameSite: c.sameSite || 'unspecified',
      });
      done++;
    } catch {
      /* (one the API will not take back as it is: left to its site) */
    }
  }
  await ses.cookies.flushStore();
  return done;
}

async function seal() {
  const p = data.settings.data.privacy;
  if (!app.isPackaged || p.cookiesSealed) return;
  let total = 0;
  for (const part of [PARTITION, 'persist:tyran-store', WALLPAPER_PARTITION]) total += await sealOne(session.fromPartition(part)).catch(() => 0);
  p.cookiesSealed = true;
  data.settings.save();
  console.log(`[cookies] sealed ${total} saved cookies`);
}

module.exports = { seal };
