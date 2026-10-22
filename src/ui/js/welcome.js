// The first start (no language picked yet): before anything else, the language. Its greeting turns
// through the ten languages (or shows the one under the pointer); the one Windows uses is lit. A
// press picks it and TyranWeb opens in it at once, nothing else asked.
import { LANGS } from 'tyran://shared/i18n.js';
import { api, h } from './util.js';

const HELLO = {
  vi: ['Chào mừng đến với TyranWeb', 'Chọn ngôn ngữ của bạn'],
  en: ['Welcome to TyranWeb', 'Choose your language'],
  ja: ['TyranWeb へようこそ', '言語を選んでください'],
  ko: ['TyranWeb에 오신 것을 환영합니다', '언어를 선택하세요'],
  'zh-CN': ['欢迎使用 TyranWeb', '请选择语言'],
  es: ['Bienvenido a TyranWeb', 'Elige tu idioma'],
  'pt-BR': ['Bem-vindo ao TyranWeb', 'Escolha seu idioma'],
  fr: ['Bienvenue sur TyranWeb', 'Choisissez votre langue'],
  de: ['Willkommen bei TyranWeb', 'Wähle deine Sprache'],
  ru: ['Добро пожаловать в TyranWeb', 'Выберите язык'],
};

// the one Windows uses (or the nearest of the ten)
function systemLang() {
  const sys = (navigator.languages?.[0] || navigator.language || 'en').toLowerCase();
  return (LANGS.find(([c]) => c.toLowerCase() === sys) || LANGS.find(([c]) => sys.startsWith(c.split('-')[0].toLowerCase())) || ['en'])[0];
}

export function welcome() {
  return new Promise(() => {
    const mine = systemLang();
    const title = h('h1', { class: 'wl-title' });
    const sub = h('p', { class: 'wl-sub' });
    let shown = '';
    const say = (code) => {
      if (code === shown) return;
      shown = code;
      title.classList.remove('in');
      sub.classList.remove('in');
      void title.offsetWidth;
      [title.textContent, sub.textContent] = HELLO[code] || HELLO.en;
      title.lang = sub.lang = code;
      title.classList.add('in');
      sub.classList.add('in');
    };
    const order = [mine, ...LANGS.map(([c]) => c).filter((c) => c !== mine)];
    let turn = 0;
    let hovering = false;
    say(order[0]);
    const timer = setInterval(() => !hovering && say(order[++turn % order.length]), 2400);
    const grid = h('div', { class: 'wl-langs' });
    for (const [code, name] of LANGS) {
      const b = h('button', { type: 'button', class: 'wl-lang' + (code === mine ? ' mine' : ''), lang: code, text: name });
      b.addEventListener('pointerenter', () => ((hovering = true), say(code)));
      b.addEventListener('pointerleave', () => (hovering = false));
      b.addEventListener('click', async () => {
        clearInterval(timer);
        grid.querySelectorAll('button').forEach((x) => (x.disabled = true));
        b.classList.add('picked');
        await api.invoke('settings:set', { general: { language: code } }).catch(() => {});
        box.classList.add('out');
        setTimeout(() => location.reload(), 380); // (TyranWeb, in that language)
      });
      grid.append(b);
    }
    const box = h('div', { id: 'welcome' }, h('div', { class: 'wl-card' }, h('img', { class: 'wl-logo', src: 'tyran://shared/logo.svg', alt: '' }), title, sub, grid));
    document.body.append(box);
    document.body.classList.add('ready', 'welcoming');
  });
}
