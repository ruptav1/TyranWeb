// The address bar's shield and VPN buttons (omnibox.js draws them):
//  - the shield: the ad blocker on the page's site. On for every site; turned off here for this
//    site only (its list: privacy.adblockOff), the page reloaded. It names the engine really in use
//    and counts what it blocked on the page; an engine change made in Settings is told when it
//    takes over.
//  - VPN: Cloudflare WARP (main/warp.js), on or off for TyranWeb's pages, its address and country, a
//    new address.
import { api, h, emit } from './util.js';
import { S } from './state.js';
import { T, active, byWc, reload, createTab } from './tabs.js';
import { openPopover, closePopover, toast } from './menus.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

const ENGINE_NAME = { ghostery: 'Thông thường', brave: 'Brave', 'brave-full': 'Brave đầy đủ' };
const ENGINE_DESC = { ghostery: 'Bộ lọc Ghostery (EasyList, EasyPrivacy…)', brave: 'Danh sách bộ lọc của Brave', 'brave-full': 'Bộ máy chặn quảng cáo của Brave (adblock-rust)' };

// what the shield shows for a tab: blocking here?, how many blocked
// (off for a site: the page is of it or of a subdomain of it, as main/adblock.js has it)
export function shieldState(tab) {
  let host = '';
  try {
    host = new URL(tab?.url || '').hostname;
  } catch {
    /* (no page) */
  }
  const off = (S.settings.privacy.adblockOff || []).some((d) => host === d || host.endsWith('.' + d));
  return { on: !!S.settings.privacy.adblock && !off, blocked: tab?.blocked || 0 };
}

api.on('adblock:count', ({ wcId, count }) => {
  const tab = byWc(wcId);
  if (!tab) return;
  tab.blocked = count;
  if (tab.id === T.activeId) emit('shields');
});
// (the VPN button lights when the pages really go through WARP, not only when it is asked for)
let routed = false;
export const vpnState = () => ({ on: routed, asked: !!S.settings.privacy.warp });
api.invoke('warp:routed').then((v) => ((routed = !!v), emit('shields')), () => {});
api.on('warp:routed', (v) => {
  routed = !!v;
  emit('shields');
});
api.on('adblock:engine', ({ name }) => toast(t('Đã đổi bộ lọc quảng cáo: {0}', t(ENGINE_NAME[name] || name)), { icon: 'shieldCheck' }));

export async function shieldPopover(anchor) {
  const tab = active();
  if (!tab) return;
  const [engine, site] = await Promise.all([api.invoke('adblock:engine').catch(() => null), api.invoke('adblock:site', tab.url).catch(() => null)]);
  const global = !!S.settings.privacy.adblock;
  const using = engine?.using || engine?.asked || S.settings.privacy.adblockEngine;
  const rows = [];
  // (the site's switch turns off all of it there: the ad blocking and Brave's other protections)
  if (site?.site) {
    const sw = h('input', { type: 'checkbox', checked: site.on });
    sw.addEventListener('change', async () => {
      await api.invoke('adblock:site', tab.url, sw.checked);
      toast(t(sw.checked ? 'Đã bật bảo vệ trên {0}' : 'Đã tắt bảo vệ trên {0}', site.site), { icon: sw.checked ? 'shieldCheck' : 'shield' });
      emit('shields');
      reload(tab.id);
    });
    rows.push(h('label', { class: 'site-row' }, h('span', { text: t('Bảo vệ trên {0}', site.site) }), h('span', { class: 'switch' }, sw, h('span'))));
  }
  if (!global) {
    const sw = h('input', { type: 'checkbox' });
    sw.addEventListener('change', async () => {
      await api.invoke('settings:set', { privacy: { adblock: sw.checked } });
      toast(t('Đã bật chặn quảng cáo — tải lại trang để áp dụng'), { icon: 'shield' });
    });
    rows.push(h('label', { class: 'site-row' }, h('span', { text: t('Chặn quảng cáo đang tắt') }), h('span', { class: 'switch' }, sw, h('span'))));
  }
  const on = global && site?.on !== false;
  // What protects this page now, one row each: on (a tick), or off (a dash, dimmed, and why)
  const p = S.settings.privacy;
  const siteOn = site?.on !== false;
  const offWhy = (setting) => (!setting ? t('Đang tắt trong Cài đặt') : !siteOn ? t('Đang tắt cho trang này') : '');
  const item = (title, sub, why, box) =>
    h(
      'div',
      { class: `shield-item${why ? ' off' : ''}` },
      h('span', { class: 'shield-box', html: box ?? (why ? '—' : icon('check', 14)) }),
      h('span', { class: 'shield-text' }, h('b', { text: title }), why || sub ? h('span', { text: why || sub }) : null)
    );
  let secure = false;
  try {
    secure = new URL(tab.url).protocol === 'https:';
  } catch {
    /* (no page) */
  }
  const list = h(
    'div',
    { class: 'shield-list' },
    item(t('Quảng cáo và trình theo dõi đã chặn'), '', offWhy(global), global && siteOn ? `<b>${tab.blocked || 0}</b>` : null),
    item(t('Kết nối an toàn (HTTPS)'), '', secure ? '' : t('Trang này không dùng HTTPS')),
    item(t('Chống lấy dấu vân tay'), t('Canvas, WebGL, âm thanh và số nhân CPU bị làm nhiễu'), offWhy(p.fingerprint)),
    item(t('Chặn cookie bên thứ ba'), '', offWhy(p.blockThirdPartyCookies)),
    item(t('Bỏ tham số theo dõi trong link'), t('fbclid, gclid… và trang chuyển hướng theo dõi'), offWhy(p.stripParams || p.debounce)),
    item(t('Ẩn bảng hỏi cookie'), '', offWhy(p.cookieNotices))
  );
  const settingsBtn = h('button', { class: 'btn small', text: t('Cài đặt Shields') });
  settingsBtn.addEventListener('click', () => {
    closePopover();
    createTab({ url: 'tyran://settings/#privacy' });
  });
  const body = h(
    'div',
    { class: 'site-pop shield-pop' },
    h('div', { class: 'pop-head' }, h('span', { class: `pop-head-ico ${on ? 'ok' : 'bad'}`, html: icon(on ? 'shieldCheck' : 'shield', 18) }), h('div', {}, h('b', { text: t('Chặn quảng cáo & theo dõi') }), h('div', { class: 'muted small', text: t(ENGINE_DESC[using] || ENGINE_DESC.ghostery) }))),
    ...rows,
    list,
    h('div', { class: 'shield-foot' }, h('span', { text: t('Trang hiển thị lỗi? Tắt Shields cho riêng trang này.') }), settingsBtn)
  );
  openPopover(body, anchor, { align: 'end', focus: false });
}

// ---- VPN (Cloudflare WARP)
export async function vpnPopover(anchor) {
  const status = h('div', { class: 'muted small', text: '…' });
  const sw = h('input', { type: 'checkbox', checked: !!S.settings.privacy.warp });
  const extra = h('div', { class: 'vpn-extra' });
  const body = h(
    'div',
    { class: 'site-pop vpn-pop' },
    h('div', { class: 'pop-head' }, h('span', { class: 'pop-head-ico vpn-ico', html: icon('globe', 18) }), h('div', {}, h('b', { text: 'VPN · Cloudflare WARP' }), status)),
    h('label', { class: 'site-row' }, h('span', { text: t('Đi qua Cloudflare WARP') }), h('span', { class: 'switch' }, sw, h('span'))),
    extra
  );
  const pop = openPopover(body, anchor, { align: 'end', focus: false });
  const press = (what, b) => async () => {
    b.disabled = true;
    status.textContent = '…';
    try {
      await api.invoke('warp:action', what);
    } catch {
      toast(t('Không điều khiển được WARP'), { icon: 'info' });
    }
    draw();
  };
  async function draw() {
    const s = await api.invoke('warp:state').catch(() => null);
    if (!body.isConnected) return;
    extra.replaceChildren();
    if (!s) return void (status.textContent = '');
    if (!s.installed) {
      status.textContent = t('Chưa cài WARP');
      sw.disabled = true;
      const b = h('button', { class: 'btn small', html: `${icon('external', 14)}<span>${t('Tải WARP')}</span>` });
      b.addEventListener('click', () => (createTab({ url: 'https://one.one.one.one/' }), pop.close()));
      return void extra.append(b);
    }
    const w = s.where;
    const on = !!S.settings.privacy.warp && s.proxy && s.connected;
    status.textContent = [s.proxy ? (on ? t('Đã kết nối') : t('Chưa kết nối')) : t('WARP đang ở chế độ VPN'), w?.ip ? `IP ${w.ip}${w.loc ? ` (${w.loc})` : ''}` : ''].filter(Boolean).join(' · ');
    if (!s.proxy) {
      const b = h('button', { class: 'btn small', text: t('Chuyển WARP sang chế độ proxy') });
      b.addEventListener('click', press('proxy', b));
      extra.append(b);
    } else if (S.settings.privacy.warp) {
      const b = h('button', { class: 'btn small', html: `${icon('reload', 14)}<span>${t('Đổi IP')}</span>` });
      b.addEventListener('click', press('renew', b));
      extra.append(b);
    }
    pop.reposition();
  }
  sw.addEventListener('change', async () => {
    sw.disabled = true;
    status.textContent = '…';
    await api.invoke('settings:set', { privacy: { warp: sw.checked } });
    toast(t(sw.checked ? 'Đã bật VPN' : 'Đã tắt VPN'), { icon: 'globe' });
    emit('shields');
    setTimeout(() => {
      sw.disabled = false;
      draw();
    }, 2500);
  });
  draw();
}
