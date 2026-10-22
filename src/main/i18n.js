'use strict';
// TyranWeb's languages. The interface is written in Vietnamese; each other language is a dictionary
// from those Vietnamese texts to its own (src/shared/locales/<code>.json; a text it lacks stays as
// written). The language is Settings → general.language: '' until the user picks one when TyranWeb
// first starts (English until then); a profile from before languages existed is Vietnamese.
// t(text, ...values): the text in the user's language, {0} {1}... filled with the values.
const fs = require('fs');
const path = require('path');

// [code, its own name, locale for dates and numbers]
const LANGS = [
  ['vi', 'Tiếng Việt', 'vi-VN'],
  ['en', 'English', 'en-US'],
  ['ja', '日本語', 'ja-JP'],
  ['ko', '한국어', 'ko-KR'],
  ['zh-CN', '简体中文', 'zh-CN'],
  ['es', 'Español', 'es-ES'],
  ['pt-BR', 'Português', 'pt-BR'],
  ['fr', 'Français', 'fr-FR'],
  ['de', 'Deutsch', 'de-DE'],
  ['ru', 'Русский', 'ru-RU'],
];
const LOCALES = path.join(__dirname, '..', 'shared', 'locales');
const dicts = new Map();
function dictOf(lang) {
  if (lang === 'vi') return {};
  if (!dicts.has(lang)) {
    let d = {};
    try {
      d = JSON.parse(fs.readFileSync(path.join(LOCALES, lang + '.json'), 'utf8'));
    } catch {
      /* none yet: as written */
    }
    dicts.set(lang, d);
  }
  return dicts.get(lang);
}
const chosen = () => require('./data').settings.data.general?.language || '';
const current = () => (LANGS.some(([c]) => c === chosen()) ? chosen() : 'en');
const localeOf = (lang) => LANGS.find(([c]) => c === lang)?.[2] || 'en-US';
function t(key, ...vals) {
  let s = dictOf(current())[key] ?? key;
  if (vals.length) s = s.replace(/\{(\d+)\}/g, (m, i) => String(vals[i] ?? ''));
  return s;
}
// what a page needs to speak the language (ipc i18n:get)
const info = () => ({ lang: current(), locale: localeOf(current()), dict: dictOf(current()), langs: LANGS, chosen: !!chosen() });

module.exports = { t, LANGS, current, info };
