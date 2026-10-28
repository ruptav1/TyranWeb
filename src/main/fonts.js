'use strict';
// The user's own fonts (Settings → Giao diện → Phông chữ giao diện): font files picked or dropped
// there are copied into <data>/fonts (served as tyran://fonts/<file>) and listed in
// appearance.customFonts as { family, file, weight, italic }, read from the file itself (its name
// and OS/2 tables), so that a family's Regular, Bold and Italic files make one font. The window and
// TyranWeb's pages load them with @font-face (shared/theme.js).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const data = require('./data');

const DIR = path.join(data.dir, 'fonts');
const EXT = /\.(ttf|otf|ttc|woff2?)$/i;
const MAX = 40 * 1024 * 1024;

// ---------------------------------------------------------------- reading a font file
// the tables of an sfnt font (TrueType / OpenType; the first font of a collection), or of a WOFF
// (each table zlib-compressed); WOFF2 is not read (its name comes from the file's name)
function tables(buf) {
  const tag = buf.toString('latin1', 0, 4);
  const out = {};
  if (tag === 'wOFF') {
    const n = buf.readUInt16BE(12);
    for (let i = 0; i < n; i++) {
      const p = 44 + i * 20;
      const [t, off, comp, orig] = [buf.toString('latin1', p, p + 4), buf.readUInt32BE(p + 4), buf.readUInt32BE(p + 8), buf.readUInt32BE(p + 12)];
      out[t] = () => {
        const raw = buf.subarray(off, off + comp);
        return comp < orig ? zlib.inflateSync(raw) : raw;
      };
    }
    return out;
  }
  if (tag === 'wOF2') return out;
  const base = tag === 'ttcf' ? buf.readUInt32BE(12) : 0;
  const n = buf.readUInt16BE(base + 4);
  for (let i = 0; i < n; i++) {
    const p = base + 12 + i * 16;
    const [t, off, len] = [buf.toString('latin1', p, p + 4), buf.readUInt32BE(p + 8), buf.readUInt32BE(p + 12)];
    out[t] = () => buf.subarray(off, off + len);
  }
  return out;
}
// a name from the name table: Windows' (UTF-16, US English first) else the Mac's
function nameOf(t, ids) {
  const count = t.readUInt16BE(2);
  const strings = t.readUInt16BE(4);
  const found = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12;
    const [platform, , lang, id, len, off] = [0, 2, 4, 6, 8, 10].map((k) => t.readUInt16BE(p + k));
    if (!ids.includes(id)) continue;
    const raw = t.subarray(strings + off, strings + off + len);
    let s = '';
    if (platform === 3 || platform === 0) for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k));
    else if (platform === 1) s = raw.toString('latin1');
    if (s.trim()) found.push({ s: s.trim(), rank: ids.indexOf(id) * 10 + (platform === 3 ? (lang === 0x409 ? 0 : 1) : 5) });
  }
  return found.sort((a, b) => a.rank - b.rank)[0]?.s || '';
}
function readFont(file, buf) {
  const fromName = path.basename(file).replace(EXT, '').replace(/[-_]+/g, ' ').replace(/\s+(regular|book|normal)$/i, '').trim();
  const info = { family: fromName, weight: 400, italic: /italic|oblique/i.test(file) };
  try {
    const t = tables(buf);
    // (the typographic family first: "Nunito", not "Nunito Black")
    const family = t.name && nameOf(t.name(), [16, 1]);
    if (family) info.family = family;
    const os2 = t['OS/2']?.();
    if (os2 && os2.length >= 64) {
      info.weight = Math.min(900, Math.max(100, os2.readUInt16BE(4) || 400));
      info.italic = !!(os2.readUInt16BE(62) & 1);
    }
  } catch {
    /* a file it cannot read: named after itself */
  }
  info.family = info.family.replace(/["\\]/g, '').slice(0, 80);
  return info;
}

// ---------------------------------------------------------------- adding and removing
const list = () => (Array.isArray(data.settings.data.appearance.customFonts) ? data.settings.data.appearance.customFonts : []);

// Copies the font files among `files` (others are skipped) and returns the fonts added; one already
// there (the same file) is not added twice.
function add(files) {
  fs.mkdirSync(DIR, { recursive: true });
  const have = list();
  const added = [];
  for (const file of (Array.isArray(files) ? files : []).map(String)) {
    if (!EXT.test(file) || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size > MAX) continue;
    const buf = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
    const name = `${path.basename(file).replace(EXT, '').replace(/[^\w.-]+/g, '_').slice(0, 60)}-${hash}${path.extname(file).toLowerCase()}`;
    if (have.some((f) => f.file === name) || added.some((f) => f.file === name)) continue;
    fs.writeFileSync(path.join(DIR, name), buf);
    added.push({ ...readFont(file, buf), file: name });
  }
  return added;
}

// The files of a family, deleted (they leave the list too)
function removeFamily(family) {
  for (const f of list().filter((x) => x.family === family)) fs.rmSync(path.join(DIR, path.basename(f.file)), { force: true });
  return list().filter((x) => x.family !== family);
}

module.exports = { DIR, add, removeFamily, readFont };
