'use strict';
// Developer helper, only loaded when TYRAN_SHOT is set: forwards renderer console errors,
// optionally runs a script in the shell, then saves a screenshot of the first window and quits.
//   TYRAN_SHOT=out.png TYRAN_SHOT_DELAY=5000 TYRAN_SHOT_JS="..." npm start   (TYRAN_SHOT_MOUSE=x,y to hover)
const fs = require('fs');
const { app, webContents } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function devshot() {
  const out = process.env.TYRAN_SHOT;
  const delay = Number(process.env.TYRAN_SHOT_DELAY) || 5000;
  // keep painting even when the test window is behind other windows
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.on('web-contents-created', (e, wc) => {
    wc.on('console-message', (ev) => {
      const level = ev.level ?? ev.details?.level;
      if (level === 'error' || level === 'warning' || level === 3 || level === 2) {
        console.log(`[${wc.getType()} console] ${ev.message} (${ev.sourceId || ''}:${ev.lineNumber || ''})`);
      }
    });
    wc.on('preload-error', (ev, p, err) => console.log('[preload-error]', p, err));
    wc.on('did-fail-load', (ev, code, desc, url) => console.log('[did-fail-load]', code, desc, url));
  });
  // what each process uses (CPU % since the last call, memory), with the pages in it: dev:metrics
  require('electron').ipcMain.handle('dev:metrics', () => {
    const pages = webContents.getAllWebContents().map((wc) => ({ pid: wc.getOSProcessId(), kind: wc.getType(), url: wc.getURL().slice(0, 70) }));
    return app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, cpu: +m.cpu.percentCPUUsage.toFixed(1), mb: Math.round(m.memory.workingSetSize / 1024), pages: pages.filter((p) => p.pid === m.pid).map((p) => `${p.kind} ${p.url}`) }));
  });
  let done = false;
  app.on('browser-window-created', (e, win) => {
    if (done) return;
    done = true;
    win.webContents.once('did-finish-load', async () => {
      // TYRAN_SHOT_FOCUS=1: the shell acts as the focused window even when it is behind others
      if (process.env.TYRAN_SHOT_FOCUS) {
        try {
          win.webContents.debugger.attach('1.3');
          await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
        } catch (err) {
          console.log('[shot-focus]', err.message);
        }
      }
      await sleep(delay / 2);
      const steps = (process.env.TYRAN_SHOT_JS || '').split('||').filter(Boolean);
      for (const js of steps) {
        try {
          const r = await win.webContents.executeJavaScript(js, true);
          if (r !== undefined) console.log('[shot-js]', JSON.stringify(r).slice(0, 2000));
        } catch (err) {
          console.log('[shot-js error]', err.message);
        }
        await sleep(Number(process.env.TYRAN_SHOT_STEP) || 1200);
      }
      await sleep(delay / 2);
      // TYRAN_SHOT_WIN=last captures the most recently opened window instead of the first one
      const { BrowserWindow } = require('electron');
      const target = process.env.TYRAN_SHOT_WIN === 'last' ? BrowserWindow.getAllWindows().sort((a, b) => b.id - a.id)[0] : win;
      // TYRAN_SHOT_MOUSE=x,y moves a virtual pointer there first (to check hover styles)
      if (process.env.TYRAN_SHOT_MOUSE) {
        const [x, y] = process.env.TYRAN_SHOT_MOUSE.split(',').map(Number);
        target.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        await sleep(500);
      }
      const img = await target.webContents.capturePage();
      fs.writeFileSync(out, img.toPNG());
      console.log('[shot] saved', out, `${webContents.getAllWebContents().length} webContents`);
      if (!process.env.TYRAN_SHOT_KEEP) app.quit();
    });
  });
};
