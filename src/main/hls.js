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

// { variants: [{ url, bandwidth, width, height, audioApart, audioGroup }], audios: [{ group, name,
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
        variants.push({ url: abs(uri, base), bandwidth: Number(a.BANDWIDTH) || 0, width: w || 0, height: h || 0, audioApart: !!a.AUDIO && audio.has(a.AUDIO), audioGroup: a.AUDIO || '' });
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
  let bytes = 0;
  const write = async (b) => {
    bytes += b.length;
    if (!out.write(b)) await new Promise((ok) => out.once('drain', ok));
  };
  const fmp4 = !!segs[0].map;
  let mux = null;
  let ready = [];
  if (fmp4) await write(await retry(() => get(segs[0].map.url, { binary: true, range: segs[0].map.range })));
  else {
    const { Transmuxer } = require('mux.js').mp4;
    let inited = false;
    mux = new Transmuxer({ remux: true });
    mux.on('data', (seg) => {
      if (!inited) {
        ready.push(Buffer.from(seg.initSegment));
        inited = true;
      }
      ready.push(Buffer.from(seg.data));
    });
  }
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
    else {
      mux.push(new Uint8Array(tsFrom(buf)));
      mux.flush();
      const chunks = ready;
      ready = [];
      for (const c of chunks) await write(c);
    }
    progress?.({ done: next + 1, total: segs.length, bytes });
  }
  return { bytes, duration: pl.duration, audioUrl };
}

module.exports = { parse, best, download };
