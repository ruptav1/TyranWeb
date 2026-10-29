// Sora's shop (Blue Archive) behind the store, while the wallpaper is Blue Archive's lobby: her shop
// drawn behind the page (her Spine rig carries the Angel 24 shop with her at its counter) between
// the store's two panels, the shop's theme playing (BGM 17 "Irasshaimase"), and Sora as in the
// game: she greets you coming in, says one of her seven shop lines when tapped (each with its talk
// animation), likes a pat on the head (a drag there), her eyes follow a drag anywhere else on her,
// and she says goodbye as you leave the page. Her voice comes where her animations say (their
// Sora_Shop_* events, as in the game), from sounds decoded beforehand so it starts on that frame.
// Her files: main/sorashop.js (tyran://sorashop/). The touch handling is the BA lobby's
// (ui/js/wallpaper.js): the rig's Touch_Point / Touch_Eye bones and their _Key bones.
import { api } from 'tyran://shared/page.js';

const BASE = 'tyran://sorashop/';
const TALKS = 7;
const LINES = ['in_1', 'in_2', 'out_1', 'out_2', ...Array.from({ length: TALKS }, (_, i) => `talk_${i + 1}`)];
const VIEW_H = 1750; // (rig units in sight up and down: Sora from above her halo to the counter)
let run = null;

const script = (src) =>
  new Promise((ok, fail) => {
    if (window.spine) return ok();
    const sc = document.createElement('script');
    sc.src = src;
    sc.onload = ok;
    sc.onerror = () => fail(new Error('script'));
    document.head.append(sc);
  });

const volumes = (s) => {
  const w = s?.wallpaper?.web || {};
  const all = w.volume ?? 0.6;
  return { music: Math.min(1, all * (w.musicVolume ?? 1)), voice: Math.min(1, all * (w.voiceVolume ?? 1)) };
};

export async function start(s) {
  if (run) return;
  const me = (run = { s, stopped: false });
  try {
    await api.invoke('sorashop:prepare');
    await script(BASE + 'spine-webgl.js');
    if (me.stopped) return;
    await setup(me);
  } catch (err) {
    console.warn('sora shop: ' + (err?.message || err));
    if (run === me) run = null;
  }
}

export function stop() {
  if (!run) return;
  const me = run;
  run = null;
  me.stopped = true;
  cancelAnimationFrame(me.raf);
  me.theme?.pause();
  me.actx?.close().catch(() => {});
  me.off?.();
  document.documentElement.classList.remove('shop');
  document.getElementById('sora').hidden = true;
}

export function settings(s) {
  if (!run) return;
  run.s = s;
  const v = volumes(s);
  if (run.theme) run.theme.volume = v.music;
  if (run.gain) run.gain.gain.value = v.voice;
}

async function setup(me) {
  const spine = window.spine;
  const canvas = document.getElementById('sora');
  canvas.hidden = false;
  const ctx = new spine.ManagedWebGLRenderingContext(canvas, { alpha: true, premultipliedAlpha: true, antialias: true });
  const renderer = new spine.SceneRenderer(canvas, ctx, true);
  const gl = ctx.gl;
  const assets = new spine.AssetManager(ctx, BASE);
  assets.loadBinary('sora_shop.skel');
  assets.loadTextureAtlas('sora_shop.atlas');
  // her lines, decoded now: each starts on the frame its event comes
  const actx = new AudioContext();
  const gain = actx.createGain();
  gain.gain.value = volumes(me.s).voice;
  gain.connect(actx.destination);
  const voices = {};
  const decoded = Promise.all(
    LINES.map(async (n) => {
      try {
        voices[n] = await actx.decodeAudioData(await (await fetch(`${BASE}sora_shop_${n}.ogg`)).arrayBuffer());
      } catch {
        /* (that one stays silent) */
      }
    })
  );
  await Promise.all([assets.loadAll(), decoded]);
  if (me.stopped) return actx.close().catch(() => {});
  Object.assign(me, { actx, gain });
  const data = new spine.SkeletonBinary(new spine.AtlasAttachmentLoader(assets.require('sora_shop.atlas'))).readSkeletonData(assets.require('sora_shop.skel'));
  const sk = new spine.Skeleton(data);
  sk.setToSetupPose();
  const state = new spine.AnimationState(new spine.AnimationStateData(data));
  state.data.defaultMix = 0.15;
  const has = (n) => !!n && !!data.findAnimation(n);
  const bone = (n) => sk.bones.find((b) => b.data.name.toLowerCase() === n.toLowerCase()) || null;
  const rig = { point: bone('Touch_Point'), eye: bone('Touch_Eye'), pointKey: bone('Touch_Point_Key'), eyeKey: bone('Touch_Eye_Key') };
  window.__sora = { said: '' };

  // ---- her voice
  let playing = null;
  let busyUntil = 0;
  const say = (line) => {
    const buf = voices[line];
    if (!buf) return;
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    try {
      playing?.stop();
    } catch {
      /* ended */
    }
    playing = actx.createBufferSource();
    playing.buffer = buf;
    playing.connect(gain);
    playing.start();
    busyUntil = Math.max(busyUntil, performance.now() + buf.duration * 1000);
    window.__sora.said = line;
  };
  // (Sora_Shop_Talk_3 in Talk_03_M, Sora_Shop_In_2 in Start01_Idle_01...)
  state.addListener({
    event: (entry, ev) => {
      const m = /^Sora_Shop_(In|Out|Talk)_(\d+)$/i.exec(ev.data.name);
      if (m) say(`${m[1].toLowerCase()}_${m[2]}`);
    },
  });

  // where things are: the whole shop, and Sora in it (her own pictures, not the shop's nor what she holds)
  const isShop = (slot) => /^(bg|frontdesk|halo|e_|l_card)/i.test(slot.data.name);
  state.setAnimation(0, 'Idle_01', true);
  state.apply(sk);
  sk.updateWorldTransform(spine.Physics.update);
  const box = (want) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const v = [];
    for (const slot of sk.drawOrder) {
      const a = slot.getAttachment();
      if (!a || !want(slot)) continue;
      let n = 0;
      if (a instanceof spine.RegionAttachment) {
        a.computeWorldVertices(slot, v, 0, 2);
        n = 8;
      } else if (a instanceof spine.MeshAttachment) {
        a.computeWorldVertices(slot, 0, a.worldVerticesLength, v, 0, 2);
        n = a.worldVerticesLength;
      }
      for (let i = 0; i < n; i += 2) {
        x0 = Math.min(x0, v[i]);
        x1 = Math.max(x1, v[i]);
        y0 = Math.min(y0, v[i + 1]);
        y1 = Math.max(y1, v[i + 1]);
      }
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  const scene = box(() => true);
  const her = box((slot) => !isShop(slot));
  const head = rig.point ? { x: rig.point.worldX, y: rig.point.worldY } : { x: her.x + her.w / 2, y: her.y + her.h * 0.8 };
  Object.assign(window.__sora, { scene, her, point: [head.x, head.y], eye: rig.eye && [rig.eye.worldX, rig.eye.worldY], view: null });

  // ---- framing: the shop covers the window, her head in the middle of the gap between the panels
  const view = { x: 0, y: 0, zoom: 1 };
  let W = 0, H = 0, dpr = 1;
  // (the gap between the panels, in the window's pixels)
  const gap = () => {
    const side = document.querySelector('.store-side')?.getBoundingClientRect();
    const res = document.querySelector('.store-results')?.getBoundingClientRect();
    return side && res && res.left > side.right ? [side.right, res.left] : [0, innerWidth];
  };
  const frame = () => {
    dpr = devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr);
    const hgt = Math.round(innerHeight * dpr);
    if (w !== canvas.width || hgt !== canvas.height) [canvas.width, canvas.height] = [w, hgt];
    [W, H] = [w, hgt];
    const [l, r] = gap().map((x) => x * dpr);
    const g = (l + r) / 2; // (where her head goes across)
    // the shop covers the whole window (no edge of it behind the panels); a little closer in when
    // that is what it takes to have her head in the middle of the gap
    view.zoom = Math.min(VIEW_H / H, scene.w / W, scene.h / H, g > 0 ? (head.x - scene.x) / g : Infinity, W > g ? (scene.x + scene.w - head.x) / (W - g) : Infinity);
    const half = (W * view.zoom) / 2;
    const halfH = (H * view.zoom) / 2;
    const cx = head.x + (W / 2 - g) * view.zoom;
    const cy = head.y - 0.2 * H * view.zoom;
    view.x = Math.min(Math.max(cx, scene.x + half), scene.x + scene.w - half);
    view.y = Math.min(Math.max(cy, scene.y + halfH), scene.y + scene.h - halfH);
    window.__sora.view = { ...view, W, H };
  };

  // ---- touches, as in the lobby: a tap talks, a drag on her head pats, a drag elsewhere on her looks
  const touch = { mode: '', start: null, at: null, client: null, moved: false, down: 0, key: { x: 0, y: 0 }, eye: { x: 0, y: 0 } };
  const toWorld = (cx, cy) => {
    const p = renderer.camera.screenToWorld(new spine.Vector3(cx * dpr, cy * dpr, 0), W, H);
    return { x: p.x, y: p.y };
  };
  const unit = rig.point && rig.eye ? Math.min(600, Math.max(120, Math.hypot(rig.point.worldX - rig.eye.worldX, rig.point.worldY - rig.eye.worldY))) : 250;
  const onHer = (p) => p.x >= her.x && p.x <= her.x + her.w && p.y >= her.y && p.y <= her.y + her.h;
  const onHead = (p) => rig.point && Math.hypot(p.x - rig.point.worldX, p.y - rig.point.worldY) < unit * 1.1 && (!rig.eye || p.y > rig.eye.worldY + unit * 0.15);
  const play = (a, m, loop) => {
    for (const [track, name] of [[1, a], [2, m]]) if (has(name)) state.setAnimation(track, name, loop).mixDuration = 0.15;
  };
  const finish = (a, m) => {
    play(a, m, false);
    state.addEmptyAnimation(1, 0.2, 0);
    state.addEmptyAnimation(2, 0.2, 0);
  };
  let lastTalk = 0;
  const talk = () => {
    if (performance.now() < busyUntil) return;
    let n = 1 + Math.floor(Math.random() * TALKS);
    if (n === lastTalk) n = (n % TALKS) + 1;
    lastTalk = n;
    // (her line comes with the animation's own event, a moment in)
    finish(`Talk_0${n}_A`, `Talk_0${n}_M`);
    busyUntil = performance.now() + 1000;
  };
  const down = (e) => {
    if (e.button !== 0) return;
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    if (performance.now() < busyUntil) return; // (she is talking: nothing until she is done)
    const p = toWorld(e.clientX, e.clientY);
    if (!onHer(p)) return;
    Object.assign(touch, { start: p, at: p, client: [e.clientX, e.clientY], moved: false, mode: '', down: performance.now(), area: onHead(p) ? 'pat' : 'look' });
    canvas.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (!touch.start) {
      canvas.style.cursor = performance.now() >= busyUntil && onHer(toWorld(e.clientX, e.clientY)) ? 'pointer' : 'default';
      return;
    }
    touch.at = toWorld(e.clientX, e.clientY);
    if (!touch.mode && Math.hypot(e.clientX - touch.client[0], e.clientY - touch.client[1]) > 6) {
      touch.moved = true;
      touch.mode = touch.area;
      if (touch.mode === 'pat') play('Pat_01_A', 'Pat_01_M', true);
      else play('Look_01_A', 'Look_01_M', true);
    }
  };
  const up = () => {
    if (!touch.start) return;
    if (touch.mode === 'pat') finish('PatEnd_01_A', 'PatEnd_01_M');
    else if (touch.mode === 'look') finish('LookEnd_01_A', 'LookEnd_01_M');
    else if (!touch.moved && performance.now() - touch.down < 600) talk();
    touch.mode = '';
    touch.start = touch.at = null;
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  // the key bones follow the finger (from the setup pose each frame, so nothing piles up)
  const nudge = (b, off) => {
    if (!b || (!off.x && !off.y)) return;
    const p = b.parent;
    const local = p.worldToLocal(new spine.Vector2(p.worldX + off.x, p.worldY + off.y));
    b.x += local.x;
    b.y += local.y;
  };
  const want = (mode, from, limit, g) => {
    if (touch.mode !== mode || !touch.at || !from) return { x: 0, y: 0 };
    let dx = (touch.at.x - from.x) * g;
    let dy = (touch.at.y - from.y) * g;
    const len = Math.hypot(dx, dy);
    if (len > limit) [dx, dy] = [(dx * limit) / len, (dy * limit) / len];
    return { x: dx, y: dy };
  };
  const ease = (cur, target) => {
    cur.x += (target.x - cur.x) * 0.25;
    cur.y += (target.y - cur.y) * 0.25;
  };

  // ---- coming in (her opening and greeting, once), leaving (her goodbye); the theme while seen
  me.theme = new Audio(BASE + 'theme.ogg');
  me.theme.loop = true;
  me.theme.volume = volumes(me.s).music;
  let entered = false;
  const enter = () => {
    entered = true;
    const n = 1 + Math.floor(Math.random() * 2);
    if (!has(`Start0${n}_Idle_01`)) return;
    state.setAnimation(0, `Start0${n}_Idle_01`, false);
    state.addAnimation(0, 'Idle_01', true, 0);
    busyUntil = performance.now() + 2500;
  };
  const visibility = () => {
    // (back to the tab: she carries on where she was, her opening is only for coming into the shop)
    if (document.hidden) {
      me.theme.pause();
      say(`out_${1 + Math.floor(Math.random() * 2)}`);
    } else {
      me.theme.play().catch(() => {});
      if (!entered) enter(); // (the store opened in a tab behind: her greeting when it is first seen)
    }
  };
  document.addEventListener('visibilitychange', visibility);
  // (a wallpaper bought: a word from her)
  const bought = () => setTimeout(talk, 300);
  window.addEventListener('store:bought', bought);
  me.off = () => {
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('store:bought', bought);
  };

  let last = 0;
  const loop = (ms) => {
    me.raf = requestAnimationFrame(loop);
    const dt = last ? Math.min(1 / 15, (ms - last) / 1000) : 0;
    last = ms;
    frame();
    state.update(dt);
    for (const b of [rig.pointKey, rig.eyeKey]) if (b) [b.x, b.y] = [b.data.x, b.data.y];
    state.apply(sk);
    ease(touch.eye, want('look', rig.eye && { x: rig.eye.worldX, y: rig.eye.worldY }, 0.35 * unit, 0.12));
    ease(touch.key, want('pat', touch.start, 0.45 * unit, 0.6));
    sk.update(dt);
    sk.updateWorldTransform(spine.Physics.update);
    if (touch.eye.x || touch.eye.y || touch.key.x || touch.key.y) {
      nudge(rig.eyeKey, touch.eye);
      nudge(rig.pointKey, touch.key);
      sk.updateWorldTransform(spine.Physics.update);
    }
    const cam = renderer.camera;
    cam.setViewport(W, H);
    cam.position.x = view.x;
    cam.position.y = view.y;
    cam.zoom = view.zoom;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.81, 0.89, 0.95, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.begin();
    renderer.drawSkeleton(sk, false); // (its pictures are straight alpha, as the lobbies')
    renderer.end();
  };
  document.documentElement.classList.add('shop');
  frame();
  me.raf = requestAnimationFrame(loop);
  if (!document.hidden) {
    me.theme.play().catch(() => {});
    enter();
  }
}
