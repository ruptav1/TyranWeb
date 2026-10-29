// Window-wide state shared by shell modules.
export const S = {
  winId: 0,
  private: false,
  settings: null,
  shortcuts: null,
  engines: null,
  bookmarks: { folders: [], items: [] },
  downloads: new Map(),
  window: { maximized: false, fullscreen: false, focused: true },
  zen: false,
  otherAudio: false, // something else makes sound (main/othersound.js)
};
