'use strict';
// HLS (.m3u8) for Truy tìm video (main/sniffer.js): a playlist read (a master's variants, a media
// playlist's pieces, keys and length), and a stream downloaded piece by piece into one .mp4. Pieces
// that are already MP4 (fMP4, with their init piece) are joined as they are; MPEG-TS pieces are
// turned into MP4 by mux.js (video.js's transmuxer), also when a site hides them behind an image
// header. AES-128 pieces are decrypted with the key their playlist names, as any HLS player does; a
// stream under DRM (SAMPLE-AES, FairPlay, Widevine, PlayReady) is not downloaded.
const crypto = require('crypto');

const attrs = (s) => {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
};
const abs = (u, base) => new URL(u, base).href;
const byterange = (s, prevEnd) => {
  const [n, o] = String(s).split('@');
  return { length: Number(n) || 0, offset: o !== undefined ? Number(o) || 0 : prevEnd };
};

// { variants: [{ url, bandwidth, width, height, fps, audioApart, audioGroup }], audios: [{ group, name,
// default, url }], segments: [{ url, duration, seq, key, map, range }], duration, live, drm }
function parse(text, base) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('not hls');
  // (audio groups with a playlist of their own: those variants have no sound in them)
  const audios = [];
  for (const l of lines) {
    if (!l.startsWith('#EXT-X-MEDIA:')) continue;
    const a = attrs(l.slice(13));
    if (a.TYPE === 'AUDIO' && a.URI) audios.push({ group: a['GROUP-ID'], name: a.NAME || '', default: a.DEFAULT === 'YES', url: abs(a.URI, base) });
  }
  const audio = new Set(audios.map((x) => x.group));
  const variants = [];
  const segments = [];
  let seq = 0;
  let key = null;
  let map = null;
  let dur = 0;
  let range = null;
  let lastEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(l.slice(18));
      const uri = lines[i + 1];
      if (uri && !uri.startsWith('#')) {
        const [w, h] = String(a.RESOLUTION || '').split('x').map(Number);
        variants.push({ url: abs(uri, base), bandwidth: Number(a.BANDWIDTH) || 0, width: w || 0, height: h || 0, fps: Number(a['FRAME-RATE']) || 0, audioApart: !!a.AUDIO && audio.has(a.AUDIO), audioGroup: a.AUDIO || '' });
        i++;
      }
    } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(l.slice(22), 10) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = attrs(l.slice(11));
      key = a.METHOD === 'NONE' ? null : { method: a.METHOD, url: a.URI ? abs(a.URI, base) : '', iv: a.IV || '', format: a.KEYFORMAT || 'identity' };
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = attrs(l.slice(11));
      map = { url: abs(a.URI, base), range: a.BYTERANGE ? byterange(a.BYTERANGE, 0) : null };
    } else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 0;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) range = byterange(l.slice(17), lastEnd);
    else if (!l.startsWith('#')) {
      segments.push({ url: abs(l, base), duration: dur, seq: seq + segments.length, key, map, range });
      if (range) lastEnd = range.offset + range.length;
      range = null;
      dur = 0;
    }
  }
  return {
    variants,
    audios,
    segments,
    duration: segments.reduce((a, s) => a + s.duration, 0),
    live: !variants.length && !lines.includes('#EXT-X-ENDLIST'),
    drm: segments.some((s) => s.key && (s.key.method !== 'AES-128' || s.key.format !== 'identity')),
  };
}

// (the best variant: the most pixels, then the most bits; one with its sound in it before one without)
const best = (variants) => variants.map((v, i) => [v, i]).sort(([a], [b]) => a.audioApart - b.audioApart || b.height - a.height || b.bandwidth - a.bandwidth)[0][1];

// an MPEG-TS piece from where its packets start (some sites put an image header before them)
function tsFrom(buf) {
  if (buf[0] === 0x47) return buf;
  for (let o = 0; o < Math.min(buf.length - 376, 65536); o++) if (buf[o] === 0x47 && buf[o + 188] === 0x47 && buf[o + 376] === 0x47) return buf.subarray(o);
  return buf;
}

// a piece's bytes, decrypted when its playlist names an AES-128 key (its key read once), retried a
// few times
function pieces(get, signal) {
  const keys = new Map();
  const keyOf = (k) => {
    if (!keys.has(k.url)) keys.set(k.url, get(k.url, { binary: true }));
    return keys.get(k.url);
  };
  const ivOf = (s) => {
    if (s.key.iv) return Buffer.from(s.key.iv.replace(/^0x/i, '').padStart(32, '0').slice(-32), 'hex');
    const b = Buffer.alloc(16);
    b.writeUInt32BE(s.seq >>> 0, 12);
    return b;
  };
  const retry = async (fn) => {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i >= 3 || signal?.aborted) throw err;
        await new Promise((ok) => setTimeout(ok, 600 * (i + 1)));
      }
    }
  };
  const piece = async (s) => {
    let buf = await retry(() => get(s.url, { binary: true, range: s.range }));
    if (s.key) {
      const d = crypto.createDecipheriv('aes-128-cbc', await keyOf(s.key), ivOf(s));
      buf = Buffer.concat([d.update(buf), d.final()]);
    }
    return buf;
  };
  return { piece, retry };
}

// MPEG-TS pieces into MP4 (mux.js): push(buf) → the MP4 bytes made so far (its init first)
function transmuxer() {
  const { Transmuxer } = require('mux.js').mp4;
  const mux = new Transmuxer({ remux: true });
  let inited = false;
  let ready = [];
  mux.on('data', (seg) => {
    if (!inited) {
      ready.push(Buffer.from(seg.initSegment));
      inited = true;
    }
    ready.push(Buffer.from(seg.data));
  });
  return (buf) => {
    mux.push(new Uint8Array(tsFrom(buf)));
    mux.flush();
    const chunks = ready;
    ready = [];
    return chunks;
  };
}

// a moment of a stream as a small playable .mp4 (its init and one piece a tenth of the way in, of its
// smallest variant): for its picture and frame rate (main/mediaprobe.js)
async function sample({ get, url, signal }) {
  let pl = parse(await get(url), url);
  if (pl.variants.length) {
    const v = [...pl.variants].sort((a, b) => (a.height || 1e5) - (b.height || 1e5) || a.bandwidth - b.bandwidth)[0];
    pl = parse(await get(v.url), v.url);
  }
  if (pl.drm) throw new Error('drm');
  const segs = pl.segments;
  if (!segs.length) throw new Error('empty');
  const s = segs[pl.live ? Math.max(0, segs.length - 2) : Math.min(segs.length - 1, Math.floor(segs.length / 10))];
  const { piece, retry } = pieces(get, signal);
  const buf = await piece(s);
  if (s.map) return Buffer.concat([await retry(() => get(s.map.url, { binary: true, range: s.map.range })), buf]);
  const out = transmuxer()(buf);
  if (!out.length) throw new Error('empty');
  return Buffer.concat(out);
}

// frames per second of the start of an MPEG-TS piece, from its video's timestamps (DTS, else PTS)
function tsFps(buf) {
  buf = tsFrom(buf);
  const VIDEO = [0x01, 0x02, 0x10, 0x1b, 0x24, 0x42, 0xea];
  const stamp = (q) => ((buf[q] >> 1) & 7) * 2 ** 30 + buf[q + 1] * 2 ** 22 + (buf[q + 2] >> 1) * 2 ** 15 + buf[q + 3] * 2 ** 7 + (buf[q + 4] >> 1);
  let pmt = -1;
  let video = -1;
  const times = [];
  for (let o = 0; o + 188 <= buf.length && buf[o] === 0x47; o += 188) {
    const start = buf[o + 1] & 0x40;
    const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];
    const afc = (buf[o + 3] >> 4) & 3;
    if (!start || afc === 2) continue;
    let p = o + 4 + (afc === 3 ? 1 + buf[o + 4] : 0);
    if (p >= o + 184) continue;
    if (pid === 0 || pid === pmt) {
      p += 1 + buf[p]; // (pointer field)
      const end = Math.min(o + 188, p + 3 + (((buf[p + 1] & 0x0f) << 8) | buf[p + 2]) - 4);
      if (pid === 0) {
        for (let q = p + 8; q + 4 <= end; q += 4)
          if ((buf[q] << 8) | buf[q + 1]) {
            pmt = ((buf[q + 2] & 0x1f) << 8) | buf[q + 3];
            break;
          }
      } else if (video < 0) {
        for (let q = p + 12 + (((buf[p + 10] & 0x0f) << 8) | buf[p + 11]); q + 5 <= end; q += 5 + (((buf[q + 3] & 0x0f) << 8) | buf[q + 4]))
          if (VIDEO.includes(buf[q])) {
            video = ((buf[q + 1] & 0x1f) << 8) | buf[q + 2];
            break;
          }
      }
    } else if (pid === video && buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1 && buf[p + 7] & 0x80) times.push(buf[p + 7] & 0x40 ? stamp(p + 14) : stamp(p + 9));
  }
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((x, i) => x - sorted[i]).filter((g) => g > 0 && g < 9000).sort((a, b) => a - b);
  return gaps.length >= 4 ? 90000 / gaps[Math.floor(gaps.length / 3)] : 0;
}

// each variant's frame rate (or the playlist's own, for a media playlist): the one it states, else read
// from the start of its first piece (MPEG-TS only; an fMP4 one that states none stays 0)
async function frameRates({ get, url }) {
  const pl = parse(await get(url), url);
  const of = async (media, known) => {
    if (known) return known;
    const m = media || parse(await get(url), url);
    const s = m.segments[0];
    if (!s || s.map || m.drm) return 0;
    const offset = s.range?.offset || 0;
    let buf = await get(s.url, { binary: true, range: { offset, length: Math.min(s.range?.length || Infinity, 188 * 1024) } });
    if (s.key) {
      const iv = s.key.iv ? Buffer.from(s.key.iv.replace(/^0x/i, '').padStart(32, '0').slice(-32), 'hex') : Buffer.alloc(16);
      if (!s.key.iv) iv.writeUInt32BE(s.seq >>> 0, 12);
      const d = crypto.createDecipheriv('aes-128-cbc', await get(s.key.url, { binary: true }), iv).setAutoPadding(false);
      buf = d.update(buf.subarray(0, buf.length - (buf.length % 16)));
    }
    return tsFps(buf);
  };
  if (!pl.variants.length) return [await of(pl, 0).catch(() => 0)];
  return Promise.all(pl.variants.map(async (v) => (v.fps ? v.fps : of(parse(await get(v.url), v.url), 0).catch(() => 0))));
}

// get(url, { binary, range }) → string | Buffer; out: a write stream; progress({ done, total, bytes })
async function download({ get, url, variant, out, progress, signal }) {
  let pl = parse(await get(url), url);
  let audioUrl = '';
  if (pl.variants.length) {
    const v = pl.variants[Number.isInteger(variant) && pl.variants[variant] ? variant : best(pl.variants)];
    if (v.audioApart) {
      const group = pl.audios.filter((a) => a.group === v.audioGroup);
      audioUrl = (group.find((a) => a.default) || group[0])?.url || '';
    }
    url = v.url;
    pl = parse(await get(url), url);
  }
  if (pl.drm) throw new Error('drm');
  if (pl.live) throw new Error('live');
  const segs = pl.segments;
  if (!segs.length) throw new Error('empty');
  const { piece, retry } = pieces(get, signal);
  let bytes = 0;
  const write = async (b) => {
    bytes += b.length;
    if (!out.write(b)) await new Promise((ok) => out.once('drain', ok));
  };
  const fmp4 = !!segs[0].map;
  const mux = fmp4 ? null : transmuxer();
  if (fmp4) await write(await retry(() => get(segs[0].map.url, { binary: true, range: segs[0].map.range })));
  // in order, a few pieces fetched ahead
  const AHEAD = 6;
  const pending = new Map();
  for (let next = 0, asked = 0; next < segs.length; next++) {
    while (asked < segs.length && asked - next < AHEAD) {
      const p = piece(segs[asked]);
      p.catch(() => {}); // (its failure is met when its turn comes)
      pending.set(asked++, p);
    }
    const buf = await pending.get(next);
    pending.delete(next);
    if (signal?.aborted) throw new Error('aborted');
    if (fmp4) await write(buf);
    else for (const c of mux(buf)) await write(c);
    progress?.({ done: next + 1, total: segs.length, bytes });
  }
  return { bytes, duration: pl.duration, audioUrl };
}

module.exports = { parse, best, download, sample, frameRates };
