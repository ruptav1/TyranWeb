// TyranWeb's NIKKE lobby page (TyranWeb's own, copied next to the character it downloaded): one
// Nikke, in her own outfit or another one downloaded beside her (?o=<outfit>), drawn with the
// official Spine runtime for the web her models were made for (spine-webgl 4.0 or 4.1), over a
// colour or a picture of the user's.
//
// Sảnh (lobby): she stands and breathes. A tap on her plays one of her lobby lines with her
// reaction (the rig's "action") while her mouth moves; tapping her again and again makes her cross
// ("angry" and a hurt line); left alone for a while she says her lobby "stay" line.
// Chiến đấu (battle): seen from behind at her cover, as in a fight. Holding the button down she
// rises to aim at the pointer and fires; with the magazine empty she ducks to reload; letting go she
// takes cover again. Her battle lines come with these.
//
// TyranWeb drives it through window.__tyran (sound, volume, stance, background, touch areas) and
// hears from it on the console when she starts and stops talking (tyran:talk:1 / 0).
(() => {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => performance.now() / 1000;
  const cfg = { audio: false, volume: 0.6, stance: 'lobby', zones: false, top: 0, color: '#141b29', image: '' };
  const T = (window.__tyran = { ready: false, failed: '', log: [] });
  let started = false;
  let hideZones = false;

  // ---------------------------------------------------------------- what TyranWeb sets
  T.set = (o = {}) => {
    const top = cfg.top;
    Object.assign(cfg, o);
    if (started && cfg.top !== top) reframe = true; // (she moves down below the browser's bars, or back up)
    cfg.volume = clamp(Number(cfg.volume) || 0, 0, 1);
    backdrop();
    if (voice) voice.el.volume = cfg.volume;
    if (!cfg.audio) stopVoice();
    if (started) setStance(cfg.stance === 'battle' ? 'battle' : 'lobby');
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

  // ---------------------------------------------------------------- voices
  let voice = null; // { el, name }
  let talkingNow = false;
  const lastLine = {};
  let lines = [];
  let voiceDir = 'voice/'; // (an outfit that is a unit of her own speaks from its folder)
  const GROUPS = {
    touch: /_Lobby_Touch_(Love_)?\d/i,
    stay: /_Lobby_Stay_/i,
    poke: /_Damage_\d/i,
    enter: /_Battle_(Enter|Ready)_\d/i,
    reload: /_Reload_\d/i,
    kill: /_Kill_Monster_\d/i,
    burst: /_FullBurst_\d/i,
    win: /_Win_\d/i,
  };
  // a line of the group, not the one said last time
  function line(group) {
    const all = lines.filter((n) => GROUPS[group].test(n));
    const pool = all.length > 1 ? all.filter((n) => n !== lastLine[group]) : all;
    const n = pool[Math.floor(Math.random() * pool.length)] || '';
    lastLine[group] = n;
    return n;
  }
  function say(name) {
    stopVoice();
    if (!cfg.audio || !name) return false;
    const el = new Audio(voiceDir + name);
    el.volume = cfg.volume;
    const v = (voice = { el, name, env: null });
    loudnessOf(name).then((env) => (v.env = env), () => {});
    el.onended = el.onerror = () => voice?.el === el && stopVoice();
    el.play().then(() => voice?.el === el && talking(true), () => voice?.el === el && stopVoice());
    return true;
  }
  function stopVoice() {
    if (voice) voice.el.pause();
    voice = null;
    talking(false);
  }
  function talking(on) {
    if (on === talkingNow) return;
    talkingNow = on;
    console.debug('tyran:talk:' + (on ? 1 : 0));
  }

  // ---------------------------------------------------------------- lip sync
  // Her mouth follows the line she says: how loud it is, 60 times a second (read from the voice
  // file itself, so it is the same at any volume), opens her mouth that far. The shapes are the
  // rig's own: its talk animation (the lobby) or its grimace when hit (behind cover) goes from
  // closed to wide open, and the lip sync takes the moment of it that is as open as the line is loud.
  const ENV_RATE = 60;
  const loudness = new Map();
  let decoder = null;
  function loudnessOf(name) {
    if (!loudness.has(name)) {
      loudness.set(
        name,
        (async () => {
          const data = await (await fetch(voiceDir + name)).arrayBuffer();
          decoder ||= new OfflineAudioContext(1, 1, 22050);
          const audio = await decoder.decodeAudioData(data);
          const chans = [...Array(audio.numberOfChannels)].map((_, i) => audio.getChannelData(i));
          const hop = audio.sampleRate / ENV_RATE;
          const n = Math.ceil(audio.length / hop);
          const rms = new Float32Array(n);
          for (let i = 0; i < n; i++) {
            const a = Math.max(0, Math.floor((i - 0.5) * hop));
            const b = Math.min(audio.length, Math.floor((i + 1) * hop));
            let sum = 0;
            for (const c of chans) for (let k = a; k < b; k++) sum += c[k] * c[k];
            rms[i] = Math.sqrt(sum / Math.max(1, (b - a) * chans.length));
          }
          // against the line's own loud parts (every line opens her mouth fully), breaths left out
          const sorted = [...rms].sort((x, y) => x - y);
          const peak = sorted[Math.floor(sorted.length * 0.95)] || 1e-3;
          const floor = Math.max(peak * 0.12, 0.006);
          return rms.map((x) => clamp((x - floor) / Math.max(1e-4, peak - floor), 0, 1) ** 0.75);
        })()
      );
    }
    return loudness.get(name);
  }

  // A rig's mouth: `anim` (all of a talk animation; of her grimace behind cover only what moves the
  // mouth), measured at each moment by the box around the mouth's pictures (lips, teeth...). Rapi's
  // talk animation swaps between three pictures (closed, half and wide open); other models may move
  // the lips with bones and open gradually.
  const MOUTH = /mouth|lip|teeth|teath|tooth|tongue|jaw/i;
  function lipsOf(r, anim, base, onlyMouth) {
    const src = r.data.findAnimation(anim);
    if (!src) return null;
    const d = r.data;
    const mouthSlot = (i) => MOUTH.test(d.slots[i].name) || MOUTH.test(d.slots[i].boneData.name);
    const own = onlyMouth ? src.timelines.filter((t) => (t.slotIndex !== undefined ? mouthSlot(t.slotIndex) : t.boneIndex !== undefined && MOUTH.test(d.bones[t.boneIndex].name))) : src.timelines;
    if (!own.length) return null;
    const lip = new spine.Animation('lips', own, src.duration);
    const sk = r.skeleton;
    const slots = sk.slots.filter((s, i) => mouthSlot(i));
    if (!slots.length) return null;
    // (Spine 4.1 places a region attachment from its slot, 4.0 from its bone)
    const regionBy = d.version.startsWith('4.0') ? (sl) => sl.bone : (sl) => sl;
    const tmp = new Float32Array(16384);
    const area = () => {
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const sl of slots) {
        const a = sl.getAttachment();
        let n = 8;
        if (a instanceof spine.RegionAttachment) a.computeWorldVertices(regionBy(sl), tmp, 0, 2);
        else if (a instanceof spine.MeshAttachment && a.worldVerticesLength <= tmp.length) {
          n = a.worldVerticesLength;
          a.computeWorldVertices(sl, 0, n, tmp, 0, 2);
        } else continue;
        for (let i = 0; i < n; i += 2) {
          x0 = Math.min(x0, tmp[i]);
          x1 = Math.max(x1, tmp[i]);
          y0 = Math.min(y0, tmp[i + 1]);
          y1 = Math.max(y1, tmp[i + 1]);
        }
      }
      return x1 > x0 ? (x1 - x0) * (y1 - y0) : 0;
    };
    const baseAnim = r.data.findAnimation(base);
    const times = [];
    const opens = [];
    for (let t = 0; t <= src.duration + 1e-6; t += 1 / 120) {
      sk.setToSetupPose();
      baseAnim?.apply(sk, 0, 0, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
      lip.apply(sk, t, t, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
      sk.updateWorldTransform();
      times.push(t);
      opens.push(area());
    }
    r.state.apply(sk);
    sk.updateWorldTransform();
    // for each of 21 steps from closed to widest, the moment that is open about that much
    const lo = Math.min(...opens);
    const span = Math.max(...opens) - lo;
    if (!(span > 0)) return null;
    const norm = opens.map((h) => (h - lo) / span);
    const levels = [];
    for (let k = 0; k <= 20; k++) {
      let best = 0;
      for (let i = 1; i < norm.length; i++) if (Math.abs(norm[i] - k / 20) < Math.abs(norm[best] - k / 20) - 1e-6) best = i;
      levels.push(times[best]);
    }
    // (where the mouth is: the first picture that changes)
    const at = slots.find((s) => own.some((t) => t.slotIndex === s.data.index)) || slots[0];
    return { anim: lip, slots, at, levels, curve: norm, open: 0, on: false, span };
  }
  // the moment of the mouth's animation that is open `o` (0 closed .. 1 widest)
  const lipTime = (L, o) => L.levels[Math.round(clamp(o, 0, 1) * 20)];
  // each frame, after the rig's own animations: her mouth while she talks, else back to them
  function lipStep(r, dt) {
    const L = r.lips;
    if (!L) return;
    if (talkingNow && voice && !voice.el.paused) {
      let want;
      if (voice.env) want = voice.env[Math.floor((voice.el.currentTime + 0.04) * ENV_RATE)] ?? 0;
      else want = 0.45 + 0.4 * Math.sin(now() * 17); // (until the line's loudness is read)
      L.open += (want - L.open) * (1 - Math.exp(-dt * (want > L.open ? 32 : 16)));
      const t = lipTime(L, L.open);
      L.anim.apply(r.skeleton, t, t, false, [], 1, spine.MixBlend.replace, spine.MixDirection.mixIn);
      L.on = true;
    } else if (L.on) {
      // closed again, her pictures as they were (her other animations take her mouth back)
      L.on = false;
      L.open = 0;
      L.anim.apply(r.skeleton, 0, 0, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
    }
  }
  T.lips = () => Object.fromEntries(Object.entries(rigs).map(([k, r]) => [k, r.lips ? { open: +r.lips.open.toFixed(2), on: r.lips.on, span: +r.lips.span.toFixed(1), curve: r.lips.curve.map((x) => Math.round(x * 9)).join(''), levels: r.lips.levels.map((t) => t.toFixed(2)).join(' ') } : null]));
  // where a rig's mouth is on the page (for the browser's tests)
  T.mouthAt = (k) => {
    const r = rigs[k];
    const b = r?.lips?.at.bone;
    return b ? toScreen(r.view, b.worldX, b.worldY) : null;
  };
  T.loudness = async (name) => Array.from(await loudnessOf(name)).map((x) => +x.toFixed(2));

  // ---------------------------------------------------------------- drawing
  const canvas = document.getElementById('c');
  const hud = document.getElementById('hud');
  const zonesCanvas = document.getElementById('zones');
  let ctx;
  let renderer;
  let gl;
  // (once the runtime for her models is loaded)
  function startGL() {
    try {
      ctx = new spine.ManagedWebGLRenderingContext(canvas, { alpha: true, premultipliedAlpha: true, antialias: true });
      renderer = new spine.SceneRenderer(canvas, ctx, true);
      gl = ctx.gl;
      return true;
    } catch {
      T.failed = 'webgl';
      return false;
    }
  }
  const rigs = {}; // lobby, cover, aim: { data, skeleton, state, alpha, want, view }
  let stance = '';
  let W = 0;
  let H = 0;
  let dpr = 1;

  function makeRig(atlas, skel, skins) {
    const loader = new spine.AtlasAttachmentLoader(atlas);
    // (a few models made with Spine 4.1 name a picture of a sequence that their atlas does not have:
    // the sequence's own name, or another of its pictures, takes its place, as other viewers do)
    if (loader.loadSequence) {
      const own = loader.loadSequence.bind(loader);
      loader.loadSequence = (name, basePath, sequence) => {
        try {
          return own(name, basePath, sequence);
        } catch (err) {
          const any = atlas.findRegion(basePath) || atlas.findRegion(name) || atlas.regions.find((r) => r.name.startsWith(basePath)) || atlas.regions.find((r) => r.name.startsWith(name));
          if (!any) throw err;
          for (let i = 0; i < sequence.regions.length; i++) {
            const r = atlas.findRegion(sequence.getPath(basePath, i)) || any;
            sequence.regions[i] = r;
            r.renderObject = r;
          }
        }
      };
    }
    const data = new spine.SkeletonBinary(loader).readSkeletonData(skel);
    const skeleton = new spine.Skeleton(data);
    if (skins?.length) wear(skeleton, skins);
    else {
      // (a model keeping its pictures in a named skin, the default one nearly empty)
      const named = data.skins.filter((x) => x !== data.defaultSkin);
      const used = data.slots.filter((x) => x.attachmentName).length;
      if (named.length && (data.defaultSkin?.getAttachments().length || 0) < used * 0.5) wear(skeleton, ['default', (named.find((x) => ['00', 'acc', 'bg', 'weapon_1'].includes(x.name)) || named[0]).name]);
    }
    const state = new spine.AnimationState(new spine.AnimationStateData(data));
    state.data.defaultMix = 0.2;
    return { data, skeleton, state, alpha: 0, want: 0, view: { cx: 0, cy: 0, zoom: 1 } };
  }
  const has = (r, name) => !!r && !!name && !!r.data.findAnimation(name);
  // a model's skins worn together (its default one and, for some, extra parts in another)
  function wear(sk, names) {
    const all = new spine.Skin(names.join('+'));
    for (const n of names) {
      const s = sk.data.findSkin(n);
      if (s) all.addSkin(s);
    }
    sk.setSkin(all);
    sk.setSlotsToSetupPose();
  }
  T.wear = (k, names) => (rigs[k] ? (wear(rigs[k].skeleton, names), true) : false);

  function drawRig(r, v) {
    const cam = renderer.camera;
    cam.setViewport(W, H);
    cam.position.x = v.cx;
    cam.position.y = v.cy;
    cam.zoom = v.zoom;
    gl.viewport(0, 0, W, H);
    renderer.begin();
    renderer.drawSkeleton(r.skeleton, true);
    renderer.end();
  }

  // What the rig really draws in a pose (the first frame of `anim`), in its own units: drawn whole
  // once (never shown: cleared before the frame's picture) and read back. Its attachments' boxes
  // alone would count hidden and empty parts.
  const pixels = { buf: null };
  function measure(r, anim) {
    const sk = r.skeleton;
    sk.setToSetupPose();
    if (has(r, anim)) r.data.findAnimation(anim).apply(sk, 0, 0, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
    sk.updateWorldTransform();
    const off = new spine.Vector2();
    const size = new spine.Vector2();
    sk.getBounds(off, size, []);
    const v = { cx: off.x + size.x / 2, cy: off.y + size.y / 2, zoom: Math.max(size.x / W, size.y / H) * 1.02 };
    sk.color.a = 1;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawRig(r, v);
    if (pixels.buf?.length !== W * H * 4) pixels.buf = new Uint8Array(W * H * 4);
    const px = pixels.buf;
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.clear(gl.COLOR_BUFFER_BIT);
    let [x0, y0, x1, y1] = [W, H, -1, -1];
    for (let y = 0; y < H; y += 2) {
      for (let x = 0, i = (y * W) * 4 + 3; x < W; x += 2, i += 8) {
        if (px[i] < 24) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    const head = sk.findBone('head');
    const b = { head: head ? { x: head.worldX, y: head.worldY } : null };
    if (x1 < 0) Object.assign(b, { x: off.x, y: off.y, w: size.x, h: size.y });
    else {
      // (readPixels' rows go up from the bottom, like the rig's units)
      const wx = (x) => v.cx + (x - W / 2) * v.zoom;
      const wy = (y) => v.cy + (y - H / 2) * v.zoom;
      Object.assign(b, { x: wx(x0), y: wy(y0), w: (x1 - x0 + 2) * v.zoom, h: (y1 - y0 + 2) * v.zoom });
    }
    r.state.apply(sk); // (back to where it was)
    sk.updateWorldTransform();
    return b;
  }

  // Where each rig is drawn, in the part of the window the browser's bars leave visible (all of it
  // in Lobby mode): in the lobby she fills its height from just above her head to her thighs, in the
  // middle; in battle she is at the bottom, from behind, as tall as about four fifths of it. A new
  // place is reached smoothly (the bars shown or hidden).
  const sizes = {}; // measured for the window's size
  function frameAll() {
    if (!W || !H) return;
    const top = clamp(cfg.top * dpr, 0, H * 0.4);
    const vh = H - top;
    if (sizes.for !== W + 'x' + H) {
      sizes.for = W + 'x' + H;
      for (const [k, anim] of [['lobby', 'idle'], ['cover', 'cover_idle'], ['aim', 'aim_idle']]) if (rigs[k]) sizes[k] = measure(rigs[k], anim);
      T.sizes = sizes;
    }
    const lb = sizes.lobby;
    if (lb) {
      const zoom = Math.max((lb.h * 0.66) / vh, (lb.w * 1.08) / W);
      const head = lb.y + lb.h + lb.h * 0.015;
      rigs.lobby.goal = { cx: lb.head ? (lb.head.x + lb.x + lb.w / 2) / 2 : lb.x + lb.w / 2, cy: head - (H / 2 - top) * zoom, zoom };
      rigs.lobby.bounds = lb;
    }
    // in battle: standing up to aim she is about 85% of the height, her feet at the bottom; behind
    // cover (drawn in the same place, the two rigs are made to line up) she is lower
    const ab = sizes.aim || sizes.cover;
    if (ab) {
      const both = sizes.cover && sizes.aim ? { x0: Math.min(sizes.cover.x, ab.x), x1: Math.max(sizes.cover.x + sizes.cover.w, ab.x + ab.w) } : { x0: ab.x, x1: ab.x + ab.w };
      const zoom = Math.max(ab.h / (vh * 0.85), ((both.x1 - both.x0) * 1.1) / W);
      const goal = { cx: (both.x0 + both.x1) / 2, cy: ab.y - ab.h * 0.02 + (H / 2) * zoom, zoom };
      if (rigs.cover) rigs.cover.goal = goal;
      if (rigs.aim) rigs.aim.goal = goal;
    }
    for (const r of Object.values(rigs)) if (!framed) r.view = { ...r.goal };
    framed = true;
  }
  let framed = false;
  let reframe = false;
  function glide(r, dt) {
    const g = r.goal;
    if (!g) return;
    const k = 1 - Math.exp(-dt * 8);
    for (const p of ['cx', 'cy', 'zoom']) r.view[p] += (g[p] - r.view[p]) * k;
  }

  function resize() {
    dpr = devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr);
    const h = Math.round(innerHeight * dpr);
    for (const c of [canvas, hud, zonesCanvas]) if (c.width !== w || c.height !== h) [c.width, c.height] = [w, h];
    if (w === W && h === H) return;
    [W, H] = [w, h];
    framed = false; // (a new size: straight there)
    frameAll();
    gl.clearColor(0, 0, 0, 0);
  }

  // world (the rig's units) <-> the page's pixels, for a rig's view
  const toScreen = (v, x, y) => ({ x: ((x - v.cx) / v.zoom + W / 2) / dpr, y: (H / 2 - (y - v.cy) / v.zoom) / dpr });

  // ---------------------------------------------------------------- the lobby
  const L = { reactUntil: 0, taps: [], lastActivity: 0, stayAfter: 70, face: 'idle' };
  function react(anim, voiceGroup) {
    const r = rigs.lobby;
    if (!has(r, anim)) return;
    const e = r.state.setAnimation(1, anim, false);
    e.mixDuration = 0.25;
    r.state.addEmptyAnimation(1, 0.35, 0);
    L.reactUntil = now() + e.animation.duration;
    say(line(voiceGroup));
  }
  function tap(onHer) {
    if (!onHer || stance !== 'lobby') return;
    const t = now();
    L.lastActivity = t;
    L.taps = L.taps.filter((x) => t - x < 2.2);
    L.taps.push(t);
    // poked four times in a row: she is annoyed (her rig's cross, or hurt, face)
    const cross = ['angry', 'rage', 'pain', 'panic', 'surprise'].find((n) => has(rigs.lobby, n));
    if (L.taps.length >= 4 && cross) {
      L.taps = [];
      return react(cross, 'poke');
    }
    if (T.busy()) return;
    react('action', 'touch');
  }
  // Her faces: the rig's other ways of standing (each a loop like her breathing, with its own
  // face), worn in place of it until changed. Her talk, her reaction and its copy are left out.
  const NOT_FACES = /^(idle|action|talk_start|talk_end|expression_0|bg_idle)$/;
  T.faces = () => ['idle', ...(rigs.lobby ? rigs.lobby.data.animations.map((a) => a.name).filter((n) => !NOT_FACES.test(n)) : [])];
  T.expression = (step = 1) => {
    const list = T.faces();
    const i = Math.max(0, list.indexOf(L.face));
    L.face = list[(((i + step) % list.length) + list.length) % list.length];
    if (stance === 'lobby') rigs.lobby.state.setAnimation(0, L.face, true).mixDuration = 0.35;
    return { name: L.face, index: list.indexOf(L.face), count: list.length };
  };
  function lobbyStep(t) {
    if (!L.lastActivity) L.lastActivity = t;
    if (t - L.lastActivity > L.stayAfter && !T.busy()) {
      L.lastActivity = t;
      L.stayAfter = 60 + Math.random() * 45;
      say(line('stay'));
    }
  }

  // ---------------------------------------------------------------- battle
  // Her gun as in the game (TyranWeb gives each character's: magazine and reload), firing at its
  // kind's rate, as players measured it: an assault rifle 10 rounds a second, a shotgun 1.5 shots,
  // a machine gun winding up over 3.75 s to 60 rounds a second (at 60 FPS); a sniper rifle and a
  // rocket launcher charge while held (1 s, 1.5 s) and fire charged, then charge again; let go
  // part way, they fire what they have. (A submachine gun's 20 a second is a guess: nobody gives it.)
  const KINDS = {
    AR: { rate: 10 },
    SMG: { rate: 20 },
    SG: { rate: 1.5 },
    MG: { rate: 60, from: 4, windup: 3.75 },
    SR: { charge: 1 },
    RL: { charge: 1.5 },
  };
  const GUN = { type: 'AR', ammo: 60, reload: 1, ...KINDS.AR }; // (set from her manifest)
  const B = { phase: 'cover', held: false, ammo: GUN.ammo, next: 0, shots: 0, fired: false, burst: 0, spin: 0, charged: 0, ax: 0.5, ay: 0.5, aim: { x: 0, y: 0 }, reloadFrom: 0, reloadFor: 1 };
  // rounds a second now: a machine gun's rate rises while it fires (and falls when it stops)
  const fireRate = () => (GUN.charge ? 1 / GUN.charge : GUN.windup ? GUN.from + (GUN.rate - GUN.from) * B.spin * B.spin : GUN.rate);
  function showOnly(...keys) {
    for (const [k, r] of Object.entries(rigs)) r.want = keys.includes(k) ? 1 : 0;
  }
  function swapNow(from, to) {
    rigs[from].alpha = rigs[from].want = 0;
    rigs[to].alpha = rigs[to].want = 1;
  }
  function rise() {
    const c = rigs.cover;
    B.phase = 'rising';
    if (!has(c, 'to_aim')) return toAim();
    c.state.setAnimation(0, 'to_aim', false).mixDuration = 0.05;
  }
  function toAim() {
    if (B.phase !== 'rising') return;
    const a = rigs.aim;
    swapNow('cover', 'aim');
    const e = a.state.setAnimation(0, has(a, 'to_aim') ? 'to_aim' : 'aim_idle', !has(a, 'to_aim'));
    e.mixDuration = 0;
    if (has(a, 'to_aim')) {
      e.trackTime = 0.1;
      a.state.addAnimation(0, 'aim_idle', true, 0).mixDuration = 0.1;
    }
    for (const [i, n] of [[1, 'aim_x'], [2, 'aim_y']]) {
      if (!has(a, n)) continue;
      const t = a.state.setAnimation(i, n, false);
      t.timeScale = 0;
      t.mixDuration = 0;
    }
    B.phase = 'aim';
    B.next = now() + 0.08;
    aimTracks(true);
  }
  function lower() {
    const a = rigs.aim;
    // (a charged gun let go part way fires what it has)
    const charged = B.charged;
    B.charged = 0;
    if (GUN.charge && B.phase === 'aim' && charged > 0.25 && B.ammo > 0) shoot(now());
    B.phase = 'lowering';
    a.state.clearTrack(3);
    if (!has(a, 'to_cover')) return toCover();
    a.state.setAnimation(0, 'to_cover', false).mixDuration = 0.05;
  }
  function toCover() {
    if (B.phase !== 'lowering') return;
    const c = rigs.cover;
    swapNow('aim', 'cover');
    const e = c.state.setAnimation(0, has(c, 'to_cover') ? 'to_cover' : 'cover_idle', !has(c, 'to_cover'));
    e.mixDuration = 0;
    if (has(c, 'to_cover')) e.trackTime = 0.1;
    if (B.ammo <= 0 && has(c, 'cover_reload')) {
      // her reload takes her gun's time (its animation played to fit)
      B.phase = 'reload';
      B.spin = 0;
      const r = c.state.addAnimation(0, 'cover_reload', false, 0);
      r.mixDuration = 0.1;
      r.timeScale = r.animation.duration / Math.max(0.2, GUN.reload);
      B.reloadFrom = now() + 0.1;
      B.reloadFor = GUN.reload;
      if (Math.random() < 0.5 && !talkingNow) say(line('reload'));
    } else {
      if (B.ammo <= 0) B.ammo = GUN.ammo;
      B.phase = 'cover';
    }
    c.state.addAnimation(0, 'cover_idle', true, 0).mixDuration = 0.15;
  }
  // the gun follows the pointer: aim_x / aim_y are poses from one side (0) to the other (1)
  function aimTracks(jump) {
    const a = rigs.aim;
    const tx = clamp(B.aim.x / innerWidth, 0, 1);
    const ty = clamp(1 - B.aim.y / innerHeight, 0, 1);
    const k = jump ? 1 : 0.35;
    B.ax += (tx - B.ax) * k;
    B.ay += (ty - B.ay) * k;
    for (const [i, v] of [[1, B.ax], [2, B.ay]]) {
      const e = a.state.tracks[i];
      if (e) e.trackTime = clamp(v, 0, 1) * Math.max(0, e.animation.duration - 0.001);
    }
  }
  // the recoil: once per shot, or (faster than the animation lasts) looping at the rate of fire
  function recoil(rate) {
    const a = rigs.aim;
    if (!has(a, 'aim_fire')) return;
    const dur = a.data.findAnimation('aim_fire').duration || 0.1;
    const cur = a.state.tracks[3];
    if (rate * dur > 1) {
      const e = cur?.animation.name === 'aim_fire' && cur.loop ? cur : a.state.setAnimation(3, 'aim_fire', true);
      e.mixDuration = 0;
      e.timeScale = rate * dur;
      return;
    }
    a.state.setAnimation(3, 'aim_fire', false).mixDuration = 0;
    a.state.addEmptyAnimation(3, 0.06, 0);
  }
  function fire(t) {
    const rate = fireRate();
    recoil(rate);
    B.next = Math.max(B.next + 1 / rate, t - 0.05);
    shoot(t);
  }
  function shoot(t) {
    const rate = fireRate();
    if (GUN.charge) recoil(0);
    B.ammo--;
    B.shots++;
    B.burst++;
    B.fired = true;
    flashUntil = t + 0.05;
    if (!talkingNow && B.burst >= GUN.ammo * 3) {
      B.burst = 0;
      say(line('burst'));
    } else if (!talkingNow && Math.random() < 0.12 / Math.max(1, rate)) say(line('kill'));
    if (B.ammo <= 0) lower();
  }
  let lastStep = 0;
  function battleStep(t) {
    const dt = lastStep ? Math.min(0.1, t - lastStep) : 0;
    lastStep = t;
    const firing = B.phase === 'aim' && B.held;
    // (a machine gun winds up while it fires, and down in about a second when it stops)
    if (GUN.windup) B.spin = clamp(B.spin + (firing ? dt / GUN.windup : -dt), 0, 1);
    if (B.phase === 'cover' && B.held) rise();
    else if (B.phase === 'aim') {
      aimTracks(false);
      if (!B.held) lower();
      else if (GUN.charge) {
        B.charged = Math.min(1, B.charged + dt / GUN.charge);
        if (B.charged >= 1) {
          B.charged = 0;
          shoot(t);
        }
      } else for (let n = 0; n < 4 && t >= B.next && B.phase === 'aim'; n++) fire(t);
    } else if (B.phase === 'reload' && t >= B.reloadFrom + B.reloadFor) {
      B.ammo = GUN.ammo;
      B.phase = 'cover';
    }
    if (!firing && rigs.aim?.state.tracks[3]?.loop) rigs.aim.state.setEmptyAnimation(3, 0.05);
  }

  // ---------------------------------------------------------------- stances
  function setStance(s) {
    if (s === stance || !rigs.lobby) return;
    if (T.log.length < 200) T.log.push('stance:' + s + '@' + Math.round(performance.now()));
    if (s === 'battle' && !(rigs.cover && rigs.aim)) return;
    const was = stance;
    stance = s;
    stopVoice();
    L.reactUntil = 0;
    if (s === 'battle') {
      Object.assign(B, { phase: 'cover', held: false, ammo: GUN.ammo, fired: false, burst: 0, spin: 0 });
      for (const i of [1, 2, 3]) rigs.aim.state.clearTrack(i);
      rigs.cover.state.setAnimation(0, 'cover_idle', true);
      showOnly('cover');
      if (was) say(line('enter'));
    } else {
      const won = was === 'battle' && B.fired;
      Object.assign(B, { phase: 'cover', held: false });
      rigs.lobby.state.setAnimation(0, L.face, true);
      rigs.lobby.state.clearTrack(1);
      showOnly('lobby');
      if (won) setTimeout(() => stance === 'lobby' && !talkingNow && say(line('win')), 500);
      L.lastActivity = now();
    }
  }

  T.busy = () => talkingNow || now() < L.reactUntil || Object.values(rigs).some((r) => r.alpha !== r.want);
  T.idle = () => T.ready && !T.busy();
  T.info = () => ({ stance, face: L.face, gun: GUN.type, phase: B.phase, ammo: B.ammo, shots: B.shots, rate: +fireRate().toFixed(1), talking: talkingNow, voice: voice?.name || '', reacting: now() < L.reactUntil, tracks: Object.fromEntries(Object.entries(rigs).map(([k, r]) => [k, r.state.tracks.map((e) => e?.animation.name || '-').join('/') + ' a' + r.alpha.toFixed(2)])) });
  // Her card for Settings (TyranWeb draws it in a hidden window, ?card=1): the whole of her in her
  // first pose, on nothing, filling a w x h picture.
  T.portrait = (w, h) => {
    const r = rigs.lobby;
    if (!r) return '';
    resize();
    const b = measure(r, 'idle');
    const zoom = Math.max(b.w / (W * 0.94), b.h / (H * 0.96));
    const sk = r.skeleton;
    sk.setToSetupPose();
    if (has(r, 'idle')) r.data.findAnimation('idle').apply(sk, 0, 0, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
    sk.updateWorldTransform();
    sk.color.a = 1;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawRig(r, { cx: b.x + b.w / 2, cy: b.y + b.h / 2 - H * zoom * 0.01, zoom });
    const out = document.createElement('canvas');
    [out.width, out.height] = [w, h];
    out.getContext('2d').drawImage(canvas, 0, 0, w, h);
    return out.toDataURL('image/png');
  };
  // where she is on the page (for the browser's tests): her head and the middle of her body
  T.spots = () => {
    const r = rigs.lobby;
    if (!r?.bounds) return null;
    const head = r.skeleton.findBone('head');
    const v = r.view;
    const b = r.bounds;
    // (a rig with no bone called head: the middle of the top of her)
    return { head: head ? toScreen(v, head.worldX, head.worldY) : toScreen(v, b.x + b.w / 2, b.y + b.h * 0.88), body: toScreen(v, b.x + b.w / 2, b.y + b.h * 0.6), top: toScreen(v, 0, b.y + b.h).y };
  };

  // ---------------------------------------------------------------- input
  // presses come from the mouse (Lobby mode) or from the new tab page through TyranWeb
  let down = null;
  const hits = []; // presses waiting for the next frame to tell whether they are on her
  const log = (e) => T.log.length < 200 && T.log.push(e.type + ':' + e.button + ':' + e.buttons + '@' + Math.round(performance.now()));
  for (const n of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'blur']) addEventListener(n, log, true);
  addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !T.ready) return;
    down = { x: e.clientX, y: e.clientY, t: now() };
    B.aim = { x: e.clientX, y: e.clientY };
    if (stance === 'battle') B.held = true;
  });
  addEventListener('pointermove', (e) => {
    if (down || stance === 'battle') B.aim = { x: e.clientX, y: e.clientY };
  });
  const release = (e) => {
    if (!down) return;
    const d = down;
    down = null;
    B.held = false;
    if (stance === 'lobby' && e.type === 'pointerup' && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 14 && now() - d.t < 0.8) hits.push({ x: d.x, y: d.y, then: tap });
  };
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);
  addEventListener('blur', () => (B.held = false));

  // a press is on her when the picture just drawn has her there (any of the pixels around it)
  const px = new Uint8Array(4 * 81);
  function onHer(x, y) {
    const cx = Math.round(x * dpr);
    const cy = Math.round(H - y * dpr);
    const x0 = clamp(cx - 4, 0, W - 9);
    const y0 = clamp(cy - 4, 0, H - 9);
    gl.readPixels(x0, y0, 9, 9, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let i = 3; i < px.length; i += 4) if (px[i] > 60) return true;
    return false;
  }

  // ---------------------------------------------------------------- the touch areas and the sights
  const ZONE = { touch: '255, 105, 160', aim: '90, 190, 255' };
  function drawZones() {
    const g = zonesCanvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!cfg.zones || hideZones || !T.ready) return;
    if (stance === 'lobby') {
      // her own shape, tinted, with an outline, from the picture just drawn: copies of it moved a
      // little each way, in one colour, less the picture itself, give the outline; the picture
      // faintly under it gives the inside; then all of it in the zone's colour
      g.globalAlpha = 1;
      for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-1.5, -1.5], [1.5, 1.5], [-1.5, 1.5], [1.5, -1.5]]) g.drawImage(canvas, dx * dpr, dy * dpr);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = `rgba(${ZONE.touch}, 0.95)`;
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(canvas, 0, 0);
      g.globalCompositeOperation = 'destination-over';
      g.globalAlpha = 0.22;
      g.drawImage(canvas, 0, 0);
      g.globalCompositeOperation = 'source-atop';
      g.globalAlpha = 1;
      g.fillStyle = `rgb(${ZONE.touch})`;
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'source-over';
    } else {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = `rgba(${ZONE.aim}, 0.10)`;
      g.fillRect(0, cfg.top, innerWidth, innerHeight - cfg.top);
    }
  }
  // in battle: her sights where she aims, with the rounds left around them
  let flashUntil = 0;
  function drawHud(t) {
    const g = hud.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (stance !== 'battle' || hideZones) return;
    const aiming = B.phase === 'aim' || B.phase === 'rising';
    const reloading = B.phase === 'reload';
    if (!aiming && !reloading) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { x, y } = B.aim;
    const r = t < flashUntil ? 21 : 19;
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(255,255,255,.9)';
    g.shadowColor = 'rgba(0,0,0,.6)';
    g.shadowBlur = 4;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      g.beginPath();
      g.moveTo(x + dx * (r - 6), y + dy * (r - 6));
      g.lineTo(x + dx * (r + 7), y + dy * (r + 7));
      g.stroke();
    }
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(x, y, 1.8, 0, Math.PI * 2);
    g.fill();
    // rounds left (or the reload filling up)
    const part = reloading ? clamp((t - B.reloadFrom) / B.reloadFor, 0, 1) : B.ammo / GUN.ammo;
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(255,255,255,.18)';
    g.beginPath();
    g.arc(x, y, r + 12, -Math.PI / 2, Math.PI * 1.5);
    g.stroke();
    g.strokeStyle = reloading ? 'rgba(255,200,80,.95)' : B.ammo < GUN.ammo * 0.2 ? 'rgba(255,90,90,.95)' : 'rgba(120,220,255,.95)';
    g.beginPath();
    g.arc(x, y, r + 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * part);
    g.stroke();
    // a charged gun: its charge inside the sights
    if (GUN.charge && aiming && B.charged > 0) {
      g.lineWidth = 3;
      g.strokeStyle = B.charged >= 0.99 ? 'rgba(255,240,120,.95)' : 'rgba(255,255,255,.75)';
      g.beginPath();
      g.arc(x, y, r - 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * B.charged);
      g.stroke();
    }
    g.shadowBlur = 0;
    g.font = '700 12px "Segoe UI", sans-serif';
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.fillText(reloading ? 'RELOAD' : String(B.ammo), x, y + r + 32);
    g.textAlign = 'start';
  }

  // ---------------------------------------------------------------- the loop
  let last = 0;
  function frame(ms) {
    requestAnimationFrame(frame);
    const t = ms / 1000;
    const dt = last ? Math.min(1 / 15, t - last) : 0;
    last = t;
    resize();
    if (reframe) (reframe = false), frameAll();
    if (stance === 'lobby') lobbyStep(t);
    else battleStep(t);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (const r of [rigs.lobby, rigs.cover, rigs.aim]) {
      if (!r) continue;
      r.alpha = r.alpha < r.want ? Math.min(r.want, r.alpha + dt * 4) : Math.max(r.want, r.alpha - dt * 4);
      if (r.alpha <= 0 && r.want <= 0) continue;
      glide(r, dt);
      r.state.update(dt);
      r.state.apply(r.skeleton);
      lipStep(r, dt);
      r.skeleton.updateWorldTransform();
      r.skeleton.color.a = r.alpha;
      drawRig(r, r.view);
    }
    // (read while the picture just drawn is still there)
    for (const h of hits.splice(0)) h.then(onHer(h.x, h.y));
    drawZones();
    drawHud(t);
    if (!canvas.classList.contains('in')) canvas.classList.add('in');
  }

  // ---------------------------------------------------------------- loading
  (async () => {
    try {
      const M = await (await fetch('manifest.json', { cache: 'no-cache' })).json();
      // her outfit (when it is one downloaded beside her), and the runtime its models need; a unit of
      // hers from the game (an outfit here) brings its own gun, and its voice when it has one
      const outfit = M.outfits?.[new URLSearchParams(location.search).get('o') || ''];
      const look = outfit || { rigs: M.rigs, spine: M.spine || '4.0' };
      lines = outfit?.voices || M.voices || [];
      voiceDir = outfit?.voiceDir || 'voice/';
      const gun = outfit?.weapon || M.weapon;
      if (gun) Object.assign(GUN, KINDS[gun.type] || KINDS.AR, gun);
      B.ammo = GUN.ammo;
      T.outfit = outfit ? outfit.name : '';
      await new Promise((ok, fail) => {
        const sc = document.createElement('script');
        sc.src = look.spine === '4.1' ? 'spine-webgl-4.1.min.js' : 'spine-webgl.min.js';
        sc.onload = ok;
        sc.onerror = () => fail(new Error('runtime ' + look.spine));
        document.head.append(sc);
      });
      if (!startGL()) return;
      if (new URLSearchParams(location.search).has('card')) cfg.audio = false;
      const assets = new spine.AssetManager(ctx);
      for (const f of Object.values(look.rigs)) {
        assets.loadBinary(f.skel);
        assets.loadTextureAtlas(f.atlas);
      }
      await assets.loadAll();
      for (const [k, f] of Object.entries(look.rigs)) rigs[k] = makeRig(assets.require(f.atlas), assets.require(f.skel), f.skins);
      // her mouth: the lobby rig's talk animation; behind cover, her grimace when hit
      rigs.lobby.lips = lipsOf(rigs.lobby, 'talk_start', 'idle', false);
      if (rigs.cover) rigs.cover.lips = lipsOf(rigs.cover, 'cover_hit', 'cover_idle', true);
      rigs.lobby.state.setAnimation(0, 'idle', true);
      if (rigs.cover) {
        rigs.cover.state.setAnimation(0, 'cover_idle', true);
        rigs.cover.state.addListener({ event: (e, ev) => ev.data.name === 'SwitchToAimSkin' && toAim(), complete: (e) => e.animation.name === 'to_aim' && toAim() });
      }
      if (rigs.aim) {
        rigs.aim.state.setAnimation(0, 'aim_idle', true);
        rigs.aim.state.addListener({ event: (e, ev) => ev.data.name === 'SwitchToCoverSkin' && toCover(), complete: (e) => e.animation.name === 'to_cover' && toCover() });
      }
      started = true;
      resize();
      setStance(cfg.stance === 'battle' ? 'battle' : 'lobby');
      for (const r of Object.values(rigs)) r.alpha = r.want; // (no fade the first time)
      T.ready = true;
      requestAnimationFrame(frame);
    } catch (err) {
      T.failed = String(err?.message || err);
      console.warn('nikke: ' + T.failed);
    }
  })();
})();
