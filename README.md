# TyranWeb ✿

**An anime web browser for Windows, themed after the anime of 2000–2010, with a clean interface you can customize almost completely.**

TyranWeb is built on Electron (Chromium), so websites look and work the same as in Chrome or Edge. Around the pages you get anime themes, 4K wallpapers, video wallpapers and live game lobbies (Blue Archive, NIKKE, Azur Lane, Project SEKAI) with their music and voices.

### ⬇ [Download TyranWeb 1.1.0 for Windows (64-bit)](https://github.com/ruptav1/TyranWeb/releases/download/v1.1.0/TyranWeb-1.1.0-win-x64.zip)

[Release page and notes for 1.1.0](https://github.com/ruptav1/TyranWeb/releases/tag/v1.1.0) · [All releases](https://github.com/ruptav1/TyranWeb/releases)

---

## Contents

- [Install and run](#install-and-run)
- [What's new in 1.1.0](#whats-new-in-110)
- [Browsing](#browsing)
- [Ad blocking and privacy](#ad-blocking-and-privacy)
- [Handy extras](#handy-extras)
- [Customization](#customization)
- [Wallpapers and live lobbies](#wallpapers-and-live-lobbies)
- [Updates, backup and your data](#updates-backup-and-your-data)
- [Images: no AI, no upscaling](#images-no-ai-no-upscaling)
- [Security](#security)
- [Credits](#credits)
- [Copyright](#copyright)

## Install and run

**Requirements:** Windows 10 or 11, 64-bit. An internet connection for live wallpapers, music, extensions and updates.

1. Download [`TyranWeb-1.1.0-win-x64.zip`](https://github.com/ruptav1/TyranWeb/releases/download/v1.1.0/TyranWeb-1.1.0-win-x64.zip) (about 179 MB).
2. Extract the whole zip into a folder (right-click → **Extract All**). Don't run it from inside the zip.
3. Open `TyranWeb.exe` in that folder.
4. The app is not code-signed, so Windows SmartScreen may say *"Windows protected your PC"* the first time. Click **More info** → **Run anyway**.

On first launch TyranWeb asks for your language: Tiếng Việt, English, 日本語, 한국어, 简体中文, Español, Português, Français, Deutsch or Русский. You can change it later in **Settings → General → Language**.

To check the download, compare its SHA-256 with [`TyranWeb-1.1.0-win-x64.zip.sha256`](https://github.com/ruptav1/TyranWeb/releases/download/v1.1.0/TyranWeb-1.1.0-win-x64.zip.sha256):

```powershell
Get-FileHash .\TyranWeb-1.1.0-win-x64.zip -Algorithm SHA256
```

## What's new in 1.1.0

- Favourite Blue Archive lobbies, and lobbies picked by season and time of day
- When the lobby song ends, switch lobby by school / student / outfit, in order or shuffled, with repeat
- Blue Archive lobby camera now matches the game, with softer lighting and the game's opening scenes
- Block third-party cookies, HTTPS only mode
- Back up and restore your data
- Checks for updates and installs them
- Brave ad blocking (Brave's lists, or Brave's full adblock-rust engine)

## Browsing

- **Tabs:** drag to reorder, pin, mute, duplicate, reopen closed tabs, restore your last session, incognito tabs and windows. Tabs you haven't used for a while can sleep to save memory (off by default; pinned tabs never sleep).
- **Smart address bar:** suggestions from open tabs, bookmarks, history and your search engine, with domain autocomplete. Google, Bing, DuckDuckGo, Brave Search, Cốc Cốc or any custom search URL.
- **Bookmarks:** bookmarks bar, folders, a bookmark manager, and HTML import/export (reads exports from Chrome, Edge and Firefox).
- **History** with search, and clearing by time range.
- **Downloads** with pause, resume, cancel and progress.
- **Pages:** find in page, zoom remembered per site, print, save page, save as PDF, view source, DevTools, full screen.
- **Extensions** from the Chrome Web Store.
- **Permissions** (camera, microphone, notifications…) are asked for and remembered per site.
- **Spell check** in English and Vietnamese.

## Ad blocking and privacy

Pick the ad-block engine in **Settings → Privacy → Ad filter**:

| Mode | What it uses |
|---|---|
| **Standard** | Ghostery's ad blocker and filter lists |
| **Brave** | The filter lists Brave turns on by default |
| **Full Brave** | Brave's own adblock-rust engine, downloaded and compiled on your PC the first time you choose it (about 400 MB download, up to 2 GB of temporary disk space, a few minutes; only about 25 MB is kept afterwards) |

Every page shows how many ads and trackers were blocked.

Privacy switches:

- **Block third-party cookies.** Sites of the same company (for example Google's, Microsoft's or Meta's own domains) still count as one site, so their sign-ins keep working.
- **HTTPS only.** Pages are upgraded to HTTPS; if a site has no HTTPS, the error page offers to open it over HTTP.
- **Do Not Track / Global Privacy Control** signals.
- **Clear data on exit.**

## Handy extras

| Feature | How |
|---|---|
| Command palette: find commands, tabs, themes, bookmarks, history (typing without diacritics works too) | `Ctrl+K` or `Ctrl+Shift+A` |
| Split view: two tabs side by side, drag to resize | `Ctrl+Shift+X`, or right-click a tab |
| Sidebar: bookmarks, history, downloads, quick notes, web panels (small pinned websites such as MyAnimeList) and desktop apps from your Start menu | `Ctrl+Shift+E` |
| Page screenshot (saved to `Pictures\TyranWeb` and copied to the clipboard) | `Ctrl+Shift+S` |
| Picture-in-picture for videos | `Alt+P` |
| Focus mode: hides the whole interface; move the mouse to the top edge to bring it back | `Ctrl+Shift+Z` |
| **Lobby mode:** hides the browser so you can enjoy the wallpaper or play with a live lobby | `Ctrl+Shift+L`, leave with `Esc` |
| Next theme / next wallpaper | `Ctrl+Shift+Y` / `Ctrl+Shift+W` |
| Right-click an image on a website → **Set as TyranWeb wallpaper** | |
| New tab page: clock, greeting, search box, drag-and-drop shortcuts and **Anime of the day** (one 2000–2010 anime every day, from AniList) | `Ctrl+T` |

Every keyboard shortcut can be changed in Settings.

## Customization

Open **Settings** with `Ctrl+,`. Every change applies immediately.

- **14 anime themes**, each with its own colors and wallpaper:

  | Theme | Anime |
  |---|---|
  | Dango Daikazoku | CLANNAD (2007) |
  | SOS Brigade | Suzumiya Haruhi (2006) |
  | Bungei-bu | Suzumiya Haruhi (2006) |
  | Hōkago Tea Time | K-ON! (2009) |
  | Lucky☆Star XP | Lucky☆Star (2007) |
  | Taiyaki Morning | Kanon (2006) |
  | Natsu no Sora | AIR (2005) |
  | Palmtop Tiger | Toradora! (2008) |
  | Wise Wolf | Spice and Wolf (2008) |
  | Tenshi | Angel Beats! (2010) |
  | Yuujinchou | Natsume Yuujinchou (2008) |
  | Fumoffu! | Full Metal Panic? Fumoffu (2003) |
  | Senjougahara | Bakemonogatari (2009) |
  | Flame Haze | Shakugan no Shana (2005) |

- **Colors:** light or dark mode, accent, background, surface and text colors.
- **Material:** frosted glass, solid or transparent; opacity, blur, corner radius, density, tab style, font and font size.
- **Layout:** tabs on top or vertical on the left or right (collapsible); toolbar at the top or bottom; sidebar on the left or right; a gap around the page that shows the wallpaper, with rounded corners and a shadow; drag and drop to reorder or hide each toolbar button.
- **Mouse cursors:** Sakura, Night and Mint sets, or your own cursor files.
- **Custom CSS** to restyle anything in the interface.
- **Export and import themes** as `.json` files to share them.

## Wallpapers and live lobbies

**Pictures and video**

- **25 original 4K anime wallpapers** included, your own pictures, or search the **Wallhaven** library from inside the app (4K and above by default, with resolution and sort filters).
- **Video wallpapers** (`.mp4` / `.webm`, up to 4K 60 fps) from your PC or a link, always muted, with playback speed. Wallpaper Engine *Video* wallpapers work too.
- Solid colors, gradients, and Windows 11 Mica / Acrylic.
- Dim, blur, saturation and slideshow controls. Video and live wallpapers pause when you aren't using TyranWeb, or can run on the new tab page only.

**Live game lobbies** (downloaded or streamed when you choose them; not included in the zip)

- **Blue Archive Memorial Lobbies:** 283 lobbies with their lobby music and voices. Pat a student's head, pinch their cheeks (for students who have it), have them follow your mouse, or tap to talk; touch areas come from each student's own rig, as in the game, and the camera and opening scenes match the game. Mark favourites, let TyranWeb pick a lobby by season (Christmas, New Year, summer…) and time of day, and switch lobby when the song ends, limited to a school, a student or an outfit theme, in order or shuffled, with repeat.
- **NIKKE:** 152 characters and 215 outfits, lobby and battle poses, with voices. Each character (with all their outfits) is downloaded once, usually about 27 MB (5–80 MB).
- **Azur Lane:** 156 ships and 221 Live2D skins, including the interactive skins you tap, drag or hold as in the game, with the game's lobby music. Each ship is downloaded once, usually about 16 MB (4–105 MB).
- **Project SEKAI:** 26 characters and 430 Live2D outfits, each outfit downloaded when you pick it (2–7 MB).
- **Any web page** as a wallpaper, or a folder of web wallpapers (from Wallpaper Engine, Lively, or your own).

**Music:** lobby and background music from YouTube Music (YouTube links work too), SoundCloud or Spotify.

## Updates, backup and your data

- **Updates:** TyranWeb checks this repository's releases at start and twice a day, and tells you when a newer version is out. Click **Update** in **Settings → About**: it downloads the new version, checks its SHA-256, replaces the app files and restarts. Nothing is installed without your click, and the automatic check can be turned off (**Check for new versions**).
- **Backup / restore:** **Settings → About → Backup** makes one `.zip` with your settings, bookmarks, history, notes and open tabs, and optionally the pictures, videos and music you added. Restore it from the same place. Website sign-ins and downloaded game characters are not included.
- **Your data** (settings, bookmarks, history, your wallpapers…) is kept in `%APPDATA%\TyranWeb`, not in the app folder, so deleting or updating the app folder doesn't touch it.

## Images: no AI, no upscaling

- The 25 included wallpapers come from [Wallhaven](https://wallhaven.cc) (category *anime*, *SFW*). Every one has a **native resolution of 3840 px or more**: artbook scans (4000–6400 px) or vector art. They are stored 3840 px wide as quality-90 JPEG.
- Only images **uploaded before 1 August 2022**, before Stable Diffusion was released, were chosen. Each image's tags were checked to match its anime and to exclude anything tagged *waifu2x*, *upscaled* or *AI*. Images that looked upscaled (detail measured, then checked at 100%) and edits combining several images were removed.
- The Wallhaven library in the app shows only images from before August 2022 by default, uses Wallhaven's AI-art filter, and refuses to download images tagged as upscaled or AI.
- Covers in *Anime of the day* are official images from AniList.
- The source of each wallpaper is listed in **Settings → About**.

## Security

- Every tab is a `<webview>` running with `sandbox` and `contextIsolation`, without Node.js.
- Websites cannot open or navigate to TyranWeb's internal `tyran://` pages.
- Sensitive internal commands are accepted only from the browser's own interface.
- Live web wallpapers run in a separate session with no preload script. They are denied every permission (camera, location, notifications…) and cannot download files or open windows. Each wallpaper package has its own origin, so they cannot read each other's data.

## Credits

TyranWeb is built on the work of these projects and communities:

- **Browser:** [Electron](https://www.electronjs.org) (Chromium)
- **Ad blocking:** [Ghostery adblocker](https://github.com/ghostery/adblocker); Brave's [adblock-rust](https://github.com/brave/adblock-rust), [filter list catalog](https://github.com/brave/adblock-resources) and resources; [uBlock Origin](https://github.com/gorhill/uBlock)'s redirect and scriptlet resources
- **Blue Archive:** the fan viewer [ba.svdex.moe](https://ba.svdex.moe) by respectZ ([respectZ/blue-archive-viewer](https://github.com/respectZ/blue-archive-viewer)), [asdfdsa12/BA-Spine-Viewer](https://github.com/asdfdsa12/BA-Spine-Viewer), and [SchaleDB](https://schaledb.com) for the student list
- **NIKKE:** models from [Nikke-db](https://github.com/Nikke-db/Nikke-db.github.io), voices from [I6RaVeN9I/nikke-wallpaper-packs](https://github.com/I6RaVeN9I/nikke-wallpaper-packs), and Esoteric Software's official [Spine](https://esotericsoftware.com) runtime
- **Azur Lane:** models from [MilkyLan/AzurLane-Live2d](https://github.com/MilkyLan/AzurLane-Live2d), voices, backgrounds and music from [Fernando2603/AzurLane](https://github.com/Fernando2603/AzurLane), skin data from [AzurLaneTools/AzurLaneData](https://github.com/AzurLaneTools/AzurLaneData); the official Live2D Cubism Core, [PixiJS](https://pixijs.com) and [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)
- **Project SEKAI:** models from the [sekai.best](https://sekai.best) archive ([sekai-viewer](https://github.com/Sekai-World/sekai-viewer))
- **Pictures and anime info:** [Wallhaven](https://wallhaven.cc) and [AniList](https://anilist.co)

## Copyright

- Blue Archive characters, voices, music and images © NEXON Games / Yostar. GODDESS OF VICTORY: NIKKE © SHIFT UP. Azur Lane © Manjuu / Yongshi / Yostar. Project SEKAI COLORFUL STAGE! © SEGA / Colorful Palette / Crypton Future Media.
- TyranWeb does not bundle any game data. Blue Archive lobbies are shown from fan-made viewers; NIKKE, Azur Lane and Project SEKAI models are downloaded to your PC only when you click **Download**.
- The included anime wallpapers belong to their artists and studios, and are for personal use.
- TyranWeb is a personal, non-commercial fan project, not affiliated with or endorsed by any of the companies above.
