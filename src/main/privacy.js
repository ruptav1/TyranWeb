'use strict';
// Settings → Quyền riêng tư, as steps of the sessions' webRequest chain (webrequest.js):
//  - Chặn cookie bên thứ ba (privacy.blockThirdPartyCookies): a request to another site than the
//    page's (by registrable domain) neither sends its cookies nor keeps the ones it is given. A few
//    sites that belong together (Google's, Microsoft's, Meta's) count as one site, so signing in
//    through them keeps working. Cookies a third-party frame's own script sets are not stopped so.
//  - Chỉ dùng HTTPS (privacy.httpsOnly): a page asked for over http:// is asked for over https://
//    instead (not local addresses); one that cannot be reached so is offered over http:// by the
//    tab's error page (httpUrl), and its site is then allowed until TyranWeb closes.
const path = require('path');
const { step } = require('./webrequest');
// (the public-suffix list Ghostery's ad blocker brings along)
const { getDomain } = require(require.resolve('tldts-experimental', { paths: [path.dirname(require.resolve('@ghostery/adblocker-electron'))] }));

const GROUPS = [
  ['google.com', 'google.com.vn', 'youtube.com', 'youtube-nocookie.com', 'gstatic.com', 'googleusercontent.com', 'googlevideo.com', 'googleapis.com', 'ggpht.com', 'gmail.com', 'blogger.com', 'withgoogle.com'],
  ['microsoft.com', 'microsoftonline.com', 'live.com', 'office.com', 'office.net', 'outlook.com', 'bing.com', 'msn.com', 'xbox.com', 'skype.com', 'sharepoint.com', 'onedrive.com'],
  ['facebook.com', 'facebook.net', 'fbcdn.net', 'instagram.com', 'cdninstagram.com', 'messenger.com', 'whatsapp.com', 'threads.net'],
];
const groupOf = new Map(GROUPS.flatMap((g, i) => g.map((d) => [d, 'group' + i])));
const siteOf = (url) => {
  const d = getDomain(url) || '';
  return groupOf.get(d) || d;
};

// a request made for a page of another site (not a page itself, nor one with no page: a worker)
function thirdParty(d) {
  if (d.resourceType === 'mainFrame' || !/^(https?|wss?):/i.test(d.url)) return false;
  let top = '';
  try {
    top = d.webContents?.getURL() || '';
  } catch {
    /* gone */
  }
  if (!/^https?:/i.test(top)) return false;
  const site = siteOf(top);
  return !!site && site !== siteOf(d.url);
}

const isCookie = (k, name) => k.toLowerCase() === name;
function noCookieSent(d, cb) {
  if (!thirdParty(d) || !Object.keys(d.requestHeaders).some((k) => isCookie(k, 'cookie'))) return cb({});
  cb({ requestHeaders: Object.fromEntries(Object.entries(d.requestHeaders).filter(([k]) => !isCookie(k, 'cookie'))) });
}
function noCookieKept(d, cb) {
  const h = d.responseHeaders || {};
  if (!Object.keys(h).some((k) => isCookie(k, 'set-cookie')) || !thirdParty(d)) return cb({});
  cb({ responseHeaders: Object.fromEntries(Object.entries(h).filter(([k]) => !isCookie(k, 'set-cookie'))) });
}

const allowed = new Set(); // sites allowed over http:// (this run)
const upgraded = new Set(); // hosts asked for over https:// in their place
const local = (host) => host === 'localhost' || /\.(localhost|local|test|internal|lan|home)$/i.test(host) || /^[\d.]+$/.test(host) || host.startsWith('[') || !host.includes('.');
function toHttps(d, cb) {
  if (d.resourceType !== 'mainFrame' && d.resourceType !== 'subFrame') return cb({});
  let u;
  try {
    u = new URL(d.url);
  } catch {
    return cb({});
  }
  if (u.protocol !== 'http:' || local(u.hostname) || allowed.has(siteOf(d.url))) return cb({});
  u.protocol = 'https:';
  if (u.port === '80') u.port = '';
  upgraded.add(u.hostname);
  cb({ redirectURL: u.href });
}

// the steps a session takes now (at its setup, and when the settings change)
function apply(ses, privacy) {
  step(ses, 'onBeforeSendHeaders', 'cookies', privacy.blockThirdPartyCookies ? noCookieSent : null);
  step(ses, 'onHeadersReceived', 'cookies', privacy.blockThirdPartyCookies ? noCookieKept : null);
  step(ses, 'onBeforeRequest', 'https', privacy.httpsOnly ? toHttps : null);
}

// For the tab's error page: the http:// address of a page HTTPS-only asked for over https:// ('' none).
function httpUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !upgraded.has(u.hostname)) return '';
    u.protocol = 'http:';
    return u.href;
  } catch {
    return '';
  }
}
// that page's site, allowed over http:// from now on (this run)
function allowHttp(url) {
  const site = siteOf(url);
  if (site) allowed.add(site);
  return !!site;
}

module.exports = { apply, httpUrl, allowHttp };
