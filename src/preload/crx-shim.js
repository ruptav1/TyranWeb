'use strict';
// Chrome extensions under Electron: Electron leaves parts of the chrome.* API out (windows, most tab
// events, the toolbar button, context menus, alarms...), and an extension that touches one of them
// often stops at startup. This fills only what is missing, inside the extension's own pages and
// its background service worker, with stand-ins that answer sensibly. Web pages are left alone.
const { contextBridge, ipcRenderer } = require('electron');

function shim(bridge) {
  const c = globalThis.chrome;
  if (!c || !c.runtime?.id || c.__tyranShim) return;
  try {
    Object.defineProperty(c, '__tyranShim', { value: true });
  } catch {
    return;
  }
  const event = () => {
    const fns = new Set();
    return {
      addListener: (f) => void fns.add(f),
      removeListener: (f) => void fns.delete(f),
      hasListener: (f) => fns.has(f),
      hasListeners: () => fns.size > 0,
      dispatch: (...a) =>
        fns.forEach((f) => {
          try {
            f(...a);
          } catch (e) {
            console.error(e);
          }
        }),
    };
  };
  // answers both ways: a callback as the last argument, or a promise
  const api =
    (fn) =>
    (...args) => {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const p = Promise.resolve().then(() => fn(...args));
      if (!cb) return p;
      p.then(cb, () => cb());
      return undefined;
    };
  const def = (obj, name, value) => {
    if (!obj || obj[name] !== undefined) return;
    try {
      obj[name] = value;
    } catch {
      /* read-only */
    }
    if (obj[name] === undefined) {
      try {
        Object.defineProperty(obj, name, { value, configurable: true, writable: true });
      } catch {
        /* sealed */
      }
    }
  };
  const ns = (name) => {
    def(c, name, {});
    return c[name];
  };
  const manifest = (() => {
    try {
      return c.runtime.getManifest() || {};
    } catch {
      return {};
    }
  })();
  const WIN = { id: 1, focused: true, top: 0, left: 0, width: 1280, height: 800, incognito: false, type: 'normal', state: 'normal', alwaysOnTop: false };

  const w = ns('windows');
  def(w, 'WINDOW_ID_NONE', -1);
  def(w, 'WINDOW_ID_CURRENT', -2);
  for (const k of ['get', 'getCurrent', 'getLastFocused', 'create', 'update']) def(w, k, api(() => ({ ...WIN })));
  def(w, 'getAll', api(() => [{ ...WIN }]));
  def(w, 'remove', api(() => undefined));
  for (const e of ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged']) def(w, e, event());

  const t = ns('tabs');
  def(t, 'TAB_ID_NONE', -1);
  for (const e of ['onCreated', 'onUpdated', 'onMoved', 'onActivated', 'onActiveChanged', 'onHighlighted', 'onDetached', 'onAttached', 'onRemoved', 'onReplaced', 'onZoomChange']) def(t, e, event());
  def(t, 'query', api(() => []));
  def(t, 'get', api(() => undefined));
  def(t, 'getCurrent', api(() => undefined));
  // (a new tab: from a page, as a pop-up the browser turns into a tab)
  def(t, 'create', api((p) => void (typeof window !== 'undefined' && p?.url && window.open(p.url, '_blank'))));
  for (const k of ['highlight', 'move', 'duplicate', 'discard', 'goBack', 'goForward', 'group', 'ungroup', 'setZoom', 'setZoomSettings']) def(t, k, api(() => undefined));
  def(t, 'getZoom', api(() => 1));
  def(t, 'detectLanguage', api(() => 'und'));
  def(t, 'captureVisibleTab', api(() => ''));

  for (const name of ['action', 'browserAction', 'pageAction']) {
    if (name !== 'action' && !manifest[name === 'browserAction' ? 'browser_action' : 'page_action'] && manifest.manifest_version === 3) continue;
    const a = ns(name);
    const state = {};
    for (const k of ['setBadgeText', 'setBadgeBackgroundColor', 'setBadgeTextColor', 'setTitle', 'setIcon', 'setPopup', 'enable', 'disable', 'show', 'hide']) def(a, k, api((d) => void (state[k] = d)));
    def(a, 'getBadgeText', api(() => state.setBadgeText?.text || ''));
    def(a, 'getTitle', api(() => state.setTitle?.title || manifest.action?.default_title || manifest.browser_action?.default_title || ''));
    def(a, 'getPopup', api(() => state.setPopup?.popup || ''));
    def(a, 'getBadgeBackgroundColor', api(() => [0, 0, 0, 0]));
    def(a, 'getBadgeTextColor', api(() => [255, 255, 255, 255]));
    def(a, 'getUserSettings', api(() => ({ isOnToolbar: true })));
    def(a, 'isEnabled', api(() => true));
    def(a, 'openPopup', api(() => undefined));
    def(a, 'onClicked', event());
  }

  for (const name of ['contextMenus', 'menus']) {
    const m = ns(name);
    let n = 0;
    def(m, 'create', (p, cb) => {
      if (cb) setTimeout(cb);
      return p?.id ?? ++n;
    });
    for (const k of ['update', 'remove', 'removeAll']) def(m, k, api(() => undefined));
    def(m, 'onClicked', event());
    def(m, 'ACTION_MENU_TOP_LEVEL_LIMIT', 6);
  }

  const cm = ns('commands');
  def(cm, 'getAll', api(() => []));
  def(cm, 'onCommand', event());

  // alarms: kept while the extension runs
  const al = ns('alarms');
  if (!al.create) {
    const alarms = new Map();
    const onAlarm = event();
    const clear = (name = '') => {
      const a = alarms.get(name);
      if (a) clearTimeout(a.timer);
      return alarms.delete(name);
    };
    const fire = (name) => {
      const a = alarms.get(name);
      if (!a) return;
      onAlarm.dispatch({ name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes });
      if (a.periodInMinutes) {
        a.scheduledTime = Date.now() + a.periodInMinutes * 60000;
        a.timer = setTimeout(() => fire(name), a.periodInMinutes * 60000);
      } else alarms.delete(name);
    };
    def(al, 'create', (name, info) => {
      if (typeof name === 'object') [name, info] = ['', name];
      clear(name);
      const delay = info?.when ? Math.max(0, info.when - Date.now()) : (info?.delayInMinutes ?? info?.periodInMinutes ?? 0) * 60000;
      alarms.set(name, { scheduledTime: Date.now() + delay, periodInMinutes: info?.periodInMinutes, timer: setTimeout(() => fire(name), delay) });
      return Promise.resolve();
    });
    const pub = (name) => alarms.has(name) && { name, scheduledTime: alarms.get(name).scheduledTime, periodInMinutes: alarms.get(name).periodInMinutes };
    def(al, 'get', api((name = '') => pub(name) || undefined));
    def(al, 'getAll', api(() => [...alarms.keys()].map(pub)));
    def(al, 'clear', api((name) => clear(name)));
    def(al, 'clearAll', api(() => [...alarms.keys()].map(clear).length > 0));
    def(al, 'onAlarm', onAlarm);
  }

  const no = ns('notifications');
  def(no, 'create', api((id, opts) => {
    if (typeof id === 'object') [id, opts] = ['', id];
    id ||= String(Date.now());
    try {
      if (typeof Notification !== 'undefined') new Notification(opts?.title || '', { body: opts?.message || '' });
      else globalThis.registration?.showNotification?.(opts?.title || '', { body: opts?.message || '' });
    } catch {
      /* not allowed here */
    }
    return id;
  }));
  for (const k of ['update', 'clear']) def(no, k, api(() => true));
  def(no, 'getAll', api(() => ({})));
  def(no, 'getPermissionLevel', api(() => 'granted'));
  for (const e of ['onClicked', 'onClosed', 'onButtonClicked', 'onShowSettings', 'onPermissionLevelChanged']) def(no, e, event());

  const pe = ns('permissions');
  def(pe, 'contains', api(() => true));
  def(pe, 'request', api(() => true));
  def(pe, 'remove', api(() => true));
  def(pe, 'getAll', api(() => ({ permissions: [...(manifest.permissions || [])], origins: [...(manifest.host_permissions || [])] })));
  for (const e of ['onAdded', 'onRemoved']) def(pe, e, event());

  const idle = ns('idle');
  def(idle, 'queryState', api(() => 'active'));
  def(idle, 'setDetectionInterval', () => undefined);
  def(idle, 'onStateChanged', event());

  const sp = ns('sidePanel');
  for (const k of ['setOptions', 'setPanelBehavior', 'open']) def(sp, k, api(() => undefined));
  def(sp, 'getOptions', api(() => ({})));
  def(sp, 'getPanelBehavior', api(() => ({ openPanelOnActionClick: false })));

  // storage.sync: Electron has it but refuses every call ("not available"); here it is kept in
  // storage.local (under its own prefix), as nothing is synced anyway
  const st = c.storage;
  if (st?.local) {
    const P = '__tyran_sync__:';
    const local = (method, arg) => new Promise((resolve) => st.local[method](arg, (v) => resolve(v)));
    const keysOf = (keys) => (keys == null ? null : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys));
    const onChanged = event();
    const sync = {
      QUOTA_BYTES: 102400,
      QUOTA_BYTES_PER_ITEM: 8192,
      MAX_ITEMS: 512,
      MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
      MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
      get: api(async (keys) => {
        const all = (await local('get', null)) || {};
        const want = keysOf(keys);
        const out = keys && typeof keys === 'object' && !Array.isArray(keys) ? { ...keys } : {};
        for (const [k, v] of Object.entries(all)) if (k.startsWith(P) && (!want || want.includes(k.slice(P.length)))) out[k.slice(P.length)] = v;
        return out;
      }),
      set: api((items) => local('set', Object.fromEntries(Object.entries(items || {}).map(([k, v]) => [P + k, v])))),
      remove: api((keys) => local('remove', keysOf(keys).map((k) => P + k))),
      clear: api(async () => local('remove', Object.keys((await local('get', null)) || {}).filter((k) => k.startsWith(P)))),
      getBytesInUse: api(() => 0),
      getKeys: api(async () => Object.keys((await local('get', null)) || {}).filter((k) => k.startsWith(P)).map((k) => k.slice(P.length))),
      setAccessLevel: api(() => undefined),
      onChanged,
    };
    // its changes, told to listeners of sync too
    try {
      st.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const mine = Object.fromEntries(Object.entries(changes).filter(([k]) => k.startsWith(P)).map(([k, v]) => [k.slice(P.length), v]));
        if (Object.keys(mine).length) onChanged.dispatch(mine);
      });
    } catch {
      /* no storage events here */
    }
    try {
      Object.defineProperty(st, 'sync', { value: sync, configurable: true, writable: true });
    } catch {
      try {
        st.sync = sync;
      } catch {
        /* left as it is */
      }
    }
  }

  const ex = ns('extension');
  def(ex, 'isAllowedFileSchemeAccess', api(() => false));
  def(ex, 'isAllowedIncognitoAccess', api(() => false));
  def(ex, 'inIncognitoContext', false);
  def(ex, 'setUpdateUrlData', () => undefined);

  // the real tabs and windows, from the browser (see src/main/extensions.js)
  if (bridge) {
    const put = (obj, name, value) => {
      try {
        Object.defineProperty(obj, name, { value, configurable: true, writable: true });
      } catch {
        try {
          obj[name] = value;
        } catch {
          /* sealed */
        }
      }
    };
    const q = (query) => bridge.tabs(query || {}).catch(() => []);
    const shown = async () => (await q({ active: true, currentWindow: true }))[0];
    put(t, 'query', api((query) => q(query)));
    put(t, 'get', api(async (id) => (await q({})).find((x) => x.id === id)));
    put(t, 'create', api(async (p) => (await bridge.create(p || {}), shown())));
    put(t, 'update', api(async (id, p) => {
      if (typeof id === 'object' && id) [id, p] = [undefined, id];
      if (id === undefined) id = (await shown())?.id;
      await bridge.update(id, p || {});
      return (await q({})).find((x) => x.id === id);
    }));
    put(t, 'remove', api((ids) => bridge.remove(ids)));
    const win = async (pick, opts) => {
      const s = await bridge.windows();
      const id = pick(s);
      const out = { ...WIN, id, focused: id === s.focused };
      if (opts?.populate) out.tabs = await q({ windowId: id });
      return out;
    };
    put(w, 'getCurrent', api((opts) => win((s) => s.current, opts)));
    put(w, 'getLastFocused', api((opts) => win((s) => s.focused, opts)));
    put(w, 'get', api((id, opts) => win((s) => (id === -2 ? s.current : id), opts)));
    put(w, 'getAll', api(async (opts) => {
      const s = await bridge.windows();
      return Promise.all(s.all.map((id) => win(() => id, opts)));
    }));
  }

  const fonts = ns('fontSettings');
  def(fonts, 'getFontList', api(() => []));
}

// (a service worker's preload runs in a realm of its own, without location: shim() itself returns
// at once where there is no chrome.runtime, as in a website's worker)
const worker = typeof process !== 'undefined' && process.type === 'service-worker';
if (worker || (typeof location !== 'undefined' && location.protocol === 'chrome-extension:')) {
  try {
    const bridge = {
      tabs: (q) => ipcRenderer.invoke('crx:tabs', q),
      windows: () => ipcRenderer.invoke('crx:windows'),
      create: (p) => ipcRenderer.invoke('crx:tab-create', p),
      update: (id, p) => ipcRenderer.invoke('crx:tab-update', id, p),
      remove: (ids) => ipcRenderer.invoke('crx:tab-remove', ids),
    };
    contextBridge.executeInMainWorld({ func: shim, args: [bridge] });
  } catch (err) {
    console.warn('[tyran-crx-shim]', err && err.message);
  }
}
