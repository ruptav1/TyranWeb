// The address bar's shield and VPN buttons (omnibox.js draws them):
//  - the shield: the ad blocker on the page's site. On for every site; turned off here for this
//    site only (its list: privacy.adblockOff), the page reloaded. It names the engine really in use
//    and counts what it blocked on the page; an engine change made in Settings is told when it
//    takes over.
//  - VPN: Đổi vị trí (main/vpn.js, Tor), on or off for TyranWeb's pages, the country they seem to
//    come from, their address there, a new address.
//  - on a search engine's results page: the country its results are for (main/searchregion.js),
//    the page asked for again in the one picked.
import { api, h, emit } from './util.js';
import { S } from './state.js';
import { T, active, byWc, reload, navigate, createTab } from './tabs.js';
import { openPopover, closePopover, toast } from './menus.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';
import { regionName as named, regionOptions } from 'tyran://shared/regions.js';

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
// (the VPN button lights when the pages really go through Tor, not only when it is asked for)
let routed = false;
export const vpnState = () => ({ on: routed, asked: !!S.settings.privacy.vpn });
api.invoke('vpn:routed').then((v) => ((routed = !!v), emit('shields')), () => {});
api.on('vpn:routed', (v) => {
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

// ---- VPN: Đổi vị trí (main/vpn.js, Tor)
// a country's name in the user's language ('' any)
const regionName = (cc) => (cc ? named(cc) : t('Bất kỳ'));
// what Tor is doing, in words: fetching it, connecting, connected (and from where), its error
export function vpnStatus(s) {
  if (!s) return '';
  if (s.downloading) return t('Đang tải Tor… {0}%', Math.round(s.downloading * 100));
  if (s.error && !s.running) return t('Không chạy được Tor: {0}', s.error);
  if (!s.on) return t('Đang tắt');
  if (!s.ready) return t('Đang kết nối Tor… {0}%', s.bootstrap || 0);
  if (!s.exit) return t('Đã kết nối');
  if (!s.exit.ip) return t('Đã kết nối, chưa lấy được địa chỉ');
  return `IP ${s.exit.ip}${s.exit.country ? ' · ' + regionName(s.exit.country) : ''}`;
}

export async function vpnPopover(anchor) {
  const status = h('div', { class: 'muted small', text: '…' });
  const sw = h('input', { type: 'checkbox', checked: !!S.settings.privacy.vpn });
  const pick = h('select', { class: 'select small' });
  // every site through it, or only the ones chosen; and this tab's site in or out
  const mode = h('select', { class: 'select small' }, h('option', { value: 'all', text: t('Mọi trang') }), h('option', { value: 'only', text: t('Chỉ trang đã chọn') }));
  mode.value = S.settings.privacy.vpnMode === 'only' ? 'only' : 'all';
  const tab = active();
  let site = '';
  try {
    site = /^https?:/.test(tab?.url || '') ? new URL(tab.url).hostname.replace(/^www\./, '') : '';
  } catch {
    /* (no page) */
  }
  const siteSw = h('input', { type: 'checkbox' });
  const siteRow = h('label', { class: 'site-row' }, h('span', { text: t('Đổi vị trí cho {0}', site) }), h('span', { class: 'switch' }, siteSw, h('span')));
  const listKey = () => (mode.value === 'only' ? 'vpnOnly' : 'vpnSkip');
  const paintSite = () => {
    const list = S.settings.privacy[listKey()] || [];
    const listed = list.includes(site);
    siteSw.checked = mode.value === 'only' ? listed : !listed;
    siteRow.hidden = !site;
  };
  paintSite();
  const renew = h('button', { class: 'btn small', html: `${icon('reload', 14)}<span>${t('Đổi IP')}</span>` });
  renew.hidden = true;
  const body = h(
    'div',
    { class: 'site-pop vpn-pop' },
    h('div', { class: 'pop-head' }, h('span', { class: 'pop-head-ico vpn-ico', html: icon('globe', 18) }), h('div', {}, h('b', { text: t('Đổi vị trí · Tor') }), status)),
    h('label', { class: 'site-row' }, h('span', { text: t('Đổi vị trí của TyranWeb') }), h('span', { class: 'switch' }, sw, h('span'))),
    h('div', { class: 'site-row' }, h('span', { text: t('Quốc gia') }), pick),
    h('div', { class: 'site-row' }, h('span', { text: t('Áp dụng cho') }), mode),
    siteRow,
    h('div', { class: 'vpn-extra' }, renew)
  );
  const pop = openPopover(body, anchor, { align: 'end', focus: false });
  const draw = (s) => {
    if (!body.isConnected) return off();
    status.textContent = vpnStatus(s);
    if (s && !pick.options.length) {
      for (const cc of ['', ...s.countries]) pick.append(h('option', { value: cc, text: regionName(cc) }));
      pick.value = S.settings.privacy.vpnCountry || '';
    }
    renew.hidden = !s?.ready;
    pop.reposition();
  };
  const off = api.on('vpn:changed', draw);
  api.invoke('vpn:state').then(draw, () => draw(null));
  sw.addEventListener('change', async () => {
    await api.invoke('settings:set', { privacy: { vpn: sw.checked } });
    toast(t(sw.checked ? 'Đã bật đổi vị trí' : 'Đã tắt đổi vị trí'), { icon: 'globe' });
    emit('shields');
  });
  pick.addEventListener('change', () => api.invoke('settings:set', { privacy: { vpnCountry: pick.value } }));
  mode.addEventListener('change', async () => {
    await api.invoke('settings:set', { privacy: { vpnMode: mode.value } });
    paintSite();
    if (tab) reload(tab.id);
  });
  siteSw.addEventListener('change', async () => {
    const key = listKey();
    const list = (S.settings.privacy[key] || []).filter((d) => d !== site);
    const listed = mode.value === 'only' ? siteSw.checked : !siteSw.checked;
    await api.invoke('settings:set', { privacy: { [key]: listed ? [...list, site] : list } });
    if (tab) reload(tab.id);
  });
  renew.addEventListener('click', async () => {
    renew.disabled = true;
    status.textContent = '…';
    try {
      draw(await api.invoke('vpn:action', 'renew'));
    } catch {
      toast(t('Không đổi được IP'), { icon: 'info' });
    }
    renew.disabled = false;
  });
}

// ---- Kết quả tìm kiếm ở (main/searchregion.js), from the chip on a results page
export function regionPopover(anchor) {
  const tab = active();
  const cur = () => S.settings.general.searchRegion || '';
  const status = h('div', { class: 'muted small' });
  const paint = () => (status.textContent = cur() ? named(cur()) : t('Mặc định'));
  const pick = h('select', { class: 'select small' }, h('option', { value: '', text: t('Mặc định') }), ...regionOptions().map(([cc, name]) => h('option', { value: cc, text: name })));
  pick.value = cur();
  paint();
  const body = h(
    'div',
    { class: 'site-pop region-pop' },
    h('div', { class: 'pop-head' }, h('span', { class: 'pop-head-ico region-ico', html: icon('mapPin', 18) }), h('div', {}, h('b', { text: t('Kết quả tìm kiếm ở') }), status)),
    h('div', { class: 'site-row' }, h('span', { text: t('Quốc gia') }), pick)
  );
  openPopover(body, anchor, { align: 'end', focus: false });
  pick.addEventListener('change', async () => {
    await api.invoke('settings:set', { general: { searchRegion: pick.value } });
    paint();
    if (tab?.url) navigate(tab.id, await api.invoke('search:regionUrl', tab.url));
  });
}
