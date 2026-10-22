'use strict';
// Work done apart from the browser (a utility process) for brave-adblock.js and brave-build.js:
//  - 'probe': tries an engine just built (one that crashes must not take the browser with it);
//  - 'scriptlets': reads uBlock Origin's scriptlets out of its source the way Brave's packager does
//    (each one's function, as text, with the helpers it needs).
const { pathToFileURL } = require('url');

process.parentPort.once('message', async ({ data }) => {
  try {
    let result = null;
    if (data.task === 'probe') {
      const m = { exports: {} };
      process.dlopen(m, data.file);
      const n = m.exports;
      const set = n.FilterSet_constructor(false);
      n.FilterSet_addFilters(set, '||ads.example.com^\n##.ad-banner', {});
      const e = n.Engine_constructor(set);
      const blocks = (url) => n.Engine_check(e, url, 'https://example.org/', 'script', '');
      if (!blocks('https://ads.example.com/a.js') || blocks('https://example.org/a.js')) throw new Error('the engine does not block');
      result = true;
    } else if (data.task === 'scriptlets') {
      const { builtinScriptlets } = await import(pathToFileURL(data.file).href);
      result = builtinScriptlets.map((s) => ({
        name: s.name,
        aliases: s.aliases ?? [],
        kind: { mime: 'application/javascript' },
        content: Buffer.from(s.fn.toString()).toString('base64'),
        dependencies: s.dependencies ?? [],
      }));
    }
    process.parentPort.postMessage({ result });
  } catch (err) {
    process.parentPort.postMessage({ error: String(err?.message || err) });
  }
});
