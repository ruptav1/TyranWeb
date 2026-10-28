'use strict';
// Default user settings. Appearance values match the "clannad" preset in src/shared/themes.js.

const SETTINGS = {
  version: 1,
  general: {
    userName: '',
    language: '', // the interface's language (src/main/i18n.js); '' until picked on the first start
    labsUnlocked: false, // NIKKE and Azur Lane wallpapers, still being tried out, opened with the password
    startup: 'restore', // restore | newtab | home
    homepage: 'tyran://newtab',
    searchEngine: 'google',
    customSearchUrl: 'https://www.google.com/search?q=%s',
    searchSuggestions: true,
    askDownloadLocation: false,
    downloadDir: '',
    newTabPosition: 'afterActive', // afterActive | end
    checkUpdates: true, // look for a newer TyranWeb on GitHub (main/updates.js)
    backupMedia: false, // backups (Settings → Giới thiệu) hold the wallpapers, videos and music added too
    tabSleepMinutes: 0, // a tab not looked at for this long sleeps (0: never); pinned, playing and shown tabs never
    smoothScrolling: true,
  },
  appearance: {
    preset: 'clannad',
    dark: false,
    accent: '#e0718f',
    bg: '#f7eeea',
    surface: '#fffaf7',
    text: '#2d2430',
    chromeStyle: 'clear', // glass | solid | clear
    clearBookmarks: true, // "clear" chrome: the bookmarks bar's chips in liquid glass too (else frosted)
    clearClock: true, // "clear" chrome: the new tab clock's glass pane in liquid glass (else frosted)
    autoColor: false, // take the interface colours from the wallpaper (into auto: { base, accent })
    auto: null,
    surfaceOpacity: 0.62,
    clearScrim: 0.3, // "clear" chrome: strength of the soft shade behind the bars
    blur: 22,
    font: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
    // the user's own fonts, { family, file, weight, italic } each (main/fonts.js)
    customFonts: [],
    fontSize: 13,
    radius: 12,
    density: 'comfortable', // compact | comfortable | spacious
    tabStyle: 'pill', // pill | flat | underline
    animations: true,
    pageScheme: 'theme', // theme | system | light | dark — what web pages see as prefers-color-scheme
    // the mouse cursor: system | sakura | night | mint | custom (the user's files, { file, name } per
    // slot); pages: on websites too, not only in TyranWeb itself
    cursor: { set: 'system', arrow: null, hand: null, text: null, pages: true },
    customCSS: '',
  },
  wallpaper: {
    type: 'image', // image | video | web | color | gradient | mica | acrylic | transparent
    image: 'tyran://assets/wallpapers/clannad-nagisa-sakura.jpg',
    video: '',
    videoRate: 1,
    motion: 'focus', // when video/web backgrounds animate: always | focus | newtab
    // volume: the lobby's overall level; musicVolume / voiceVolume: its song and its voices, on top of it
    // lobbyPick: the lobby at each start: 'fixed' (the one chosen) | 'random' | 'season' (by the season and
    // the time of day, again at their turns: services.pickLobby); favorites: lobby keys (the picker's hearts)
    // nextOnSongEnd / nextLobby: another lobby when the song ends, among a school's, a student's, an
    // outfit's ('_default': her usual one; '' any), in the list's order or shuffled ('list' | 'shuffle'),
    // and once all of them have played, from the first again (repeat) or the last one stays
    // baMode: the lobby of the student (or outfit) of model shown as her memorial lobby ('memorial') or
    // her normal one in Schale's office ('normal'; the lobby button switches); senseiBirthday: 'M/D'
    web: { preset: 'bluearchive', baMode: 'memorial', senseiBirthday: '', url: '', package: '', model: 'shiroko_home', audio: false, volume: 0.6, musicVolume: 1, voiceVolume: 1, touchZones: false, randomLobby: false, lobbyPick: 'fixed', pickFavorites: false, autoPeriod: '', favorites: [], nextOnSongEnd: false, nextLobby: { school: '', student: '', outfit: '', favorites: false, order: 'list', repeat: true }, nikke: 'c010', nikkeOutfit: '', azur: '', azurSkin: '', azurMusic: 'game', azurChatter: false, sekai: '', sekaiOutfit: '', nikkeStance: 'lobby', nikkeTint: 'auto', nikkeColor: '#141b29', nikkeImage: '' },
    color: '#f7eeea',
    gradientFrom: '#ffd6e0',
    gradientTo: '#c9e4ff',
    gradientAngle: 135,
    dim: 0.1,
    blur: 0,
    saturate: 1,
    position: 'center',
    frames: {}, // url -> { z, x, y }: a picture / video framed by hand (Cắt / phóng to)
    // a wallpaper's own music (key -> { kind: 'files', files, shuffle } | { kind: youtube | soundcloud | spotify, url, ... }),
    // whether it plays, and its volume (a Blue Archive lobby uses the lobby's volumes instead)
    music: {},
    musicOn: true,
    musicVolume: 0.6,
    slideshowMinutes: 0,
    slideshow: [],
  },
  layout: {
    tabsPosition: 'top', // top | left | right
    toolbarPosition: 'top', // top | bottom
    verticalTabsWidth: 248,
    verticalTabsCollapsed: false,
    showBookmarksBar: true,
    contentInset: 8,
    contentRadius: 12,
    contentShadow: true,
    sidebarPosition: 'left', // left | right
    sidebarWidth: 340,
    sidebarOpen: false,
    sidebarPanel: 'bookmarks',
    showStatusBubble: true,
    tabCloseButton: 'hover', // hover | always
    toolbarItems: ['back', 'forward', 'reload', 'home', 'omnibox', 'adblock', 'downloads', 'split', 'screenshot', 'sidebar', 'palette', 'menu'],
    hiddenToolbarItems: ['home', 'screenshot', 'palette'],
  },
  newtab: {
    showClock: true,
    clock24h: true,
    showSeconds: false,
    showGreeting: true,
    showSearch: true,
    showSpeedDial: true,
    showAnime: false,
    showCredit: false, // wallpaper name in the corner
    hideTools: false, // search bar + shortcuts faded out; the clock moves to the top-left corner
    visualizer: false, // the music's spectrum along the foot of the wallpaper (its own music only)
    heroGlass: true, // the glass pane behind the clock in that corner (clicking the clock toggles it)
    heroGlassMid: false, // ...and behind it in the middle too, with the search bar and shortcuts shown
    positions: { shown: null, hidden: null }, // dragged places ("Sắp xếp"): { hero|search|dial: { x, y } } as fractions
    animeGenre: 'Slice of Life', // Slice of Life | all
    speedDialColumns: 6,
    speedDial: [
      { title: 'YouTube', url: 'https://www.youtube.com/' },
      { title: 'MyAnimeList', url: 'https://myanimelist.net/' },
      { title: 'AniList', url: 'https://anilist.co/' },
      { title: 'Facebook', url: 'https://www.facebook.com/' },
      { title: 'GitHub', url: 'https://github.com/' },
      { title: 'Wikipedia', url: 'https://vi.wikipedia.org/' },
      { title: 'Reddit', url: 'https://www.reddit.com/' },
      { title: 'Gmail', url: 'https://mail.google.com/' },
    ],
  },
  privacy: {
    adblock: true,
    adblockEngine: 'ghostery', // 'ghostery' | 'brave' (Brave's lists) | 'brave-full' (Brave's engine, built here: main/brave-build.js)
    doNotTrack: true,
    blockThirdPartyCookies: false, // (main/privacy.js)
    httpsOnly: false,
    clearOnExit: false,
  },
  shortcuts: {},
  sitePermissions: {},
  zoom: {},
  webPanels: [
    { id: 'wp-mal', title: 'MyAnimeList', url: 'https://myanimelist.net/' },
    { id: 'wp-translate', title: 'Google Dịch', url: 'https://translate.google.com/' },
  ],
  pinnedApps: [], // the computer's apps kept on the sidebar's rail: [{ id, name }] (main/apps.js)
};

const BOOKMARKS = {
  folders: [
    { id: 'bar', name: 'Thanh dấu trang', system: true },
    { id: 'other', name: 'Dấu trang khác', system: true },
  ],
  items: [
    { id: 'b-anilist', url: 'https://anilist.co/', title: 'AniList', folder: 'bar', created: 0 },
    { id: 'b-mal', url: 'https://myanimelist.net/', title: 'MyAnimeList', folder: 'bar', created: 0 },
    { id: 'b-wallhaven', url: 'https://wallhaven.cc/', title: 'Wallhaven', folder: 'bar', created: 0 },
  ],
};

const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s', suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s', suggest: 'https://api.bing.com/osjson.aspx?query=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?type=list&q=%s' },
  brave: { name: 'Brave', url: 'https://search.brave.com/search?q=%s', suggest: null },
  coccoc: { name: 'Cốc Cốc', url: 'https://coccoc.com/search?query=%s', suggest: null },
  custom: { name: 'Tùy chỉnh', url: null, suggest: null },
};

module.exports = { SETTINGS, BOOKMARKS, SEARCH_ENGINES };
