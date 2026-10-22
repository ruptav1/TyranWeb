// TyranWeb's Azur Lane lobby page (TyranWeb's own, copied next to the ship it downloaded): one of
// her Live2D skins (?s=<skin>), drawn with Live2D's Cubism Core, PixiJS and pixi-live2d-display,
// over the skin's own lobby background.
//
// As in the game's lobby: she breathes (her idle motion, with the skin's "effect" layer looping on
// top) and greets you (login) when she appears; she stands where the game puts her (its own scale,
// 52 px a model unit on a 720 px tall screen, and the skin's live2d_offset). Her motions work like
// the game's Animator: her idle loops underneath, another motion blends in over it and back out
// (whatever no motion moves keeps its last value, as there). A touch on her head, her body or her
// special spot (the rig's own TouchHead / TouchBody / TouchSpecial areas) plays the rig's motion for
// it with her line; a touch elsewhere on her, one of her secretary lines; dragging, she looks after
// it; left alone, she says something now and then only if asked to (as the lobby does, every 30 s).
// While her line plays her mouth follows its loudness alone. The lobby's song plays with her sound.
//
// A skin the game made interactive (its ship_l2d table, in the manifest as game.drags) works as it
// does there: parts of her to tap, drag, turn or hold, each moving one of her parameters and setting
// off her motions, switching her idle pose and which motions may play; what she was left in is kept.
//
// TyranWeb drives it through window.__tyran (sound, volume, touch areas) and hears from it on the
// console when she starts and stops talking (tyran:talk:1 / 0).
(() => {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => performance.now() / 1000;
  const def = (x) => x !== undefined && x !== null && x !== false; // (the game's Lua: only nil and false are "nothing")
  const pick = (x) => (Array.isArray(x) ? x[Math.floor(Math.random() * x.length)] : x);
  const cfg = { audio: false, volume: 0.6, zones: false, top: 0, music: '', musicVolume: 0.6, chatter: false };
  const T = (window.__tyran = { ready: false, failed: '', log: [] });
  const params = new URLSearchParams(location.search);
  const card = params.has('card');
  const skin = params.get('s') || '';
  let hideZones = false;
  let model = null;
  let app = null;
  let look = null;
  let game = {};

  // ---------------------------------------------------------------- what TyranWeb sets
  T.set = (o = {}) => {
    const top = cfg.top;
    Object.assign(cfg, o);
    cfg.volume = clamp(Number(cfg.volume) || 0, 0, 1);
    if (voice) voice.el.volume = cfg.volume;
    if (!cfg.audio) stopVoice();
    if (model && cfg.top !== top) frame(false);
    updateSong();
    return true;
  };
  T.volume = (v) => T.set({ volume: v });
  T.audio = (on) => T.set({ audio: !!on });
  T.zones = (on, top) => T.set(typeof top === 'number' ? { zones: !!on, top } : { zones: !!on });
  T.zonesHide = (h) => ((hideZones = !!h), true);

  // ---------------------------------------------------------------- voices and lip sync
  let voice = null; // { el, line, env }
  let talkingNow = false;
  let mouth = 0;
  const loudness = new Map();
  let decoder = null;
  // a line's loudness, 60 times a second, against its own loud parts (read from the file itself)
  function loudnessOf(url) {
    if (!loudness.has(url)) {
      loudness.set(
        url,
        (async () => {
          const data = await (await fetch(url)).arrayBuffer();
          decoder ||= new OfflineAudioContext(1, 1, 22050);
          const audio = await decoder.decodeAudioData(data);
          const chans = [...Array(audio.numberOfChannels)].map((_, i) => audio.getChannelData(i));
          const hop = audio.sampleRate / 60;
          const n = Math.ceil(audio.length / hop);
          const rms = new Float32Array(n);
          for (let i = 0; i < n; i++) {
            const a = Math.max(0, Math.floor((i - 0.5) * hop));
            const b = Math.min(audio.length, Math.floor((i + 1) * hop));
            let sum = 0;
            for (const c of chans) for (let k = a; k < b; k++) sum += c[k] * c[k];
            rms[i] = Math.sqrt(sum / Math.max(1, (b - a) * chans.length));
          }
          const sorted = [...rms].sort((x, y) => x - y);
          const peak = sorted[Math.floor(sorted.length * 0.95)] || 1e-3;
          const floor = Math.max(peak * 0.12, 0.006);
          return rms.map((x) => clamp((x - floor) / Math.max(1e-4, peak - floor), 0, 1) ** 0.75);
        })()
      );
    }
    return loudness.get(url);
  }
  function say(line) {
    stopVoice();
    const url = look?.voices?.[line];
    if (!cfg.audio || !url) return false;
    const el = new Audio(url);
    el.volume = cfg.volume;
    const v = (voice = { el, line, env: null });
    loudnessOf(url).then((env) => (v.env = env), () => {});
    el.onended = el.onerror = () => voice?.el === el && stopVoice();
    el.play().then(() => voice?.el === el && talking(true), () => voice?.el === el && stopVoice());
    return true;
  }
  function stopVoice() {
    if (voice) voice.el.pause(), (lastActivity = now());
    voice = null;
    talking(false);
  }
  function talking(on) {
    if (on === talkingNow) return;
    talkingNow = on;
    console.debug('tyran:talk:' + (on ? 1 : 0));
  }

  // ---------------------------------------------------------------- the lobby's song
  // The game's lobby song (its "main", or the skin's own, or the one chosen in Settings), looping
  // while her sound is on (TyranWeb downloads it; until it is there, it is tried again now and then).
  // It dips while she talks.
  let song = null; // { el, name, tries }
  const songName = () => (!cfg.audio || card || !cfg.music ? '' : cfg.music === 'game' ? game.bgm || 'main' : cfg.music);
  function updateSong() {
    const want = model ? songName() : '';
    if ((song?.name || '') === want) return;
    if (song) song.el.pause(), clearTimeout(song.retry);
    song = null;
    if (!want) return;
    const s = (song = { name: want, el: new Audio(), tries: 0 });
    s.el.crossOrigin = 'anonymous'; // (so TyranWeb's spectrum bar can measure it: T.spectrum)
    s.el.loop = true;
    s.el.volume = 0;
    const start = () => {
      if (song !== s) return;
      s.el.src = `livewp://azur-music/${encodeURIComponent(want)}.ogg?${s.tries}`;
      s.el.play().catch(() => {});
    };
    s.el.onerror = () => song === s && ++s.tries < 40 && (s.retry = setTimeout(start, 4000));
    start();
  }
  // The song's levels for TyranWeb's spectrum bar (as its src/ui/js/visualizer.js measures music):
  // n bands 0-255, low to high, 45 Hz to 11 kHz, from the song's own captured stream (how it
  // plays is untouched); null while it is not playing.
  let meter = null;
  T.spectrum = (n = 48) => {
    const el = song?.el;
    if (!el || el.paused || el.ended) return null;
    n = clamp(Math.round(n) || 48, 8, 256);
    try {
      el.__tyranStream ||= el.captureStream();
      const track = el.__tyranStream.getAudioTracks()[0];
      if (!track) return null;
      if (!meter) {
        const ctx = new AudioContext();
        const an = ctx.createAnalyser();
        Object.assign(an, { fftSize: 8192, smoothingTimeConstant: 0.45, minDecibels: -88, maxDecibels: -22 });
        meter = { ctx, an, bins: new Uint8Array(an.frequencyBinCount), edges: new Map(), track: null, src: null };
      }
      if (!meter.edges.has(n)) {
        const hz = meter.ctx.sampleRate / meter.an.fftSize;
        meter.edges.set(n, Array.from({ length: n + 1 }, (_, i) => Math.max(1, Math.round((45 * Math.pow(11000 / 45, i / n)) / hz))));
      }
      if (meter.track !== track) {
        meter.src?.disconnect();
        meter.src = meter.ctx.createMediaStreamSource(new MediaStream([track]));
        meter.src.connect(meter.an);
        meter.track = track;
      }
      if (meter.ctx.state === 'suspended') meter.ctx.resume().catch(() => {});
      meter.an.getByteFrequencyData(meter.bins);
      const edges = meter.edges.get(n);
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        let top = 0;
        for (let k = edges[i]; k < Math.max(edges[i] + 1, edges[i + 1]) && k < meter.bins.length; k++) top = Math.max(top, meter.bins[k]);
        out[i] = top;
      }
      return out;
    } catch {
      return null;
    }
  };
  function songLevel(dt) {
    if (!song) return;
    const want = clamp(Number(cfg.musicVolume) || 0, 0, 1) * (talkingNow ? 0.3 : 1);
    song.el.volume = clamp(song.el.volume + (want - song.el.volume) * (1 - Math.exp(-dt * 5)), 0, 1);
  }

  // ---------------------------------------------------------------- her parameters
  let P = null; // the rig's parameters: { ids, values, minimumValues, maximumValues }
  const index = new Map();
  const partIndex = new Map();
  const at = (id) => (index.has(id) ? index.get(id) : -1);
  const get = (id) => (at(id) >= 0 ? P.values[at(id)] : 0);
  const put = (id, v) => {
    const i = at(id);
    if (i >= 0) P.values[i] = clamp(v, P.minimumValues[i], P.maximumValues[i]);
  };
  // Parameters held by the game's interactions (its AddParameterValue: set over, added to or
  // multiplying what her motions give, every frame): id -> { v, mode }
  const held = new Map();
  const MODES = { 1: 'set', 2: 'add', 3: 'mul' };
  const hold = (id, v, mode) => at(id) >= 0 && held.set(id, { v, mode: MODES[mode] || 'set' });
  function applyHeld() {
    for (const [id, h] of held) {
      const cur = get(id);
      put(id, h.mode === 'add' ? cur + h.v : h.mode === 'mul' ? cur * h.v : h.v);
    }
  }

  // ---------------------------------------------------------------- motion files
  // A motion's own file (for its length, its cues and, for the effect layer, its curves).
  const motionFile = (name) => model?.internalModel.settings.motions?.[name]?.[0]?.File;
  const files = new Map();
  function motionJson(name) {
    const f = motionFile(name);
    if (!f) return Promise.resolve(null);
    if (!files.has(f)) files.set(f, fetch(new URL(f, new URL(look.model, location.href)).href).then((r) => r.json(), () => null));
    return files.get(f);
  }
  const lengths = {}; // name -> seconds (once read)
  const cues = {}; // name -> when her line starts in it (a skin that times its lines by its motions)
  async function readMotion(name) {
    const j = await motionJson(name);
    if (!j) return;
    const len = Number(j.Meta?.Duration) || 0;
    lengths[name] = len;
    // (its cues: the first after its start and before its last moment)
    const t = (j.UserData || []).map((u) => Number(u.Time) || 0).find((x) => x > 0.01 && x < len - 0.6);
    cues[name] = t || 0;
  }

  // The "effect" layer: a looping motion the game plays over everything else (glints, sparkles).
  let effect = null; // { curves, len, t0 }
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
      // (bezier: the point on it at this time, found by halving)
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
  function applyEffect() {
    if (!effect) return;
    const t = effect.len > 0 ? (now() - effect.t0) % effect.len : 0;
    const parts = model.internalModel.coreModel._model.parts;
    for (const c of effect.curves) {
      const v = valueAt(c, t);
      if (!c.part) put(c.id, v);
      else if (partIndex.has(c.id)) parts.opacities[partIndex.get(c.id)] = v;
    }
  }

  // Her idle underneath everything, as the base state of the game's Animator (it loops on its own;
  // a switch to another idle pose blends over). What no motion moves keeps the value it was last
  // given, as in the game (a skin's greeting can show her, or open a door, for good).
  const BLEND = 0.3; // seconds a motion takes to come in and go out
  let base = null; // { name, curves, len, t0 }
  let baseOld = null; // the one it took over from, while that fades: { ..., from }
  function setBase(name) {
    if (base?.name === name) return Promise.resolve();
    return motionJson(name).then((j) => {
      if (!j || idleName(L.idle) !== name || base?.name === name) return;
      if (base) baseOld = { ...base, from: now() };
      base = { name, curves: curvesOf(j), len: Number(j.Meta?.Duration) || 0, t0: now() };
      lengths[name] = base.len;
    });
  }
  function applyBase() {
    const parts = model.internalModel.coreModel._model.parts;
    const t = now();
    const layer = (b, w) => {
      const time = b.len > 0 ? (t - b.t0) % b.len : 0;
      for (const c of b.curves) {
        const v = valueAt(c, time);
        const arr = c.part ? parts.opacities : P.values;
        const i = c.part ? (partIndex.has(c.id) ? partIndex.get(c.id) : -1) : at(c.id);
        if (i >= 0) arr[i] = w >= 1 ? v : arr[i] + (v - arr[i]) * w;
      }
    };
    let w = 1;
    if (baseOld) {
      w = clamp((t - baseOld.from) / BLEND, 0, 1);
      if (w >= 1) baseOld = null;
      else layer(baseOld, 1);
    }
    if (base) layer(base, w);
  }

  // ---------------------------------------------------------------- what plays
  // The game's rules for a motion: may it play now (the lists the interactions set), and her idle
  // pose (idle, idle1, idle2... as they switch it).
  const has = (group) => !!model?.internalModel.settings.motions?.[group];
  const L = { drags: [], idle: 0, playing: false, action: '', enable: [], ignore: [], able: false, keep: null, ignoreReact: false, saveId: 0 };
  let current = { name: '', t0: 0 }; // the motion she plays over her idle, and since when
  function allowed(name) {
    if (!name) return false;
    if (name === 'idle') return true;
    for (const d of L.drags) {
      if (!d.extend) continue;
      const [no, yes] = d.extendCheck(name);
      if (no) return false;
      if (yes) return true;
    }
    if (L.enable.length && !L.enable.includes(name)) return false;
    if (L.ignore.length && L.ignore.includes(name)) return false;
    return true;
  }
  const idleName = (n) => (n > 0 && has('idle' + n) ? 'idle' + n : 'idle');
  function toIdle() {
    model.internalModel.motionManager.stopAllMotions();
    return setBase(idleName(L.idle));
  }
  // (the game's SetAction: an action plays once, then her idle again; "idle" goes straight back)
  function play(name, force) {
    if (!allowed(name)) return false;
    if (!has(name) && /^main_/.test(name)) name = 'main_3';
    if (L.playing && !force) return false;
    if (!has(name)) return false;
    L.action = name;
    if (name === 'idle') {
      toIdle();
      L.playing = false;
    } else {
      model.motion(name, 0, 3);
      L.playing = true;
    }
    stateChanged();
    return true;
  }
  function setIdle(n) {
    const changed = n !== L.idle;
    L.idle = n;
    if (changed) setBase(idleName(n));
    notify(EV.IDLE, { idle: n, idle_change: changed });
    stateChanged();
  }
  function stateChanged() {
    for (const d of L.drags) d.stateData({ idle: L.idle, playing: L.playing, ignoreReact: L.ignoreReact, action: L.action });
  }

  // Her motions with her lines, as TyranWeb's touches and buttons ask for them: the line after the
  // game's own delay for it (or the motion's own cue).
  let pending = 0;
  let lastActivity = 0;
  let voiced = false; // (the motion playing has her line with it: her mouth is the line's alone)
  function act(group, force = false) {
    if (!has(group) || !play(group, force)) return false;
    const line = look.lines?.[group];
    voiced = !!(line && cfg.audio && look.voices?.[line]);
    clearTimeout(pending);
    pending = 0;
    stopVoice();
    if (line) {
      const delay = game.cues ? cues[group] : Number(look.calib?.[line] ?? look.calib?.[group] ?? 0) || 0;
      pending = setTimeout(() => ((pending = 0), say(line)), (delay || 0) * 1000);
    }
    lastActivity = now();
    return true;
  }
  const mainMotions = () => ['main_1', 'main_2', 'main_3'].filter((m) => has(m) && allowed(m));
  const pickMain = () => pick(mainMotions());

  T.busy = () => talkingNow || L.playing || !!pending;
  T.idle = () => T.ready && !T.busy();
  // the "faces" button: her secretary lines and her touch reactions in turn, each with its line (not
  // the game's notices, mail, missions, the vow: they only make sense when those happen)
  const POSES = ['main_1', 'main_2', 'main_3', 'touch_head', 'touch_body', 'touch_special'];
  const LABEL = { main_1: 'Thoại 1', main_2: 'Thoại 2', main_3: 'Thoại 3', touch_head: 'Chạm đầu', touch_body: 'Chạm người', touch_special: 'Chạm đặc biệt' };
  let pose = -1;
  T.faces = () => POSES.filter((p) => has(p) && allowed(p));
  T.expression = (step = 1) => {
    const list = T.faces();
    if (!list.length) return null;
    pose = (((pose + step) % list.length) + list.length) % list.length;
    act(list[pose], true);
    return { name: list[pose], label: LABEL[list[pose]] || list[pose], index: pose, count: list.length };
  };
  T.info = () => ({ ready: T.ready, look: look?.name || '', talking: talkingNow, voice: voice?.line || '', busy: T.busy(), motions: Object.keys(model?.internalModel.settings.motions || {}) });
  T.model = () => model;
  T.drags = () => L.drags.map((d) => [d.id, d.part, d.param, +d.value.toFixed(2), +d.target.toFixed(2), d.active]);
  T.state = () => ({ idle: L.idle, playing: L.playing, action: L.action, enable: L.enable.length, ignore: L.ignore.length, drags: L.drags.length, held: held.size, current: L.playing ? current.name : base?.name || '', song: song ? song.name + (song.el.paused ? ' (paused)' : '') : '', scene, bg: !!document.body.style.backgroundImage });

  // ---------------------------------------------------------------- the game's interactions
  // Ported from how the game itself reads each ship_l2d entry (its Live2dDrag): a part of her (a
  // hidden picture of the rig, TouchDrag1, TouchIdle3...) that a press starts; the parameter it
  // moves (dragged along, turned round, held down, or set by a tap) and how smoothly; what it sets
  // off (a motion, a new idle pose, which motions may play next) and when it goes back.
  const EV = { PLAY: 1, CLICK: 2, IDLE: 3, PARAM: 4, DOWN: 5, XY: 6, DRAG: 7 };
  const TR = { TIME: 1, CLICK: 2, DOWN: 3, XY: 4, REL_IDLE: 5, MANY: 6, LISTEN: 7, DOWN_TOUCH: 8, CLICK_PARAM: 9, ANIM: 10, CLICK_RANGE: 11, EXTEND: 12, WITH_PARAM: 13, MOVE_DOWN_UP: 14 };
  const mouse = { x: 0, y: 0, down: false }; // on the page; the game's own screen units are worked out from it
  let gamePx = 1.5; // game screen pixels a page pixel (a 1080 px tall screen, as the game's drag lengths were made for)
  const gx = () => ({ x: mouse.x * gamePx, y: -mouse.y * gamePx });
  function smoothDamp(cur, target, vel, time, dt) {
    time = Math.max(1e-4, time);
    const w = 2 / time;
    const x = w * dt;
    const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = cur - target;
    const temp = (vel + w * change) * dt;
    let v = (vel - w * temp) * e;
    let out = target + (change + temp) * e;
    if (target - cur > 0 === out > target) (out = target), (v = 0);
    return [out, v];
  }
  class Drag {
    constructor(e) {
      const obj = (x) => (x && typeof x === 'object' ? x : {});
      this.id = e.id;
      this.part = e.draw_able_name || '';
      this.param = e.parameter || '';
      this.mode = e.mode || 1;
      this.start = e.start_value || 0;
      this.range = Array.isArray(e.range) && e.range.length >= 2 ? e.range : [0, 0];
      this.offX = e.offset_x || null;
      this.offY = e.offset_y || null;
      this.smooth = (e.smooth || 0) / 1000;
      this.smoothRevert = (e.revert_smooth || 0) / 1000;
      this.revert = e.revert || 0;
      this.ignoreReact = e.ignore_react === 1;
      this.ignoreAction = e.ignore_action === 1;
      this.gyro = e.gyro === 1;
      this.dir = e.drag_direct || 0;
      this.abs = e.range_abs === 1;
      this.parts = Array.isArray(e.parts_data?.parts) ? e.parts_data : null;
      this.trig = obj(e.action_trigger);
      this.activeData = obj(e.action_trigger_active);
      this.reactX = e.react_pos_x || null;
      this.reactY = e.react_pos_y || null;
      this.limit = e.limit_time > 0 ? e.limit_time : 1;
      this.circle = Array.isArray(e.offset_circle?.pos) ? { pos: e.offset_circle.pos, start: e.offset_circle.start || 0 } : null;
      this.listener = obj(e.listener_data);
      const rc = obj(e.react_condition);
      this.idleOn = rc.idle_on || [];
      this.idleOff = rc.idle_off || [];
      const ri = e.revert_idle_index;
      this.revertIdle = Array.isArray(ri) ? ri : Number(ri) === 1;
      this.revertAction = e.revert_action_index === 1;
      this.keep = e.save_parameter !== -1;
      this.value = this.target = this.from = this.start;
      this.t = 0;
      this.smoothTime = this.smooth;
      this.active = false;
      this.next = 0;
      this.triggerTime = 0;
      this.listIndex = 1;
      this.triggered = false;
      this.dragX = this.dragY = this.dragTX = this.dragTY = this.start;
      this.span = this.range[1] - this.range[0];
      this.rel = (obj(e.relation_parameter).list || []).filter((r) => r && at(r.name) >= 0).map((r) => ({ d: r, value: r.start ?? this.start, vel: 0, enable: false }));
      this.state = { idle: 0, playing: false, ignoreReact: false, action: '' };
      this.flag = false;
      this.able = false;
      this.extend = this.trig.type === TR.EXTEND;
      this.reactCond = false;
      this.loadStep = true;
      this.com = true;
    }
    fix(v, range = this.range, abs = this.abs, dir = this.dir) {
      if (v < 0 && dir === 1) v = 0;
      else if (v > 0 && dir === 2) v = 0;
      if (abs) v = Math.abs(v);
      return clamp(v, range[0], range[1]);
    }
    setTarget(v) {
      this.t = 0;
      this.from = this.target;
      this.target = v;
    }
    // ---- a press on her part, and its end
    startDrag() {
      if (this.ignoreAction && this.state.playing) return;
      if (this.active) return;
      this.active = true;
      this.down = gx();
      this.downTime = now();
      this.triggerTime = 0;
      if (this.trig.type === TR.DOWN) this.listIndex = 1;
      this.smoothTime = this.smooth;
    }
    stopDrag() {
      if (!this.active) return;
      this.active = false;
      if (this.revert > 0) (this.toStart = this.revert / 1000), (this.smoothTime = this.smoothRevert);
      this.dragTX = this.fix(this.dragX);
      this.dragTY = this.fix(this.dragY);
      if (this.trig.type === TR.DOWN && this.trig.last) this.next = 0;
      this.up = gx();
      this.upTime = now();
      this.center = null;
      this.snap();
      save();
    }
    // (a dragged one settles on the nearest of its steps)
    snap() {
      if (!this.parts || !(this.offX || this.offY || this.trig.type === TR.DOWN_TOUCH || this.circle)) return;
      const v = this.target;
      const type = this.parts.type;
      let best = null;
      for (const p of this.parts.parts) {
        if (type === 2 && !(p <= v)) continue;
        if (type === 3 && !(v <= p)) continue;
        if (best === null || Math.abs(v - p) < Math.abs(v - best)) best = p;
      }
      if (best === null) return;
      this.dragTX = this.dragTY = best;
      this.setTarget(best);
    }
    // ---- what goes on around it
    stateData(s) {
      if (this.state.idle !== s.idle && (this.revertIdle === true || (Array.isArray(this.revertIdle) && this.revertIdle.includes(s.idle)))) {
        this.setTarget(this.start);
        this.dragX = this.dragY = this.dragTX = this.dragTY = this.start;
      }
      const lastIndex = this.listIndex;
      if (s.playing && this.trig.reset_index_action?.includes(s.action)) this.listIndex = 1;
      if (this.revertAction && lastIndex !== this.listIndex) this.setTarget(this.start);
      this.state = { ...s };
      if (!s.playing && this.triggered) this.triggered = false;
      if (this.idleOn.length) this.reactCond = !this.idleOn.includes(s.idle);
      if (this.idleOff.length) this.reactCond = this.idleOff.includes(s.idle);
    }
    listen(type, data) {
      if (type === EV.CLICK && this.trig.click_cd?.includes(data.draw_able_name)) this.next = this.limit;
      else if (type === EV.PLAY) this.next = Math.min(this.limit, 0.2);
      const l = this.listener;
      if (!l.type || l.type !== type) return;
      const key = type === EV.PLAY ? data.action : type === EV.CLICK ? data.draw_able_name : type === EV.IDLE ? data.idle : undefined;
      let changed = false;
      if (Array.isArray(l.change) && key !== undefined) {
        for (const [kind, names, val, idx = 1] of l.change) {
          if (!names?.includes(key)) continue;
          let v = kind === 1 ? this.target + val : kind === 2 ? val : null;
          if (v !== null) {
            changed = true;
            v = this.fix(v);
            if (this.trig.change_focus === false) this.prepare = v;
            else this.setTarget(v);
          }
          if (idx > 0) (changed = true), (this.listIndex = idx);
        }
      }
      if (Array.isArray(l.apply) && l.apply[0] === 1 && changed) {
        const v = this.prepare ?? this.target;
        let idle = null;
        for (const [a, b, i] of l.apply[1] || []) if (a <= v && v < b) idle = i;
        if (idle !== null && this.state.idle !== idle) applyActive({ id: this.id, idle, activeData: this.activeData });
      }
    }
    notice(type) {
      notify(type, { draw_able_name: this.part, parameter_name: this.param, parameter_target: this.target });
    }
    setAble(on) {
      if (this.able === on) return;
      this.able = on;
      if (L.able !== on) {
        L.able = on;
        // (while a part is held down, nothing else may start)
        if (on) (L.keep = L.enable), (L.enable = ['none action apply']);
        else L.enable = L.keep || [];
      }
    }
    // ---- its trigger going off: the motion, the value it sets, what may play after
    fire(onDone) {
      const t = this.trig;
      let action;
      let active = this.activeData;
      let focus = t.focus === 1;
      let target = t.target ?? null;
      let targetFocus = t.target_focus === 1;
      let react = t.react ?? null;
      const stop = () => t.type !== TR.MOVE_DOWN_UP && this.stopDrag();
      if (def(t.action)) {
        action = pick(t.action);
        if (def(t.circle) && target !== null && target === this.target) target = this.start;
        this.triggerAction();
        stop();
      } else if (Array.isArray(t.action_list)) {
        const item = t.action_list[this.listIndex - 1] || {};
        action = pick(item.action);
        active = this.activeData.active_list?.[this.listIndex - 1] || this.activeData;
        focus = item.focus === 1 || t.focus === 1;
        target = item.target ?? null;
        targetFocus = item.target_focus === 1;
        react = item.react ?? null;
        if (action) this.triggerAction();
        if (this.listIndex >= t.action_list.length) (this.listIndex = 1), stop();
        else this.listIndex++;
      } else {
        if (def(t.circle) && target !== null && target === this.target) target = this.start;
        this.triggerAction();
        this.triggered = false;
        stop();
      }
      if (def(active.idle) && !active.repeat_flag) {
        const one = Array.isArray(active.idle) ? (active.idle.length === 1 ? active.idle[0] : null) : active.idle;
        if (one === this.state.idle) return;
      }
      if (target !== null) {
        this.setTarget(target);
        if (targetFocus) this.value = target;
        if (!action) this.revertReset = true;
      }
      if (focus) this.triggered = false;
      onApply({ id: this.id, action, activeData: active, focus, react, done: onDone });
    }
    triggerAction() {
      this.next = this.limit;
      this.triggered = true;
    }
    // (a tap on it: pressed and let go quickly, close to where it began)
    clicked() {
      const t = this.trig;
      if (this.firstActive) {
        if (t.down) return (t.focus === 1 && this.state.playing) || !this.state.playing;
        this.setAble(true);
      } else if (this.firstStop) {
        const near = Math.abs(this.up.x - this.down.x) < 30 && Math.abs(this.up.y - this.down.y) < 30;
        if (!t.down && near && this.upTime - this.downTime < 0.5) {
          if (t.focus === 1 && this.state.playing) {
            if (this.state.action === t.action) this.clickAt = now() + 0.1;
          } else if (!this.state.playing) this.clickAt = now() + 0.1;
        } else this.setAble(false);
      } else if (this.clickAt && this.clickAt <= now()) {
        this.setAble(false);
        const ok = now() - this.clickAt <= 0.1;
        this.clickAt = null;
        return ok;
      }
      return false;
    }
    extendCheck(name) {
      const [a, b] = this.trig.num || [0, 0];
      const v = dragValue(this.trig.parameter);
      if (!(a < v && v <= b)) return [false, false];
      return [!!this.activeData.ignore?.includes(name), !!this.activeData.enable?.includes(name)];
    }
    // ---- one step (the game's own, 30 times a second; here every frame)
    step(dt, ctx) {
      this.firstActive = !this.wasActive && this.active;
      this.firstStop = this.wasActive && !this.active;
      this.wasActive = this.active;
      this.trigger(dt, ctx);
      this.updateFlag();
      this.followDrag();
      this.followCircle();
      if (this.gyro) this.setTarget(0), (this.flag = true); // (no tilting a computer)
      this.followReact();
      this.move(dt);
      this.relations(dt);
      if (!this.active && this.toStart !== undefined && this.toStart !== null) {
        if (this.toStart > 0) this.toStart -= dt;
        if (this.toStart <= 0) {
          this.setTarget(this.start);
          this.toStart = null;
          if (this.revertReset) (this.triggered = false), (this.revertReset = false);
          this.dragX = this.dragTX = this.dragY = this.dragTY = this.start;
        }
      }
      this.loadStep = false;
    }
    triggerable(dt) {
      if (!def(this.trig.type)) return false;
      if (this.next - dt >= 0) {
        this.next -= dt;
        return false;
      }
      return !this.triggered;
    }
    trigger(dt, ctx) {
      if (!this.triggerable(dt)) return;
      const t = this.trig;
      const item = Array.isArray(t.action_list) ? t.action_list[this.listIndex - 1] || {} : {};
      const time = t.time ?? item.time ?? 0;
      const num = t.num ?? item.num;
      const playing = this.state.playing;
      switch (t.type) {
        case TR.TIME:
          if (this.active && typeof num === 'number' && Math.abs(this.value - num) < Math.abs(num) * 0.25) {
            this.triggerTime += dt;
            if (time < this.triggerTime && !playing) this.fire((ok) => ok && this.notice(EV.DRAG));
          }
          break;
        case TR.CLICK:
          if (this.clicked()) this.fire(() => this.notice(EV.CLICK));
          break;
        case TR.CLICK_RANGE:
          if (this.clicked()) {
            const v = get(t.parameter || this.param);
            if (Array.isArray(num) && num[0] <= v && v < num[1]) this.fire(() => this.notice(EV.CLICK));
          }
          break;
        case TR.DOWN:
          if (this.active) {
            this.setAble(true);
            if (time <= now() - this.downTime && !playing) {
              this.setAble(false);
              this.fire((ok) => ok && this.notice(EV.DOWN));
              if (this.listIndex !== 1) this.triggered = false;
              this.setAble(true);
              this.downTime = now();
            }
          } else if (t.last && this.listIndex !== 1 && Array.isArray(t.action_list)) {
            this.listIndex = t.action_list.length;
            this.setAble(false);
            this.fire(() => {});
            this.next = 0;
            this.triggered = false;
          } else this.setAble(false);
          break;
        case TR.XY:
          if (this.active && Array.isArray(num)) {
            const [fx, fy] = [this.fix(this.dragX), this.fix(this.dragY)];
            if (Math.abs(fx - num[0]) <= Math.abs(num[0]) * 0.25 && Math.abs(fy - num[1]) <= Math.abs(num[1]) * 0.25) {
              this.triggerTime += dt;
              if (time < this.triggerTime && !playing) this.fire((ok) => ok && this.notice(EV.XY));
            }
          }
          break;
        case TR.REL_IDLE:
          for (const c of t.const_fit || []) if (this.state.idle === c.idle && !playing) this.setTarget(c.target);
          break;
        case TR.MANY:
          if (this.clicked()) this.fire(() => {});
          break;
        case TR.DOWN_TOUCH:
          this.setAble(this.active);
          if (this.active) this.setTarget(this.fix(this.target + dt / (t.delta || 1)));
          break;
        case TR.CLICK_PARAM:
          if (this.clicked() && Math.abs(num - get(t.parameter)) <= 0.05) this.fire(() => this.notice(EV.CLICK));
          break;
        case TR.ANIM: {
          let name = t.trigger_name;
          if (name === 'idle' && t.trigger_index > 0) name += t.trigger_index;
          if (ctx.name === name && this.state.idle === t.trigger_index) {
            let ok = true;
            if (Array.isArray(t.parameter_range)) {
              const [p, r] = t.parameter_range;
              const v = get(p);
              ok = Array.isArray(r) && r[0] <= v && v < r[1];
            }
            if (ok && t.trigger_rate <= ctx.normal && !this.animApplied) {
              this.fire(() => {});
              this.triggered = false;
              this.animApplied = true;
            }
            return;
          }
          this.animApplied = false;
          break;
        }
        case TR.WITH_PARAM:
          if (!playing) {
            const near = typeof num === 'number' && Math.abs(this.value - num) <= Math.abs(num) * 0.1;
            if (near && !this.moveTrigger) {
              this.moveTrigger = true;
              this.fire(() => {});
            } else {
              this.moveStep ??= 10;
              if (this.moveTrigger) {
                this.moveTrigger = false;
                this.value = this.start;
                this.setTarget(this.start);
              }
              if (--this.moveStep <= 0) {
                this.moveStep = 10;
                const last = this.paramMove;
                this.paramMove = get(t.parameter);
                if (last !== undefined && this.paramMove - last !== 0) this.setTarget(this.fix(this.target + (this.paramMove - last) * (t.rate || 0)));
              }
            }
          }
          break;
        case TR.MOVE_DOWN_UP: {
          const r = t.range || [0, 0];
          if (this.active && t.active === 1) {
            if (!this.moveUp && r[0] < this.value && this.value <= r[1]) (this.moveUp = true), this.fire(() => {});
          } else if (this.firstStop && t.active === 0) {
            const v = get(t.parameter);
            if (r[0] < v && v <= r[1]) this.fire(() => {});
          } else if (!this.active && this.moveUp) this.moveUp = false;
          break;
        }
        default:
        // (the board game one skin has, and the listening kind the game itself never sets off)
      }
    }
    updateFlag() {
      const type = this.trig.type;
      if (type === TR.REL_IDLE) {
        const remove = !!(this.state.playing && this.trig.remove_com_list?.includes(this.state.action));
        this.flag = !remove;
        if (this.com === remove) {
          this.com = !remove;
          if (this.com) hold(this.param, this.start, this.mode);
          else held.delete(this.param);
        }
      } else this.flag = [TR.CLICK, TR.DOWN_TOUCH, TR.LISTEN, TR.ANIM, TR.WITH_PARAM, TR.MOVE_DOWN_UP, 15].includes(type);
    }
    followDrag() {
      if (!this.offX && !this.offY) return;
      if (this.active) {
        const m = gx();
        let v = null;
        if (this.offX) v = this.dragX = this.dragTX + (m.x - this.down.x) / this.offX;
        if (this.offY) v = this.dragY = this.dragTY + (m.y - this.down.y) / this.offY;
        if (v !== null) this.setTarget(this.fix(v));
      }
      this.flag = true;
    }
    followCircle() {
      if (!this.circle) return;
      if (this.active && mouse.down) {
        this.center ||= modelPointOnPage(this.circle.pos[0], this.circle.pos[1]);
        const deg = (Math.atan2(mouse.x - this.center.x, -(mouse.y - this.center.y)) * 180) / Math.PI;
        this.setTarget((this.range[1] * ((((deg + 360 - this.circle.start) % 360) + 360) % 360)) / 360);
        this.flag = true;
      } else if (this.target !== this.value) this.flag = true;
    }
    followReact() {
      if (!this.reactX && !this.reactY) return;
      if (!this.state.ignoreReact) {
        const f = model.internalModel.focusController;
        this.setTarget(this.fix(this.reactX ? f.x * this.reactX : f.y * this.reactY));
      }
      this.flag = true;
    }
    move(dt) {
      if (this.prepare !== undefined && this.prepare !== null && !this.state.playing) {
        this.setTarget(this.prepare);
        this.prepare = null;
      }
      if (!this.flag || this.value === this.target) return;
      let target = this.target;
      if (this.circle && Math.abs(target - this.value) >= this.span / 2) target += this.value < target ? -this.span : this.span;
      if (Math.abs(this.value - this.target) < 0.05) this.value = this.target;
      else if (this.smoothTime > 0) {
        this.t = clamp(this.t + dt, 0, this.smoothTime);
        this.value = this.from + ((target - this.from) * this.t) / this.smoothTime;
        if (this.circle && this.span > 0) this.value = ((((this.value - this.range[0]) % this.span) + this.span) % this.span) + this.range[0];
      } else (this.value = this.target), (this.t = 0);
    }
    relations(dt) {
      for (const r of this.rel) {
        const d = r.d;
        let v;
        let on = false;
        if (d.type === 101) (v = this.dragX), (on = true);
        else if (d.type === 102) (v = this.dragY), (on = true);
        else if (d.type === 103) (v = d.relation_value?.[this.listIndex - 1] ?? 0), (on = true);
        else if (d.type === 104) {
          if (this.loadStep && this.state.idle === d.idle) on = true;
          if (this.state.playing) {
            if (this.state.action === this.trig.action) this.relActive = true;
          } else (this.relActive = false), (this.relAt = null);
          if (!on && this.relActive && this.state.idle === d.idle) {
            this.relAt ??= now() + (d.time || 0);
            if (this.relAt <= now()) on = true;
          }
        } else v = this.target;
        let val;
        if (def(d.target)) val = d.target;
        else if (v === undefined) continue;
        else {
          const want = this.fix(v, d.range || this.range, d.range_abs !== undefined ? d.range_abs === 1 : this.abs, d.drag_direct ?? this.dir);
          if (Math.abs(want - r.value) <= 0.01) val = want;
          else [val, r.vel] = smoothDamp(r.value, want, r.vel, d.smooth ? d.smooth / 1000 : this.smooth, dt);
        }
        r.value = val;
        r.enable = on;
      }
    }
  }
  const dragValue = (param) => L.drags.reduce((v, d) => (d.param === param ? d.value : v), 0);
  function notify(type, data) {
    for (const d of L.drags) d.listen(type, data);
  }
  // (a drag's trigger went off: the motion if it may play, then what it changes)
  function onApply(p) {
    const empty = !p.action;
    let ok = false;
    if (p.react !== null && p.react !== undefined) setReact(!!p.react);
    let action = p.action;
    if (p.activeData?.idle_focus === 1 && !action) {
      action = 'idle';
      setIdle(p.activeData.idle ?? 0);
    }
    if (play(action, p.focus || false)) {
      notify(EV.PLAY, { action });
      applyActive(p);
      ok = true;
    } else if (empty) {
      applyActive(p);
      ok = true;
    }
    if (p.activeData?.idle_focus === 1 || action === 'idle') {
      L.playing = false;
      stateChanged();
    }
    lastActivity = now();
    save();
    p.done?.(ok);
  }
  // which motions may play next, and her new idle pose
  function applyActive(p) {
    const a = p.activeData || {};
    const idle = a.idle ?? p.idle;
    let enable = null;
    let ignore = null;
    if (Array.isArray(a.enable)) enable = a.enable;
    else if (Array.isArray(a.idle_enable)) for (const [i, list] of a.idle_enable) if (i === idle) enable = list;
    if (Array.isArray(a.ignore)) ignore = a.ignore;
    else if (Array.isArray(a.idle_ignore)) for (const [i, list] of a.idle_ignore) if (i === idle) ignore = list;
    // (while a part is held down its block stays, and these come after it)
    if (enable) L.able ? (L.keep = enable) : (L.enable = enable);
    if (ignore) L.ignore = ignore;
    if (def(idle) && idle !== L.idle) L.saveId = p.id;
    if (def(idle)) {
      let n = null;
      if (typeof idle === 'number' && idle >= 0) n = idle;
      else if (Array.isArray(idle)) n = pick(idle.filter((i) => i !== L.idle || a.repeatFlag)) ?? null;
      if (n !== null) setIdle(n);
      save();
    }
  }
  function setReact(off) {
    L.ignoreReact = off;
    if (off) model.internalModel.focusController.focus(0, 0);
    stateChanged();
  }
  // every frame, after her motions: the drags move, and what they hold is set on her
  let lastStep = 0;
  function stepDrags() {
    const t = now();
    const dt = clamp(t - (lastStep || t), 0, 0.1);
    lastStep = t;
    if (!L.drags.length) return;
    const on = L.playing ? current : base ? { name: base.name, t0: base.t0 } : { name: '', t0: t };
    const len = lengths[on.name];
    const ctx = { name: on.name, normal: len > 0 ? (t - on.t0) / len : 0 };
    let ignore = false;
    for (const d of L.drags) {
      d.step(dt, ctx);
      if (((d.value !== d.target || (d.toStart ?? 0) > 0 || d.active) && d.ignoreReact) || d.reactCond) ignore = true;
      if (d.param && d.flag && held.has(d.param)) held.get(d.param).v = d.value;
      for (const r of d.rel) if (r.enable && held.has(r.d.name)) held.get(r.d.name).v = r.value;
    }
    if (ignore !== L.ignoreReact && (ignore || (!mouse.down && !L.playing))) setReact(ignore);
  }
  // what she was left in (the game keeps it too): her idle pose, the parts set to stay
  const saveKey = 'tyran-azur-l2d:' + skin;
  function save() {
    if (!L.drags.length || card) return;
    try {
      const drags = {};
      for (const d of L.drags) if ((d.revert === -1 && d.keep) || d.trig.type === TR.MANY || d.rel.length) drags[d.id] = [d.target, d.listIndex, d.dragX, d.dragY];
      localStorage.setItem(saveKey, JSON.stringify({ idle: L.idle, saveId: L.idle ? L.saveId : 0, drags }));
    } catch {
      /* not kept then */
    }
  }
  function load() {
    let s = null;
    try {
      s = JSON.parse(localStorage.getItem(saveKey) || 'null');
    } catch {
      s = null;
    }
    if (!s || card) return;
    if (s.idle) setIdle(s.idle);
    const entry = L.drags.find((d) => d.id === s.saveId);
    if (entry) {
      const a = entry.activeData;
      const listOf = (key) => {
        const byIdle = a['idle_' + key];
        if (s.idle && Array.isArray(byIdle) && byIdle.length) return byIdle.find(([i]) => i === s.idle)?.[1];
        if (Array.isArray(a.active_list)) return a.active_list[(entry.listIndex || 1) - 1]?.[key];
        return a[key];
      };
      L.enable = listOf('enable') || [];
      L.ignore = listOf('ignore') || [];
      L.saveId = s.saveId;
    }
    for (const d of L.drags) {
      const v = s.drags?.[d.id];
      if (!v) continue;
      if (d.revert === -1 && d.keep) d.value = d.target = d.from = v[0];
      if (d.trig.type === TR.MANY) d.listIndex = v[1] || 1;
      if (d.rel.length) (d.dragX = d.dragTX = v[2] ?? d.start), (d.dragY = d.dragTY = v[3] ?? d.start);
    }
  }
  function setUpDrags() {
    for (const e of game.drags || []) {
      const d = new Drag(e);
      L.drags.push(d);
      if (d.param) hold(d.param, d.start, d.mode);
      for (const r of d.rel) hold(r.d.name, r.d.start ?? d.start ?? 0, r.d.mode || d.mode);
    }
    // (as the game sets them: not her wedding ring, not the censored version)
    hold('Paramring', 0, 1);
    hold('l2d_hx', 0, 1);
    load();
    for (const d of L.drags) d.loadStep = true;
    stateChanged();
  }

  // ---------------------------------------------------------------- where she stands
  // a rect of the model's own space (a drawable's bounds) on the page, as the model is placed now
  function onPage(r) {
    const lt = model.internalModel.localTransform;
    const a = model.toGlobal(lt.apply({ x: r.x, y: r.y }));
    const b = model.toGlobal(lt.apply({ x: r.x + r.width, y: r.y + r.height }));
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }
  function modelPointOnPage(x, y) {
    const p = model.toGlobal(model.internalModel.localTransform.apply({ x, y }));
    return { x: p.x, y: p.y };
  }
  // As the game's lobby has her: her model's origin at the middle of the screen moved by the skin's
  // live2d_offset, 52 px a model unit, on a screen 720 px tall (here: the part of the window the
  // browser's bars leave, all of it in Lobby mode); a new place is reached smoothly.
  let goal = null;
  function placeFor(w, h, top = 0, k = Math.min(h / 720, w / 960)) {
    const ci = model.internalModel.coreModel._model.canvasinfo;
    const [ox, oy, scale] = game.offset || [0, 0];
    const s = (k * (scale || 52)) / ci.PixelsPerUnit;
    return { s, k, x: w / 2 + ox * k - ci.CanvasOriginX * s, y: top + h / 2 - oy * k - ci.CanvasOriginY * s };
  }
  function frame(jump) {
    if (!model) return;
    const top = scene ? 0 : clamp(cfg.top, 0, innerHeight * 0.4);
    goal = placeFor(innerWidth, innerHeight - top, top);
    // (a scene a little short of the window, a wider one, say, is drawn just big enough to fill it)
    if (scene) {
      const ci = model.internalModel.coreModel._model.canvasinfo;
      const [cw, ch] = [ci.CanvasWidth * goal.s, ci.CanvasHeight * goal.s];
      const z = Math.max(1, innerWidth / cw, innerHeight / ch);
      if (z <= 1.25) {
        const x = clamp(innerWidth / 2 - (innerWidth / 2 - goal.x) * z, innerWidth - cw * z, 0);
        const y = clamp(innerHeight / 2 - (innerHeight / 2 - goal.y) * z, innerHeight - ch * z, 0);
        goal = { ...goal, s: goal.s * z, x, y };
      }
    }
    gamePx = 1080 / (720 * goal.k);
    if (jump) place(goal);
    updateBg();
  }
  // Whether her skin draws its own scene over the whole window (most of the newer skins do): then it
  // is framed in the whole window (the browser's bars over it), and no other picture shows behind
  // it, not even while her greeting opens on darkness; a skin of her alone stands on its lobby
  // background. Found from her first idle picture, drawn as it would be in the whole window.
  let scene = null;
  const covers = (g) => {
    const ci = model.internalModel.coreModel._model.canvasinfo;
    return g.x <= 1 && g.y <= 1 && g.x + ci.CanvasWidth * g.s >= innerWidth - 1 && g.y + ci.CanvasHeight * g.s >= innerHeight - 1;
  };
  function updateBg() {
    const show = !!look?.bg && scene !== null && !(scene && goal && covers(goal));
    document.body.style.backgroundImage = show ? `url("${look.bg}")` : '';
  }
  const sample = new Uint8Array(4);
  function findScene() {
    place(placeFor(innerWidth, innerHeight));
    app.renderer.render(app.stage);
    const gl = app.renderer.gl;
    const r = app.renderer.resolution;
    const H = gl.drawingBufferHeight;
    let opaque = 0;
    for (let i = 1; i <= 7; i++) {
      for (let j = 1; j <= 5; j++) {
        gl.readPixels(Math.round(((innerWidth * i) / 8) * r), Math.round(H - ((innerHeight * j) / 6) * r), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, sample);
        if (sample[3] > 200) opaque++;
      }
    }
    scene = opaque >= 0.9 * 35;
    frame(true);
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
  // the interaction part under a point: the front-most of the parts the drags use, by their
  // triangles (they are hidden pictures, so their shape, not what is drawn)
  let dragParts = null; // name -> drawable index
  function partAt(x, y) {
    if (!L.drags.length) return '';
    const im = model.internalModel;
    const D = im.coreModel._model.drawables;
    if (!dragParts) {
      dragParts = new Map();
      for (const d of L.drags) if (d.part && !dragParts.has(d.part)) dragParts.set(d.part, D.ids.indexOf(d.part));
    }
    const p = model.toModelPosition(new PIXI.Point(x, y));
    let best = '';
    let order = -Infinity;
    for (const [name, i] of dragParts) {
      if (i < 0 || D.renderOrders[i] <= order) continue;
      const v = im.getDrawableVertices(i); // (in the model's own pixels, as toModelPosition gives)
      const tri = D.indices[i];
      for (let k = 0; k + 2 < tri.length; k += 3) {
        const [a, b, c] = [tri[k] * 2, tri[k + 1] * 2, tri[k + 2] * 2];
        const d1 = (p.x - v[b]) * (v[a + 1] - v[b + 1]) - (v[a] - v[b]) * (p.y - v[b + 1]);
        const d2 = (p.x - v[c]) * (v[b + 1] - v[c + 1]) - (v[b] - v[c]) * (p.y - v[c + 1]);
        const d3 = (p.x - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (p.y - v[a + 1]);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) {
          best = name;
          order = D.renderOrders[i];
          break;
        }
      }
    }
    return best;
  }
  let down = null;
  addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !T.ready) return;
    Object.assign(mouse, { x: e.clientX, y: e.clientY, down: true });
    down = { x: e.clientX, y: e.clientY, t: now(), moved: false, part: partAt(e.clientX, e.clientY) };
    if (down.part) for (const d of L.drags) if (d.part === down.part) d.startDrag();
    if (down.part && !L.drags.some((d) => d.part === down.part && d.active)) down.part = '';
  });
  addEventListener('pointermove', (e) => {
    Object.assign(mouse, { x: e.clientX, y: e.clientY });
    if (!model || !down) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) down.moved = true;
    if (down.moved && !down.part && !L.ignoreReact) model.focus(e.clientX, e.clientY); // (she looks after the drag)
  });
  const release = (e) => {
    if (!down) return;
    const d = down;
    down = null;
    Object.assign(mouse, { x: e.clientX, y: e.clientY, down: false });
    for (const g of L.drags) g.stopDrag();
    model?.internalModel.focusController.focus(0, 0);
    if (e.type !== 'pointerup' || d.part || d.moved || now() - d.t > 0.8 || L.ignoreReact) return;
    lastActivity = now();
    const hit = model.hitTest(d.x, d.y);
    const area = ['special', 'head', 'body'].find((a) => hit.includes(a));
    if (area) return void act({ special: 'touch_special', head: 'touch_head', body: 'touch_body' }[area]);
    const m = pickMain();
    if (m && onHer(d.x, d.y)) act(m);
  };
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);

  // ---------------------------------------------------------------- the touch areas
  const zonesCanvas = document.getElementById('zones');
  const ZONE = { head: '255, 105, 160', body: '90, 190, 255', special: '255, 170, 60', drag: '170, 120, 255', tap: '120, 220, 150' };
  const rect = { x: 0, y: 0, width: 0, height: 0 };
  function areaRects() {
    const im = model.internalModel;
    const out = [];
    for (const [name, area] of Object.entries(im.hitAreas || {})) {
      if (!(area?.index >= 0)) continue;
      im.getDrawableBounds(area.index, rect);
      out.push({ name, ...onPage(rect) });
    }
    return out;
  }
  // the interaction parts she has now (those whose motion may play, or that drag)
  function partRects() {
    if (!L.drags.length) return [];
    const im = model.internalModel;
    const D = im.coreModel._model.drawables;
    const seen = new Map();
    for (const d of L.drags) {
      if (!d.part || seen.has(d.part) || (d.ignoreAction && L.playing)) continue;
      const kind = d.offX || d.offY || d.circle || d.trig.type === TR.DOWN_TOUCH ? 'drag' : [TR.CLICK, TR.MANY, TR.CLICK_PARAM, TR.CLICK_RANGE, TR.DOWN, TR.TIME].includes(d.trig.type) ? 'tap' : '';
      if (!kind) continue;
      const action = def(d.trig.action) ? d.trig.action : d.trig.action_list?.[d.listIndex - 1]?.action;
      if (kind === 'tap' && action && !(Array.isArray(action) ? action : [action]).some((a) => allowed(a) && has(a))) continue;
      if (kind === 'tap' && def(d.activeData.idle) && d.activeData.idle === L.idle && !d.activeData.repeat_flag) continue;
      const i = D.ids.indexOf(d.part);
      if (i < 0) continue;
      im.getDrawableBounds(i, rect);
      seen.set(d.part, { name: kind, part: d.part, ...onPage(rect) });
    }
    return [...seen.values()];
  }
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
    // (the special spot over the body, the head over both, as the touches pick them; her parts on top)
    const order = ['body', 'head', 'special', 'tap', 'drag'];
    for (const z of [...areaRects(), ...partRects()].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))) {
      const rgb = ZONE[z.name] || '200, 200, 200';
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
  // what a press at a point would touch, and where her areas and parts are (for the browser's tests)
  T.hit = (x, y) => (model ? model.hitTest(x, y) : []);
  T.partAt = (x, y) => (model ? partAt(x, y) : '');
  T.frameInfo = () => ({ goal, canvas: model && model.internalModel.coreModel._model.canvasinfo, areas: model && areaRects(), parts: model && partRects() });
  T.spots = () => (model ? Object.fromEntries(areaRects().map((z) => [z.name, { x: z.x + z.w / 2, y: z.y + z.h / 2 }])) : null);
  T.partSpots = () => (model ? partRects().map((z) => ({ part: z.part, kind: z.name, x: z.x + z.w / 2, y: z.y + z.h / 2 })) : []);

  // Her card for Settings (drawn in a hidden window, ?card=1): the middle of what the game shows, as
  // she is once her greeting is over (it is run through at once: some skins only open in it).
  T.portrait = (w, h) => {
    if (!model) return '';
    if (act('login', true)) {
      let t = model.elapsedTime;
      for (let i = 0; i < 400 && L.playing; i++) model.internalModel.update(100, (t += 100));
      model.elapsedTime = t;
    }
    place(placeFor(innerWidth, innerHeight, 0, innerHeight / 720));
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
      look = M.looks?.[skin] || Object.values(M.looks || {})[0];
      if (!look) throw new Error('no skin');
      game = look.game || {};
      for (const s of ['live2dcubismcore.min.js', 'pixi.min.js', 'cubism4.min.js']) await script(s);
      const canvas = document.getElementById('c');
      app = new PIXI.Application({ view: canvas, resizeTo: window, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: devicePixelRatio || 1, preserveDrawingBuffer: true });
      const json = await (await fetch(look.model, { cache: 'no-cache' })).json();
      json.url = new URL(look.model, location.href).href;
      model = await PIXI.live2d.Live2DModel.from(json, { autoInteract: false });
      const im = model.internalModel;
      P = im.coreModel._model.parameters;
      P.ids.forEach((id, i) => index.set(id, i));
      im.coreModel._model.parts.ids.forEach((id, i) => partIndex.set(id, i));
      im.eyeBlink = undefined; // (her motions blink for her)
      const mm = im.motionManager;
      mm.groups.idle = ''; // (her idle is the layer underneath, not one of the library's motions)
      mm.on('motionLoaded', (group, i, motion) => {
        motion.setFadeInTime(BLEND);
        motion.setFadeOutTime(BLEND);
      });
      mm.on('motionStart', (group) => (current = { name: group, t0: now() }));
      mm.on('motionFinish', () => {
        if (!L.playing) return;
        L.playing = false;
        voiced = false;
        stateChanged();
      });
      im.on('beforeMotionUpdate', applyBase);
      // (the skin's own ranges for her looking after the pointer)
      if (game.range) {
        const focus = im.updateFocus.bind(im);
        im.updateFocus = () => {
          focus();
          for (const [id, r] of Object.entries(game.range)) if (Array.isArray(r)) put(id, clamp(get(id), r[0], r[1]));
        };
      }
      im.on('afterMotionUpdate', () => {
        applyEffect();
        stepDrags();
        applyHeld();
      });
      // her mouth: the line's loudness, eased (opens fast, closes a little slower)
      im.on('beforeModelUpdate', () => {
        let want = 0;
        if (talkingNow && voice && !voice.el.paused) want = voice.env ? voice.env[Math.floor((voice.el.currentTime + 0.04) * 60)] ?? 0 : 0.45 + 0.4 * Math.sin(now() * 17);
        mouth += (want - mouth) * (want > mouth ? 0.5 : 0.3);
        if (mouth > 0.01 || talkingNow || (voiced && L.playing)) put('ParamMouthOpenY', mouth);
      });
      if (has('effect')) {
        const j = await motionJson('effect');
        if (j) effect = { curves: curvesOf(j), len: Number(j.Meta?.Duration) || 0, t0: now() };
      }
      setUpDrags();
      // (lengths for the drags that wait for a point in a motion; cues for skins timed by them)
      for (const d of L.drags) if (d.trig.type === TR.ANIM) readMotion(d.trig.trigger_name === 'idle' && d.trig.trigger_index > 0 ? 'idle' + d.trig.trigger_index : d.trig.trigger_name);
      if (game.cues) for (const g of Object.keys(look.lines || {})) readMotion(g);
      await toIdle();
      app.stage.addChild(model);
      frame(true);
      addEventListener('resize', () => frame(true));
      addEventListener('pagehide', save);
      let last = now();
      let frames = 0;
      app.ticker.add(() => {
        const t = now();
        const dt = Math.min(0.1, t - last);
        last = t;
        if (++frames === 3 && !card) findScene(); // (her idle drawn once: her scene, or her alone?)
        glide(dt);
        drawZones();
        songLevel(dt);
        // left alone, she says something now and then (when asked to: the game's lobby does it
        // 30 s after her last line)
        if (cfg.chatter && cfg.audio && !card && t - lastActivity > 30 && !T.busy()) {
          lastActivity = t;
          const m = pickMain();
          if (m) act(m);
        }
      });
      updateSong();
      if (!card) {
        lastActivity = now();
        // she greets you as she appears
        setTimeout(() => act('login'), 600);
      }
      canvas.classList.add('in');
      T.ready = true;
    } catch (err) {
      T.failed = String(err?.message || err);
      console.warn('azurlane: ' + T.failed);
    }
  })();
})();
