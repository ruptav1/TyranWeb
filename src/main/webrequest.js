'use strict';
// One listener per webRequest event and session: Electron keeps only the last one set, and several
// of the browser's own steps need the same events. Each step is (details, callback) like Electron's
// own listeners; they run in ORDER, a cancel or redirect ends the chain, and header changes pass on
// to the next step.
//  - onBeforeRequest: 'https' (HTTPS-only, privacy.js), 'adblock'
//  - onBeforeSendHeaders: 'cookies' (third-party cookies, privacy.js), 'dnt' (sessions.js)
//  - onHeadersReceived: 'adblock' (its CSP rules), 'cookies'
const ORDER = ['https', 'adblock', 'cookies', 'dnt'];
const hubs = new WeakMap(); // session -> { event: Map(name -> step) }

function stepsOf(ses, event) {
  let h = hubs.get(ses);
  if (!h) hubs.set(ses, (h = {}));
  return (h[event] ||= new Map());
}

function listen(ses, event) {
  const steps = [...stepsOf(ses, event)].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0])).map(([, fn]) => fn);
  if (!steps.length) return ses.webRequest[event](null);
  ses.webRequest[event]({ urls: ['<all_urls>'] }, async (d, cb) => {
    const out = {};
    try {
      for (const fn of steps) {
        const r = await new Promise((ok) => fn(d, ok));
        if (!r) continue;
        if (r.cancel || r.redirectURL) return cb(r);
        if (r.requestHeaders) d.requestHeaders = out.requestHeaders = r.requestHeaders;
        if (r.responseHeaders) d.responseHeaders = out.responseHeaders = r.responseHeaders;
        if (r.statusLine) out.statusLine = r.statusLine;
      }
    } catch (err) {
      console.warn('[webrequest]', event, err.message);
    }
    cb(out);
  });
}

// sets (or with fn null, removes) the step `name` of `event` in `ses`
function step(ses, event, name, fn) {
  const steps = stepsOf(ses, event);
  if (fn) steps.set(name, fn);
  else if (!steps.delete(name)) return;
  listen(ses, event);
}

module.exports = { step };
