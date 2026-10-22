'use strict';
// Tiny JSON persistence with debounced, atomic writes and a .bak fallback.
const fs = require('fs');
const path = require('path');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Fill missing keys from `defaults` without touching values the user already has.
function fillDefaults(target, defaults) {
  if (!isPlainObject(target)) return structuredClone(defaults);
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in target)) target[k] = structuredClone(v);
    else if (isPlainObject(v) && isPlainObject(target[k])) fillDefaults(target[k], v);
  }
  return target;
}

// Deep-merge a partial patch into `target`. Arrays and primitives are replaced.
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (isPlainObject(v) && isPlainObject(target[k])) deepMerge(target[k], v);
    else target[k] = structuredClone(v);
  }
  return target;
}

class JsonStore {
  constructor(file, defaults, { delay = 400 } = {}) {
    this.file = file;
    this.defaults = defaults;
    this.delay = delay;
    this.timer = null;
    this.data = fillDefaults(this.read(), defaults);
  }

  read() {
    for (const f of [this.file, this.file + '.bak']) {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        /* try next */
      }
    }
    return structuredClone(this.defaults);
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
      fs.renameSync(tmp, this.file);
      this.failures = 0;
    } catch (err) {
      // On Windows the rename fails while another program holds the file for a moment (antivirus,
      // indexing, sync): try again shortly, so the last change is not lost on the next start.
      console.error('[store] write failed', this.file, err.code || err);
      this.failures = (this.failures || 0) + 1;
      if (this.failures <= 5 && !this.timer) this.timer = setTimeout(() => this.flush(), 250 * this.failures);
    }
  }
}

module.exports = { JsonStore, deepMerge, fillDefaults, isPlainObject };
