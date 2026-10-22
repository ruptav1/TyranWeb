TyranWeb 1.1.3 — trình duyệt anime (Windows 10/11, 64-bit)
==========================================================

CÁCH CHẠY
1. Giải nén toàn bộ file zip (chuột phải → Extract All / Giải nén tất cả) ra một thư mục.
   Đừng chạy thẳng bên trong file zip.
2. Mở TyranWeb.exe trong thư mục vừa giải nén.
3. Lần đầu Windows có thể hiện "Windows đã bảo vệ PC của bạn" (SmartScreen) vì app chưa
   được ký số: bấm "Thông tin thêm" (More info) → "Vẫn chạy" (Run anyway).

CẦN INTERNET CHO
- Hình nền sảnh Blue Archive (tải trực tiếp từ trình xem ba.svdex.moe của respectZ và từ
  BA-Spine-Viewer của asdfdsa12 trên GitHub)
- Sảnh thường của Blue Archive (nút 1/2 · 2/2 ở trang Tab mới hoặc thanh Lobby, như nút sảnh của
  game: chuyển giữa sảnh L2D và sảnh thường của đúng học sinh / trang phục đang chọn): học sinh
  đứng trong văn phòng Schale, nói thoại sảnh của game kèm biểu cảm, hiệu ứng, bong bóng và giọng
  nói, nhạc sảnh Step by Step. Hình học sinh từ BA-Spine-Viewer của asdfdsa12, văn phòng từ kho tài
  nguyên của ba-archive, thoại từ bảng CharacterDialogExcel của game (dữ liệu của trình xem
  respectZ), giọng và bản dịch từ SchaleDB (tiếng Việt chưa có bản dịch cộng đồng nên hiện tiếng
  Anh); hiệu ứng nhân vật và chớp mắt lấy từ trình phát cốt truyện của ba-archive (AGPL-3.0).
- Nhạc sảnh và nhạc nền: YouTube Music (link YouTube cũng dùng được), SoundCloud, Spotify;
  danh sách học sinh (SchaleDB)
- Cài tiện ích từ Chrome Web Store
- Hình nền NIKKE (152 nhân vật, 215 trang phục): mỗi nhân vật (cùng mọi trang phục của mình) phải
  tải về một lần trước khi dùng, ở Cài đặt → Hình nền → Web động → NIKKE (5-80 MB, thường khoảng
  27 MB mỗi nhân vật; mô hình từ Nikke-db, giọng
  nói từ I6RaVeN9I/nikke-wallpaper-packs, bộ chạy Spine chính thức của Esoteric Software;
  logo NIKKE phía sau lấy từ ảnh màn hình chờ của trang chính thức nikke-en.com, chuyển thành
  hình vector khi dùng lần đầu). Không có sẵn trong file zip này.
- Hình nền Azur Lane (156 tàu, 221 skin Live2D, cả các skin tương tác: chạm, kéo, giữ như
  trong game): mỗi tàu (cùng mọi skin của mình) tải về một lần ở Cài đặt → Hình nền → Web động
  → Azur Lane (4-105 MB, thường khoảng 16 MB mỗi tàu; mô hình từ MilkyLan/AzurLane-Live2d, giọng
  nói và nền từ Fernando2603/AzurLane, dữ liệu skin từ AzurLaneTools/AzurLaneData, bộ chạy Live2D
  Cubism Core chính thức + PixiJS + pixi-live2d-display; nhạc sảnh là nhạc của game, tải khi
  cần từ Fernando2603/AzurLane). Không có sẵn trong file zip này.
- Hình nền Project SEKAI (26 nhân vật, 430 trang phục Live2D): mỗi trang phục tải về khi chọn ở
  Cài đặt → Hình nền → Web động → Project SEKAI (2-7 MB mỗi bộ, lần đầu của mỗi nhân vật kèm
  thư viện cử chỉ và biểu cảm tới 3 MB; mô hình từ kho của sekai.best, trang mã nguồn mở
  sekai-viewer). Không có sẵn trong file zip này.
- Chặn quảng cáo (Cài đặt → Quyền riêng tư → Bộ lọc quảng cáo): "Thông thường" dùng danh sách
  của Ghostery; "Brave" dùng các danh sách Brave bật sẵn; "Brave đầy đủ" dùng đúng bộ máy
  adblock-rust của Brave, được tải và biên dịch trên máy khi chọn lần đầu (tải khoảng 400 MB,
  tạm chiếm tới 2 GB ổ đĩa, vài phút; xong chỉ giữ lại khoảng 25 MB). Không có sẵn trong file
  zip này.

GHI CHÚ
- Lần đầu mở, TyranWeb hỏi ngôn ngữ (Tiếng Việt, English, 日本語, 한국어, 简体中文, Español,
  Português, Français, Deutsch, Русский). Đổi lại ở Cài đặt → Chung → Ngôn ngữ (app tự khởi
  động lại).
- Thanh bên → Ứng dụng trên máy: mở các ứng dụng có chữ ký số hợp lệ trong Start menu (cả ứng
  dụng Store), ghim cái hay dùng lên thanh bên.
- Cài đặt, dấu trang, lịch sử, hình nền tự thêm... lưu ở %APPDATA%\TyranWeb (không nằm
  trong thư mục app). Xoá thư mục app không xoá các dữ liệu đó.
- Cập nhật: TyranWeb tự kiểm tra bản mới trên GitHub và báo khi có; bấm Cập nhật ở Cài đặt →
  Giới thiệu là app tự tải, tự thay file và mở lại. Dữ liệu của bạn không bị đụng tới.
- Sao lưu / khôi phục: Cài đặt → Giới thiệu → Sao lưu, ra một file .zip (cài đặt, dấu trang,
  lịch sử, ghi chú, các tab đang mở; tùy chọn kèm ảnh, video, nhạc đã thêm). Không gồm đăng
  nhập các trang web và nhân vật game đã tải.
- Mẹo: Ctrl+Shift+L để vào chế độ Lobby; ở trang tab mới, bấm nút con mắt để ẩn thanh tìm
  kiếm rồi bấm vào nền để trò chuyện với học sinh. Ctrl+Alt+N mở tab ẩn danh.

BẢN QUYỀN
- Nhân vật, giọng nói, nhạc và hình ảnh Blue Archive © NEXON Games / Yostar. TyranWeb không
  đóng gói dữ liệu game, chỉ hiển thị từ trình xem của người hâm mộ.
- Nhân vật và giọng nói GODDESS OF VICTORY: NIKKE © SHIFT UP; Azur Lane © Manjuu / Yongshi /
  Yostar; Project SEKAI COLORFUL STAGE! © SEGA / Colorful Palette / Crypton Future Media.
  TyranWeb không đóng gói chúng; chúng chỉ được tải về máy khi bạn bấm Tải về.
- Các hình nền anime đi kèm thuộc về tác giả / nhà sản xuất của chúng.
- Dự án cá nhân, phi thương mại.
- TyranWeb dùng giấy phép GNU AGPL-3.0 (LICENSE.txt), vì có dùng code của ba-archive
  (github.com/ba-archive/blue-archive, AGPL-3.0). Mã nguồn: https://github.com/ruptav1/TyranWeb Thư viện gsap (GreenSock) theo giấy phép miễn phí
  của nó; bộ chạy Spine chính thức của Esoteric Software được tải về khi cần, theo giấy phép Spine
  Runtimes.
