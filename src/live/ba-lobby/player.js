// TyranWeb's Blue Archive normal-lobby page (copied into userData/live/ba-lobby by balobby.js): one
// student's standing sprite in Schale's office, as the game's main lobby shows her. ?d=<file>: her
// sprite, the office and her lines (balobby.js).
//
// When the lobby opens she greets Sensei: one of her Enter lines, or the day's (New Year, Christmas,
// Halloween, Sensei's birthday). A tap on her plays one of her lobby lines (her own birthday's first,
// on that day). Each line comes with the face, effect, bubble (said or thought), time and voice the
// game's table gives it; a voice clip runs on over the lines after it that have none. Her effects
// and her blinking are ba-archive's (ba-effects.js, AGPL-3.0), given this page's character.
//
// TyranWeb drives it through window.__tyran (sound, volume, touch areas, start) and hears from it on
// the console when she starts and stops talking (tyran:talk:1 / 0: the lobby music dips meanwhile).
(() => {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cfg = { audio: false, volume: 0.6, zones: false, top: 0, senseiBirthday: '' };
  const T = (window.__tyran = { ready: false, failed: '', started: false });
  let hideZones = false;

  // ---------------------------------------------------------------- what TyranWeb sets
  T.set = (o = {}) => {
    Object.assign(cfg, o);
    cfg.volume = clamp(Number(cfg.volume) || 0, 0, 1);
    if (voice) voice.volume = cfg.volume;
    if (!cfg.audio) stopVoice();
    return true;
  };
  T.volume = (v) => T.set({ volume: v });
  T.audio = (on) => T.set({ audio: !!on });
  T.zones = (on, top) => T.set(typeof top === 'number' ? { zones: !!on, top } : { zones: !!on });
  T.zonesHide = (h) => ((hideZones = !!h), true);

  // ba-archive's effects tween their character as PIXI objects are tweened (gsap's PixiPlugin, the
  // "pixi" property): the same, on the plain object this page gives them
  gsap.registerPlugin({
    name: 'pixi',
    init(target, value) {
      for (const k of Object.keys(value)) this.add(target, k, target[k], value[k]);
      return true;
    },
  });

  // ---------------------------------------------------------------- voice
  let voice = null; // the clip playing
  let talkingNow = false;
  function talking(on) {
    if (on === talkingNow) return;
    talkingNow = on;
    console.debug('tyran:talk:' + (on ? 1 : 0));
  }
  function play(url) {
    stopVoice();
    if (!cfg.audio || !url) return null;
    const el = new Audio(url);
    el.volume = cfg.volume;
    voice = el;
    const done = () => voice === el && (voice = null);
    el.addEventListener('ended', done);
    el.addEventListener('error', done);
    el.play().catch(done);
    return el;
  }
  function stopVoice() {
    if (voice) voice.pause();
    voice = null;
  }
  // until the clip has played through (at most `most` seconds)
  const voiceDone = (el, most) =>
    new Promise((ok) => {
      if (!el || el.ended || voice !== el) return ok();
      const end = () => ok();
      el.addEventListener('ended', end, { once: true });
      el.addEventListener('error', end, { once: true });
      el.addEventListener('pause', end, { once: true });
      setTimeout(end, most * 1000);
    });

  // ---------------------------------------------------------------- drawing
  const canvas = document.getElementById('c');
  const zonesCanvas = document.getElementById('zones');
  const bubble = document.getElementById('bubble');
  let ctx;
  let renderer;
  let gl;
  let rig = null; // { data, skeleton, state }
  let bounds = null; // her picture, in her rig's units: { x, y, w, h }
  let view = { cx: 0, cy: 0, zoom: 1 };
  let W = 0;
  let H = 0;
  let dpr = 1;

  function startGL() {
    ctx = new spine.ManagedWebGLRenderingContext(canvas, { alpha: true, premultipliedAlpha: true, antialias: true });
    renderer = new spine.SceneRenderer(canvas, ctx, true);
    gl = ctx.gl;
  }
  function makeRig(atlas, skel) {
    const data = new spine.SkeletonBinary(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(skel);
    const skeleton = new spine.Skeleton(data);
    skeleton.setToSetupPose();
    const state = new spine.AnimationState(new spine.AnimationStateData(data));
    state.data.defaultMix = 0; // (faces and blinks switch at once, as in the game and ba-archive's player)
    return { data, skeleton, state };
  }
  const has = (name) => !!rig && !!name && !!rig.data.findAnimation(name);
  // the table names a face "02"; some rigs call it "02_respond"
  const faceAnim = (name) => (!rig || !name ? null : rig.data.findAnimation(name) || rig.data.animations.find((a) => a.name.startsWith(name + '_')) || null);

  // The character ba-archive's effects and blinking are given: her rig as `instance` (where she is
  // moved from her place, and her size the effects go by (EFFECT), in the page's pixels, as a PIXI
  // object has them; her skeleton and animation state), her face, and the blinking's own state.
  const actor = { x: 0, y: 0, width: 0, height: 0, skeleton: null, state: null };
  const character = { instance: actor, currentFace: '', winkObject: undefined };

  // Where she stands, as in the game's lobby. Every student's sprite is made to one scale around one
  // point (its root: the halo some 1200-1400 units above it, its picture layer 1000 below), so each
  // is drawn the same way: the window UNITS of them high, its middle LOOK_Y above her root, her root
  // in the middle across. Taller students stand taller, props (wings, a bicycle) change nothing.
  // Fitted to a recording of the game's lobby with Hina (Swimsuit), then drawn a little smaller at the
  // user's wish (1293 -> 1405 units high, her face kept at its height: LOOK_Y 817 -> 792).
  const UNITS = 1405;
  const LOOK_Y = 792;
  // ba-archive's effects move her by a part of her size: given 2/3 of it, they move her 2/3 as far
  // (the user's wish: a third gentler)
  const EFFECT = 2 / 3;
  function frame() {
    if (!bounds || !W || !H) return;
    const zoom = UNITS / H;
    view = { cx: 0, cy: LOOK_Y, zoom };
    actor.width = (bounds.w / zoom / dpr) * EFFECT;
    actor.height = (bounds.h / zoom / dpr) * EFFECT;
  }
  function measure() {
    const sk = rig.skeleton;
    rig.state.apply(sk);
    sk.updateWorldTransform(spine.Physics.update);
    const off = new spine.Vector2();
    const size = new spine.Vector2();
    sk.getBounds(off, size, []);
    bounds = { x: off.x, y: off.y, w: size.x, h: size.y };
  }
  function resize() {
    dpr = devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr);
    const h = Math.round(innerHeight * dpr);
    for (const c of [canvas, zonesCanvas]) if (c.width !== w || c.height !== h) [c.width, c.height] = [w, h];
    if (w === W && h === H) return;
    [W, H] = [w, h];
    frame();
    placeBubble();
  }
  function draw() {
    const cam = renderer.camera;
    cam.setViewport(W, H);
    // (moved by an effect: the camera the other way)
    cam.position.x = view.cx - actor.x * dpr * view.zoom;
    cam.position.y = view.cy + actor.y * dpr * view.zoom;
    cam.zoom = view.zoom;
    gl.viewport(0, 0, W, H);
    renderer.begin();
    renderer.drawSkeleton(rig.skeleton, false);
    renderer.end();
  }

  // ---------------------------------------------------------------- face, effects, bubble
  let rest = ''; // her face between lines
  // (as in the game, a face takes the place of the one before at once)
  function setFace(name) {
    const a = faceAnim(name);
    if (!a) return;
    rig.state.setAnimation(1, a.name, true).mixDuration = 0;
    character.currentFace = name;
    BAEffects.wink(character);
  }
  function effect(name) {
    BAEffects.CharacterEffectPlayerInstance.processEffect(name, character).catch(() => {});
  }
  // The bubble: where the game's lobby has it, beside her face on her left (the window's right), the
  // same place for every student; it stays inside the window. As in the game it fades in where it
  // stands; for the next line its words fade out, the box (kept in place) takes the new words' size,
  // and they fade in; at the end it fades out (index.html).
  const words = bubble.querySelector('.words');
  const measureBox = document.getElementById('measure');
  let bubbleW = 0;
  function placeBubble() {
    const vh = innerHeight;
    const left = innerWidth / 2 + 0.14 * vh;
    bubble.style.left = Math.max(8, Math.min(left, innerWidth - bubbleW - 12)) + 'px';
    bubble.style.top = Math.round(0.43 * vh) + 'px';
  }
  let bubbleSeq = 0;
  function showBubble(text, think) {
    const seq = ++bubbleSeq;
    measureBox.textContent = text;
    const w = Math.ceil(measureBox.getBoundingClientRect().width);
    const h = Math.ceil(measureBox.getBoundingClientRect().height);
    const put = () => {
      words.textContent = text;
      bubble.classList.toggle('think', !!think);
      bubble.style.width = w + 'px';
      bubble.style.height = h + 'px';
      bubbleW = w;
      placeBubble();
    };
    if (!bubble.classList.contains('on')) {
      words.classList.remove('out');
      put();
      bubble.classList.add('on');
      return;
    }
    words.classList.add('out');
    setTimeout(() => {
      if (seq !== bubbleSeq) return;
      put();
      setTimeout(() => seq === bubbleSeq && words.classList.remove('out'), 400);
    }, 250);
  }
  function hideBubble() {
    bubbleSeq++;
    bubble.classList.remove('on');
  }

  // ---------------------------------------------------------------- her lines
  let D = null; // what balobby.js gives: her lines
  const said = {}; // the group said last, of each kind (not twice in a row)
  function pick(kind, list) {
    if (!list?.length) return null;
    const pool = list.length > 1 ? list.filter((g) => g !== said[kind]) : list;
    const g = pool[Math.floor(Math.random() * pool.length)];
    said[kind] = g;
    return g;
  }
  // "12/24" -> 1224 (-1: no date)
  const md = (s) => {
    const m = /^(\d{1,2})\/(\d{1,2})$/.exec(String(s || '').trim());
    return m ? Number(m[1]) * 100 + Number(m[2]) : -1;
  };
  const today = () => {
    const d = new Date();
    return (d.getMonth() + 1) * 100 + d.getDate();
  };
  function enterLines() {
    const t = today();
    if (md(cfg.senseiBirthday) === t && D.userBday.length) return D.userBday[0];
    const day = D.dated.find((x) => md(x.from) > 0 && md(x.to) >= md(x.from) && t >= md(x.from) && t <= md(x.to));
    return day ? day.lines : pick('enter', D.enter);
  }
  let birthdaySaid = false;
  function idleLines() {
    if (!birthdaySaid && md(D.birthday) === today() && D.studentBday.length) {
      birthdaySaid = true;
      return D.studentBday[0];
    }
    return pick('idle', D.idle);
  }

  // one line's time on screen: the table's, else its clip's (or, silent, enough to read it)
  const readTime = (text) => clamp(1.4 + String(text || '').length * 0.07, 2.2, 8);
  let run = 0; // the lines being said (newer ones stop older ones)
  let busy = false;
  const wait = (s, my) => new Promise((ok) => setTimeout(ok, s * 1000)).then(() => my === run);
  async function say(lines) {
    if (!lines?.length || !rig) return;
    const my = ++run;
    busy = true;
    talking(true);
    let clip = null;
    for (const [i, L] of lines.entries()) {
      // her face and effect: with the first line at once; with a later one once the words before
      // have faded out of the bubble, as the game does
      const act = () => {
        if (my !== run) return;
        if (L.face) setFace(L.face);
        if (L.act) effect(L.act);
      };
      if (i && bubble.classList.contains('on')) setTimeout(act, 250);
      else act();
      if (L.text) showBubble(L.text, L.think);
      if (L.voice) clip = play(L.voice);
      const ok = L.ms > 0 ? await wait(L.ms / 1000, my) : clip && voice === clip ? (await voiceDone(clip, 20), my === run) : await wait(readTime(L.text), my);
      if (!ok) return;
    }
    // (a clip longer than its lines' times: the bubble stays until it ends)
    if (clip && voice === clip) await voiceDone(clip, 6);
    if (my !== run) return;
    // (her usual face again as the bubble fades out)
    hideBubble();
    busy = false;
    talking(false);
    if (await wait(0.15, my)) setFace(rest);
  }
  T.idle = () => T.ready && !busy;
  T.talking = () => busy;
  // when the lobby is shown: her greeting
  T.begin = () => {
    if (!T.ready || T.started) return false;
    T.started = true;
    setTimeout(() => say(enterLines()), 450);
    return true;
  };
  // (for the browser's tests) every line she has, and one group said now
  T.info = () => (D ? { name: D.name, face: character.currentFace, busy, enter: D.enter.length, idle: D.idle.length, dated: D.dated.length, userBday: D.userBday.length, studentBday: D.studentBday.length, faces: rig?.data.animations.map((a) => a.name) } : null);
  T.say = (kind, i = 0) => {
    const list = kind === 'dated' ? D?.dated.map((x) => x.lines) : D?.[kind];
    return !!list?.[i] && (say(list[i]), true);
  };
  T.actor = () => ({ ...actor, skeleton: undefined, state: undefined });
  T.face = (name) => (setFace(String(name)), character.currentFace);
  T.rig = () => (rig ? { bounds, bones: rig.skeleton.bones.slice(0, 12).map((b) => `${b.data.name}@${Math.round(b.worldX)},${Math.round(b.worldY)}`), head: ['Head', 'head', 'Touch_Point', 'Bip001 Head'].map((n) => rig.skeleton.findBone(n)).filter(Boolean).map((b) => `${b.data.name}@${Math.round(b.worldX)},${Math.round(b.worldY)}`), slots: rig.skeleton.slots.length } : null);

  // ---------------------------------------------------------------- input
  // presses come from the mouse (Lobby mode) or from the new tab page through TyranWeb
  let down = null;
  const hits = []; // presses waiting for the next frame to tell whether they are on her
  addEventListener('pointerdown', (e) => {
    if (e.button === 0 && T.ready) down = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  const release = (e) => {
    const d = down;
    down = null;
    if (d && e.type === 'pointerup' && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 14 && performance.now() - d.t < 800) hits.push({ x: d.x, y: d.y });
  };
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);
  function tap(onHer) {
    if (!onHer || busy) return;
    if (!T.started) T.started = true;
    say(idleLines());
  }
  // a press is on her when the picture just drawn has her there (any of the pixels around it)
  const px = new Uint8Array(4 * 81);
  function onHer(x, y) {
    const cx = Math.round(x * dpr);
    const cy = Math.round(H - y * dpr);
    gl.readPixels(clamp(cx - 4, 0, W - 9), clamp(cy - 4, 0, H - 9), 9, 9, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let i = 3; i < px.length; i += 4) if (px[i] > 60) return true;
    return false;
  }

  // ---------------------------------------------------------------- touch areas
  // her own shape, tinted, with an outline, from the picture just drawn (as the NIKKE page does)
  function drawZones() {
    const g = zonesCanvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!cfg.zones || hideZones || !T.ready) return;
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-1.5, -1.5], [1.5, 1.5], [-1.5, 1.5], [1.5, -1.5]]) g.drawImage(canvas, dx * dpr, dy * dpr);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = 'rgba(255, 105, 160, 0.95)';
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(canvas, 0, 0);
    g.globalCompositeOperation = 'destination-over';
    g.globalAlpha = 0.22;
    g.drawImage(canvas, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.globalAlpha = 1;
    g.fillStyle = 'rgb(255, 105, 160)';
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- the loop
  let last = 0;
  function loop(ms) {
    requestAnimationFrame(loop);
    const t = ms / 1000;
    const dt = last ? Math.min(1 / 15, t - last) : 0;
    last = t;
    resize();
    rig.state.update(dt);
    rig.state.apply(rig.skeleton);
    rig.skeleton.update(dt);
    rig.skeleton.updateWorldTransform(spine.Physics.update);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    draw();
    // (read while the picture just drawn is still there)
    for (const h of hits.splice(0)) tap(onHer(h.x, h.y));
    drawZones();
  }

  // ---------------------------------------------------------------- loading
  const script = (src) =>
    new Promise((ok, fail) => {
      const sc = document.createElement('script');
      sc.src = src;
      sc.onload = ok;
      sc.onerror = () => fail(new Error('script ' + src));
      document.head.append(sc);
    });
  (async () => {
    try {
      D = await (await fetch(new URLSearchParams(location.search).get('d'), { cache: 'no-cache' })).json();
      document.title = D.name;
      await script('spine-webgl-4.2.min.js');
      startGL();
      // the office behind her (drawn by the page itself), loaded before she shows
      await new Promise((ok) => {
        const im = new Image();
        im.onload = im.onerror = ok;
        im.src = D.bg;
      });
      document.body.style.backgroundImage = `url("${D.bg}")`;
      const assets = new spine.AssetManager(ctx);
      assets.loadBinary(D.spr.skel);
      assets.loadTextureAtlas(D.spr.atlas);
      await assets.loadAll();
      rig = makeRig(assets.require(D.spr.atlas), assets.require(D.spr.skel));
      actor.skeleton = rig.skeleton;
      actor.state = rig.state;
      if (has('Idle_01')) rig.state.setAnimation(0, 'Idle_01', true);
      rest = faceAnim('01') ? '01' : '';
      setFace(rest);
      measure();
      resize();
      T.ready = true;
      requestAnimationFrame(loop);
    } catch (err) {
      T.failed = String(err?.message || err);
      console.warn('ba-lobby: ' + T.failed);
    }
  })();
})();
