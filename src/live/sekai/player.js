// TyranWeb's Project SEKAI page (TyranWeb's own, copied next to the character it downloaded): one of
// her outfits (?s=<outfit>), a Live2D model of the game drawn with Live2D's Cubism Core, PixiJS and
// pixi-live2d-display, over the backdrop chosen for downloaded characters.
//
// The game moves a character with two motions at once, one for her body (a gesture: a nod, her head
// tilted, a pose...) and one for her face, and whatever a motion last set stays (her rig stands with
// its arms out until a gesture poses it). So here she takes a pose before she is shown, breathes and
// blinks, and looks after a drag; a touch on her head or on her body plays one of her gestures with a
// face that suits it (her face calms down a while later), and left alone she moves a little now and
// then. Her faces are a layer of their own over her gestures (TyranWeb's curve evaluator, as for
// Azur Lane's effect layer); her gestures are pixi-live2d-display's motions.
// TyranWeb drives it through window.__tyran (backdrop, touch areas).
(() => {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => performance.now() / 1000;
  const pick = (a) => (a.length ? a[Math.floor(Math.random() * a.length)] : '');
  const cfg = { audio: false, volume: 0.6, zones: false, top: 0, color: '#141b29', image: '' };
  const T = (window.__tyran = { ready: false, failed: '', log: [] });
  const params = new URLSearchParams(location.search);
  const card = params.has('card');
  const outfit = params.get('s') || '';
  let hideZones = false;
  let model = null;
  let app = null;
  let look = null;
  let lib = { gestures: [], faces: [] };

  // ---------------------------------------------------------------- what TyranWeb sets
  T.set = (o = {}) => {
    const top = cfg.top;
    Object.assign(cfg, o);
    backdrop();
    if (model && cfg.top !== top) frame(false);
    return true;
  };
  T.volume = (v) => T.set({ volume: v });
  T.audio = (on) => T.set({ audio: !!on });
  T.zones = (on, top) => T.set(typeof top === 'number' ? { zones: !!on, top } : { zones: !!on });
  T.zonesHide = (h) => ((hideZones = !!h), true);

  function backdrop() {
    const b = document.body.style;
    b.backgroundColor = /^#[0-9a-f]{3,8}$/i.test(cfg.color) ? cfg.color : '#141b29';
    // the user's picture, else a soft light from above on the colour
    b.backgroundImage = /^[\w.-]+$/.test(cfg.image || '') ? `url("${cfg.image}")` : 'radial-gradient(120% 95% at 50% 28%, rgba(255,255,255,.12), rgba(0,0,0,.42))';
  }
  backdrop();

  // ---------------------------------------------------------------- her parameters
  let P = null; // { ids, values, minimumValues, maximumValues }
  const index = new Map();
  const partIndex = new Map();
  const at = (id) => (index.has(id) ? index.get(id) : -1);
  const get = (id) => (at(id) >= 0 ? P.values[at(id)] : 0);
  const put = (id, v) => {
    const i = at(id);
    if (i >= 0) P.values[i] = clamp(v, P.minimumValues[i], P.maximumValues[i]);
  };

  // ---------------------------------------------------------------- motion curves
  function curvesOf(json) {
    const out = [];
    for (const c of json.Curves || []) {
      if (c.Target !== 'Parameter' && c.Target !== 'PartOpacity') continue;
      const s = c.Segments || [];
      const segs = [];
      let [t0, v0] = [s[0], s[1]];
      for (let i = 2; i < s.length; ) {
        if (s[i] === 1) {
          segs.push([1, t0, v0, s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5], s[i + 6]]);
          [t0, v0] = [s[i + 5], s[i + 6]];
          i += 7;
        } else {
          segs.push([s[i], t0, v0, s[i + 1], s[i + 2]]);
          [t0, v0] = [s[i + 1], s[i + 2]];
          i += 3;
        }
      }
      out.push({ id: c.Id, part: c.Target === 'PartOpacity', first: s[1], segs });
    }
    return out;
  }
  // a curve's value at a time (linear, stepped, inverse stepped and bezier segments, as Cubism has them)
  function valueAt(c, t) {
    for (const g of c.segs) {
      const end = g[0] === 1 ? g[7] : g[3];
      if (t > end) continue;
      const [type, t0, v0] = g;
      if (type === 0) return g[3] > t0 ? v0 + ((g[4] - v0) * (t - t0)) / (g[3] - t0) : g[4];
      if (type === 2) return v0;
      if (type === 3) return g[4];
      const [, , , c1t, c1v, c2t, c2v, t1, v1] = g;
      const bz = (a, b, c2, d, u) => (1 - u) ** 3 * a + 3 * (1 - u) ** 2 * u * b + 3 * (1 - u) * u * u * c2 + u ** 3 * d;
      let [lo, hi] = [0, 1];
      for (let k = 0; k < 14; k++) {
        const mid = (lo + hi) / 2;
        if (bz(t0, c1t, c2t, t1, mid) < t) lo = mid;
        else hi = mid;
      }
      return bz(v0, c1v, c2v, v1, (lo + hi) / 2);
    }
    const last = c.segs[c.segs.length - 1];
    return last ? (last[0] === 1 ? last[8] : last[4]) : c.first;
  }

  // ---------------------------------------------------------------- her face
  // A face plays once and stays as it ends (until the next), blending in from the one before.
  const FACE_IN = 0.3;
  const faceFiles = new Map();
  const faceJson = (name) => {
    if (!faceFiles.has(name)) faceFiles.set(name, fetch(new URL(`${look.lib}facial/${name}.motion3.json`, location.href)).then((r) => (r.ok ? r.json() : null), () => null));
    return faceFiles.get(name);
  };
  let face = null; // { name, curves, len, t0 }
  let calmAt = 0; // when her face goes back to calm (0: it stays)
  const restFace = () => (lib.faces.includes('face_normal_01') ? 'face_normal_01' : lib.faces.find((f) => /normal|smile/.test(f)) || lib.faces[0] || '');
  function setFace(name, calmAfter = 0) {
    calmAt = calmAfter ? now() + calmAfter : 0;
    if (!name) return Promise.resolve();
    return faceJson(name).then((j) => {
      if (j) face = { name, curves: curvesOf(j), len: Number(j.Meta?.Duration) || 0, t0: now() };
    });
  }
  function applyFace() {
    if (!face) return;
    const t = now() - face.t0;
    const w = clamp(t / FACE_IN, 0, 1);
    const time = face.len > 0 ? Math.min(t, face.len) : 0;
    const parts = model.internalModel.coreModel._model.parts;
    for (const c of face.curves) {
      const v = valueAt(c, time);
      const arr = c.part ? parts.opacities : P.values;
      const i = c.part ? (partIndex.has(c.id) ? partIndex.get(c.id) : -1) : at(c.id);
      if (i >= 0) arr[i] = w >= 1 ? v : arr[i] + (v - arr[i]) * w;
    }
  }
  // she blinks (on top of her face: a closed eye stays closed)
  const blink = { next: now() + 2 + Math.random() * 3, t0: 0 };
  function blinkFactor() {
    const t = now();
    if (!blink.t0 && t >= blink.next) blink.t0 = t;
    if (!blink.t0) return 1;
    const d = t - blink.t0;
    if (d >= 0.22) {
      blink.t0 = 0;
      blink.next = t + 2.5 + Math.random() * 4;
      return 1;
    }
    return d < 0.08 ? 1 - d / 0.08 : (d - 0.08) / 0.14;
  }

  // ---------------------------------------------------------------- her gestures
  // Her gestures are named "w-<style>-<action>": what she does, and the face that goes with it.
  const actionOf = (name) => (/-([a-z]+?)\d*[a-c]?$/i.exec(name)?.[1] || '').toLowerCase();
  const HEAD = ['nod', 'tilthead', 'nodtilthead', 'tiltheadnod', 'lookuptilthead', 'blushed', 'shy', 'cheek', 'wink', 'think'];
  const BODY = ['glad', 'pose', 'piece', 'guts', 'thumb', 'greeting', 'shakehand', 'musical', 'musicall', 'musicalr', 'yurayura', 'wandahoi', 'fidget', 'relief', 'delicious', 'smug', 'forward'];
  const IDLE = ['tilthead', 'nod', 'lookleft', 'lookright', 'lookaround', 'fidget', 'think'];
  const MOOD = {
    glad: 'smile|sparkling|play', pose: 'smile|normal', piece: 'smile|sparkling', guts: 'smile|sparkling', thumb: 'smile', wink: 'smile|play',
    greeting: 'smile', shakehand: 'smile', musical: 'smile|play', musicall: 'smile|play', musicalr: 'smile|play', yurayura: 'smile|play',
    wandahoi: 'sparkling|smile|play', relief: 'smile', delicious: 'smile|sparkling', smug: 'smile|play', forward: 'smile|surprise',
    blushed: 'shy', shy: 'shy', cheek: 'shy|smile', fidget: 'shy|normal', nod: 'smile|normal', tilthead: 'normal|smile|surprise',
    nodtilthead: 'normal|smile', tiltheadnod: 'normal|smile', lookuptilthead: 'normal|surprise', think: 'normal',
    lookleft: 'normal', lookright: 'normal', lookaround: 'normal|surprise',
  };
  const facesOf = (kinds) => lib.faces.filter((f) => new RegExp(`^face_(?:nc|os)?(?:${kinds})_`).test(f));
  const gesturesOf = (actions) => lib.gestures.filter((g) => actions.includes(actionOf(g)));
  const has = (name) => !!model?.internalModel.settings.motions?.[name];
  let playing = false;
  let lastActivity = 0;
  let idleAfter = 30; // (seconds left alone before she moves a little)
  function gesture(name, kinds = '', calmAfter = 7) {
    if (!name || !has(name)) return false;
    model.motion(name, 0, 3);
    playing = true;
    lastActivity = now();
    setFace(pick(facesOf(kinds || MOOD[actionOf(name)] || 'smile|normal')), calmAfter);
    return true;
  }

  T.idle = () => T.ready && !playing;
  T.busy = () => playing;
  T.info = () => ({ ready: T.ready, look: look?.name || '', stance: 'lobby', face: face?.name || '', playing, gestures: lib.gestures.length, faces: lib.faces.length });
  T.model = () => model;
  T.gesture = (name) => gesture(name);
  // the "faces" button: her moods in turn, each with a gesture that suits it (the face stays)
  const MOODS = [['normal', 'Bình thường'], ['smile', 'Cười'], ['shy', 'Ngại'], ['surprise', 'Ngạc nhiên'], ['sparkling', 'Hài lòng'], ['play', 'Đặc biệt']];
  let mood = -1;
  T.faces = () => MOODS.filter(([k]) => facesOf(k).length).map(([k]) => k);
  T.expression = (step = 1) => {
    const list = MOODS.filter(([k]) => facesOf(k).length);
    if (!list.length || !model) return null;
    mood = (((mood + step) % list.length) + list.length) % list.length;
    const [kind, label] = list[mood];
    const fits = lib.gestures.filter((g) => (MOOD[actionOf(g)] || '').split('|').includes(kind) && [...HEAD, ...BODY].includes(actionOf(g)));
    const g = pick(fits);
    if (g) {
      model.motion(g, 0, 3);
      playing = true;
    }
    setFace(pick(facesOf(kind)), 0);
    lastActivity = now();
    return { name: kind, label, index: mood, count: list.length };
  };

  // ---------------------------------------------------------------- where she stands
  // Her drawn height in her model's canvas (measured once: the rows her pose covers), so that every
  // outfit is framed alike: from just above her head down to about her thighs.
  let fit = { top: 0.18, bottom: 0.9, cx: 0.5 };
  const sample = (gl, W, H) => {
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  function measure() {
    const W = model.internalModel.width;
    const H = model.internalModel.height;
    const s = innerHeight / H;
    const x0 = innerWidth / 2 - (W * s) / 2;
    place({ s, x: x0, y: 0 });
    app.renderer.render(app.stage);
    const gl = app.renderer.gl;
    const [bw, bh] = [gl.drawingBufferWidth, gl.drawingBufferHeight];
    const px = sample(gl, bw, bh);
    let [top, bottom, left, right] = [-1, -1, bw, -1];
    for (let y = 0; y < bh; y += 2) {
      const row = (bh - 1 - y) * bw * 4;
      for (let x = 0; x < bw; x += 3) {
        if (px[row + x * 4 + 3] < 40) continue;
        if (top < 0) top = y;
        bottom = y;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    if (top < 0) return;
    const r = bh / innerHeight; // (device pixels)
    fit = { top: top / bh, bottom: bottom / bh, cx: clamp(((left + right) / 2 / r - x0) / (W * s), 0.3, 0.7) };
  }
  // her place in a w x h view whose top is at `top`: her head a little below the top, `share` of her
  // drawn height filling the view
  function placeFor(w, h, top = 0, share = 0.78) {
    const W = model.internalModel.width;
    const H = model.internalModel.height;
    const s = h / ((fit.bottom - fit.top) * H * share);
    return { s, x: w / 2 - fit.cx * W * s, y: top + h * 0.06 - fit.top * H * s };
  }
  let goal = null;
  function frame(jump) {
    if (!model) return;
    const top = clamp(cfg.top, 0, innerHeight * 0.4);
    goal = placeFor(innerWidth, innerHeight - top, top);
    if (jump) place(goal);
  }
  const place = (g) => {
    model.scale.set(g.s);
    model.position.set(g.x, g.y);
  };
  function glide(dt) {
    if (!goal) return;
    const k = 1 - Math.exp(-dt * 8);
    place({ s: model.scale.x + (goal.s - model.scale.x) * k, x: model.x + (goal.x - model.x) * k, y: model.y + (goal.y - model.y) * k });
  }

  // ---------------------------------------------------------------- touches
  // her head and her body, on the page as she stands now
  function areaRects() {
    const W = model.internalModel.width;
    const H = model.internalModel.height;
    const s = model.scale.x;
    const cx = model.x + fit.cx * W * s;
    const headTop = model.y + fit.top * H * s;
    const headH = 0.165 * H * s;
    const bodyBottom = Math.min(innerHeight, model.y + fit.bottom * H * s);
    return [
      { name: 'head', x: cx - 0.13 * W * s, y: headTop, w: 0.26 * W * s, h: headH },
      { name: 'body', x: cx - 0.2 * W * s, y: headTop + headH, w: 0.4 * W * s, h: Math.max(0, bodyBottom - headTop - headH) },
    ];
  }
  // a press is on her when the picture just drawn has her there (the canvas keeps its picture)
  const px = new Uint8Array(4 * 49);
  function onHer(x, y) {
    const gl = app.renderer.gl;
    const r = app.renderer.resolution;
    const H = gl.drawingBufferHeight;
    gl.readPixels(Math.round(x * r) - 3, Math.round(H - y * r) - 3, 7, 7, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let i = 3; i < px.length; i += 4) if (px[i] > 60) return true;
    return false;
  }
  let down = null;
  addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !T.ready) return;
    down = { x: e.clientX, y: e.clientY, t: now(), moved: false };
  });
  addEventListener('pointermove', (e) => {
    if (!model || !down) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) down.moved = true;
    if (down.moved) model.focus(e.clientX, e.clientY); // (she looks after the drag)
  });
  const release = (e) => {
    if (!down) return;
    const d = down;
    down = null;
    model?.internalModel.focusController.focus(0, 0);
    if (e.type !== 'pointerup' || d.moved || now() - d.t > 0.8 || !onHer(d.x, d.y)) return;
    const head = areaRects()[0];
    const onHead = d.y < head.y + head.h;
    gesture(pick(gesturesOf(onHead ? HEAD : BODY)) || pick(lib.gestures));
  };
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);

  // ---------------------------------------------------------------- the touch areas
  const zonesCanvas = document.getElementById('zones');
  const ZONE = { head: '255, 105, 160', body: '90, 190, 255' };
  function drawZones() {
    const dpr = devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr);
    const h = Math.round(innerHeight * dpr);
    if (zonesCanvas.width !== w || zonesCanvas.height !== h) [zonesCanvas.width, zonesCanvas.height] = [w, h];
    const g = zonesCanvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!cfg.zones || hideZones || !model) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const z of areaRects()) {
      const rgb = ZONE[z.name];
      g.fillStyle = `rgba(${rgb}, 0.16)`;
      g.strokeStyle = `rgba(${rgb}, 0.95)`;
      g.lineWidth = 2;
      g.setLineDash([8, 6]);
      g.beginPath();
      g.roundRect(z.x, z.y, z.w, z.h, Math.max(0, Math.min(12, z.w / 2, z.h / 2)));
      g.fill();
      g.stroke();
      g.setLineDash([]);
    }
  }
  T.spots = () => (model ? Object.fromEntries(areaRects().map((z) => [z.name, { x: z.x + z.w / 2, y: z.y + z.h / 2 }])) : null);
  T.frameInfo = () => ({ fit, goal, size: model && [model.internalModel.width, model.internalModel.height] });

  // Her card for Settings (drawn in a hidden window, ?card=1): her upper body, posed.
  T.portrait = (w, h) => {
    if (!model) return '';
    place(placeFor(innerWidth, innerHeight, 0, 0.5));
    app.renderer.render(app.stage);
    const out = document.createElement('canvas');
    [out.width, out.height] = [w, h];
    out.getContext('2d').drawImage(app.view, 0, 0, w, h);
    return out.toDataURL('image/png');
  };

  // ---------------------------------------------------------------- loading
  const script = (src) =>
    new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = () => fail(new Error('script ' + src));
      document.head.append(s);
    });
  (async () => {
    try {
      const M = await (await fetch('manifest.json', { cache: 'no-cache' })).json();
      look = M.looks?.[outfit] || Object.values(M.looks || {})[0];
      if (!look) throw new Error('no outfit');
      lib = M.libs?.[look.lib.replace(/^motion\/|\/$/g, '')] || lib;
      for (const s of ['live2dcubismcore.min.js', 'pixi.min.js', 'cubism4.min.js']) await script(s);
      const canvas = document.getElementById('c');
      app = new PIXI.Application({ view: canvas, resizeTo: window, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: devicePixelRatio || 1, preserveDrawingBuffer: true });
      const json = await (await fetch(look.model, { cache: 'no-cache' })).json();
      json.url = new URL(look.model, location.href).href;
      // (her gestures, from the motion library her outfit moves by, each its own group)
      json.FileReferences.Motions = Object.fromEntries(lib.gestures.map((g) => [g, [{ File: `../../../${look.lib}motion/${g}.motion3.json`, FadeInTime: 0.5, FadeOutTime: 0.5 }]]));
      model = await PIXI.live2d.Live2DModel.from(json, { autoInteract: false });
      const im = model.internalModel;
      P = im.coreModel._model.parameters;
      P.ids.forEach((id, i) => index.set(id, i));
      im.coreModel._model.parts.ids.forEach((id, i) => partIndex.set(id, i));
      im.eyeBlink = undefined; // (she blinks over her face, below)
      const mm = im.motionManager;
      mm.groups.idle = '';
      mm.on('motionFinish', () => (playing = false));
      im.on('afterMotionUpdate', applyFace);
      im.on('beforeModelUpdate', () => {
        const f = blinkFactor();
        if (f < 1) for (const id of ['ParamEyeLOpen', 'ParamEyeROpen']) put(id, get(id) * f);
      });
      app.stage.addChild(model);
      // she poses (out of sight) before she is shown: her rig stands with its arms out until then
      const poseName = lib.gestures.find((g) => /-normal\d*-pose$/i.test(g)) || lib.gestures.find((g) => /-pose$/i.test(g)) || lib.gestures.find((g) => /-(glad|nod)/i.test(g)) || lib.gestures[0];
      await setFace(restFace());
      if (poseName && (await model.motion(poseName, 0, 3))) {
        let t = model.elapsedTime;
        for (let i = 0; i < 60; i++) model.internalModel.update(100, (t += 100));
        model.elapsedTime = t;
      }
      playing = false;
      measure();
      frame(true);
      addEventListener('resize', () => frame(true));
      let last = now();
      app.ticker.add(() => {
        const t = now();
        const dt = Math.min(0.1, t - last);
        last = t;
        glide(dt);
        drawZones();
        if (card) return;
        // her face calms down a while after a touch
        if (calmAt && t > calmAt && !playing) setFace(restFace());
        // left alone, she moves a little now and then
        if (!playing && t - lastActivity > idleAfter) {
          idleAfter = 25 + Math.random() * 20;
          if (!gesture(pick(gesturesOf(IDLE)), 'normal|smile', 5)) lastActivity = t;
        }
      });
      lastActivity = now();
      canvas.classList.add('in');
      T.ready = true;
    } catch (err) {
      T.failed = String(err?.message || err);
      console.warn('sekai: ' + T.failed);
    }
  })();
})();
