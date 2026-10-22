'use strict';
// Keyboard shortcut table. "reserved" shortcuts are always taken by the browser, even
// while a web page has focus. The others are offered to the page first and only run
// when the page did not handle (preventDefault) the key, like Chromium does.

const DEFAULT_SHORTCUTS = {
  'tab.new': { label: 'Tab mới', keys: ['Ctrl+T'], reserved: true },
  'tab.incognito': { label: 'Tab ẩn danh mới (trong cửa sổ này)', keys: ['Ctrl+Alt+N'], reserved: true },
  'tab.close': { label: 'Đóng tab', keys: ['Ctrl+W', 'Ctrl+F4'], reserved: true },
  'tab.reopen': { label: 'Mở lại tab vừa đóng', keys: ['Ctrl+Shift+T'], reserved: true },
  'tab.next': { label: 'Tab tiếp theo', keys: ['Ctrl+Tab', 'Ctrl+PageDown'], reserved: true },
  'tab.prev': { label: 'Tab trước', keys: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], reserved: true },
  'tab.duplicate': { label: 'Nhân đôi tab', keys: ['Alt+Shift+D'], reserved: false },
  'tab.pin': { label: 'Ghim / bỏ ghim tab', keys: [], reserved: false },
  'tab.mute': { label: 'Tắt / bật tiếng tab', keys: ['Ctrl+M'], reserved: false },
  'tab.goto1': { label: 'Tới tab 1', keys: ['Ctrl+1'], reserved: true },
  'tab.goto2': { label: 'Tới tab 2', keys: ['Ctrl+2'], reserved: true },
  'tab.goto3': { label: 'Tới tab 3', keys: ['Ctrl+3'], reserved: true },
  'tab.goto4': { label: 'Tới tab 4', keys: ['Ctrl+4'], reserved: true },
  'tab.goto5': { label: 'Tới tab 5', keys: ['Ctrl+5'], reserved: true },
  'tab.goto6': { label: 'Tới tab 6', keys: ['Ctrl+6'], reserved: true },
  'tab.goto7': { label: 'Tới tab 7', keys: ['Ctrl+7'], reserved: true },
  'tab.goto8': { label: 'Tới tab 8', keys: ['Ctrl+8'], reserved: true },
  'tab.gotoLast': { label: 'Tới tab cuối', keys: ['Ctrl+9'], reserved: true },
  'window.new': { label: 'Cửa sổ mới', keys: ['Ctrl+N'], reserved: true },
  'window.private': { label: 'Cửa sổ ẩn danh', keys: ['Ctrl+Shift+N'], reserved: true },
  'window.fullscreen': { label: 'Toàn màn hình', keys: ['F11'], reserved: true },
  'window.zen': { label: 'Chế độ tập trung (ẩn giao diện)', keys: ['Ctrl+Shift+Z'], reserved: false },
  'nav.back': { label: 'Quay lại', keys: ['Alt+Left'], reserved: false },
  'nav.forward': { label: 'Tiến tới', keys: ['Alt+Right'], reserved: false },
  'nav.reload': { label: 'Tải lại', keys: ['F5', 'Ctrl+R'], reserved: true },
  'nav.hardReload': { label: 'Tải lại (bỏ qua cache)', keys: ['Ctrl+Shift+R', 'Ctrl+F5', 'Shift+F5'], reserved: true },
  'nav.home': { label: 'Trang chủ', keys: ['Alt+Home'], reserved: false },
  'nav.stop': { label: 'Dừng tải', keys: [], reserved: false },
  'omnibox.focus': { label: 'Chọn thanh địa chỉ', keys: ['Ctrl+L', 'Alt+D', 'F6'], reserved: true },
  'page.find': { label: 'Tìm trong trang', keys: ['Ctrl+F'], reserved: false },
  'page.zoomIn': { label: 'Phóng to', keys: ['Ctrl+=', 'Ctrl+Shift+=', 'Ctrl+NumpadAdd'], reserved: false },
  'page.zoomOut': { label: 'Thu nhỏ', keys: ['Ctrl+-', 'Ctrl+NumpadSubtract'], reserved: false },
  'page.zoomReset': { label: 'Đặt lại thu phóng', keys: ['Ctrl+0', 'Ctrl+Numpad0'], reserved: false },
  'page.print': { label: 'In', keys: ['Ctrl+P'], reserved: false },
  'page.save': { label: 'Lưu trang', keys: ['Ctrl+S'], reserved: false },
  'page.pdf': { label: 'Lưu trang thành PDF', keys: [], reserved: false },
  'page.source': { label: 'Xem mã nguồn', keys: ['Ctrl+U'], reserved: false },
  'page.devtools': { label: 'Công cụ nhà phát triển', keys: ['F12', 'Ctrl+Shift+I'], reserved: true },
  'page.screenshot': { label: 'Chụp màn hình trang', keys: ['Ctrl+Shift+S'], reserved: false },
  'page.pip': { label: 'Hình trong hình (video)', keys: ['Alt+P'], reserved: false },
  'bookmark.toggle': { label: 'Thêm / sửa dấu trang', keys: ['Ctrl+D'], reserved: false },
  'bookmark.bar': { label: 'Ẩn / hiện thanh dấu trang', keys: ['Ctrl+Shift+B'], reserved: false },
  'open.history': { label: 'Lịch sử', keys: ['Ctrl+H'], reserved: false },
  'open.downloads': { label: 'Tải xuống', keys: ['Ctrl+J'], reserved: false },
  'open.bookmarks': { label: 'Trình quản lý dấu trang', keys: ['Ctrl+Shift+O'], reserved: false },
  'open.settings': { label: 'Cài đặt', keys: ['Ctrl+,'], reserved: false },
  'palette.open': { label: 'Bảng lệnh / tìm nhanh', keys: ['Ctrl+Shift+A', 'Ctrl+K'], reserved: false },
  'sidebar.toggle': { label: 'Ẩn / hiện thanh bên', keys: ['Ctrl+Shift+E'], reserved: false },
  'split.toggle': { label: 'Chia đôi màn hình', keys: ['Ctrl+Shift+X'], reserved: false },
  'theme.next': { label: 'Đổi sang theme tiếp theo', keys: ['Ctrl+Shift+Y'], reserved: false },
  'wallpaper.next': { label: 'Đổi hình nền tiếp theo', keys: ['Ctrl+Shift+W'], reserved: false },
  'wallpaper.lobby': { label: 'Chế độ Lobby (ẩn giao diện, tương tác với hình nền)', keys: ['Ctrl+Shift+L'], reserved: true },
  'ui.devtools': { label: 'DevTools của giao diện (cho CSS tùy chỉnh)', keys: [], reserved: false },
};

function getShortcuts(overrides = {}) {
  const out = {};
  for (const [id, def] of Object.entries(DEFAULT_SHORTCUTS)) {
    const keys = Array.isArray(overrides[id]) ? overrides[id] : def.keys;
    // (its name in the user's language: the table is written in Vietnamese)
    out[id] = { ...def, label: require('./i18n').t(def.label), keys, defaultKeys: def.keys };
  }
  return out;
}

const CODE_KEYS = {
  Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backquote: '`', Space: 'Space', Tab: 'Tab', Enter: 'Enter',
  Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  NumpadAdd: 'NumpadAdd', NumpadSubtract: 'NumpadSubtract', Numpad0: 'Numpad0',
};

// Turn a before-input-event `input` (or a KeyboardEvent) into "Ctrl+Shift+T" form.
function toAccelerator(e) {
  const code = e.code || '';
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (CODE_KEYS[code]) key = CODE_KEYS[code];
  if (!key) return null;
  const mods = [];
  if (e.control || e.ctrlKey) mods.push('Ctrl');
  if (e.alt || e.altKey) mods.push('Alt');
  if (e.shift || e.shiftKey) mods.push('Shift');
  if (e.meta || e.metaKey) mods.push('Meta');
  return [...mods, key].join('+');
}

module.exports = { DEFAULT_SHORTCUTS, getShortcuts, toAccelerator };
