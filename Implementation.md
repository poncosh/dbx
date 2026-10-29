# Implementation Plan: ERD Focused Table UX Improvements

## 1. Latar Belakang

Rencana ini melanjutkan perubahan pada branch `fix/generating-edr-focusing-on-selected-table`, khususnya commit:

- `309e6ead5` — `fix(improvement): improvement on selected table for generating EDR`
- `53822c991` — `fix(improvement): improvement on selected table for generating EDR`

Perubahan tersebut sudah berada di `main` dalam bentuk squash commit `b9e2eb89a` (`perf(diagram): load only FK closure for focused table diagrams`). Implementasi berikutnya harus dibuat di atas kondisi `main` saat ini, bukan dengan mengulang atau cherry-pick dua commit lama.

Scope improvement:

1. Diagram otomatis menjalankan auto-layout ketika pertama kali ditampilkan.
2. Tabel yang menjadi focused root memiliki warna khusus `#9F2B68`.
3. Canvas mendukung pan dengan dua jari, pinch dua jari untuk zoom, dan `Ctrl + scroll` untuk zoom.
4. Generate ERD baru tidak langsung menggunakan hasil layout ERD sebelumnya: posisi tersimpan tidak boleh melewati auto-layout awal. Pada mode focused, penyusunan ulang hanya memproses focused closure yang sudah selesai dimuat.

Dokumen ini mencatat kasus bug, kontrak perilaku, implementasi, dan verifikasinya. Hasil verifikasi dicatat di bagian 10.

## 2. Temuan Kondisi Saat Ini

### 2.1 Inisialisasi layout

`SchemaDiagramDialog.vue` menggunakan `restoreOrInitializeLayout()` setelah metadata selesai dimuat. Fungsi tersebut lebih dahulu memakai posisi persisted yang bersifat schema-wide. Akibatnya, focused diagram dapat dianggap sudah memiliki layout hanya karena sebagian tabel pernah memiliki posisi di mode all tables, sehingga layout awal focused tidak selalu tersusun otomatis.

Selain itu, layout awal yang digunakan ketika posisi tidak tersedia adalah `computeLtrAutoLayout()`, sedangkan tombol **Auto Layout** menggunakan `applyAutoLayout()` dan `computeLayoutWithLayers()`. Dua jalur ini dapat menghasilkan perilaku yang berbeda.

### 2.2 Identitas focused table

`focusedRoots` sudah menyimpan nama dan schema root, tetapi informasi tersebut belum diteruskan ke node data yang dirender oleh `TableNode.vue`. `TableNode` saat ini hanya mengetahui table, relationship, multi-schema state, dan selection state.

### 2.3 Gesture canvas

`VueFlow` masih menggunakan konfigurasi gesture default. Default tersebut mengutamakan wheel untuk zoom, sementara kebutuhan baru adalah:

- two-finger scroll/drag pada trackpad untuk pan;
- pinch/spread dua jari untuk zoom;
- `Ctrl + wheel` untuk zoom;
- tombol zoom yang ada tetap bekerja.

Vue Flow `1.48.2` sudah menyediakan `panOnScroll`, `zoomOnPinch`, `zoomActivationKeyCode`, dan viewport API. Namun perilaku wheel dengan `ctrlKey` perlu dibuat eksplisit agar konsisten di Windows, macOS, browser, dan Tauri WebView.

### 2.4 Bug 4: layout awal mewarisi ERD sebelumnya

Kasus yang dikonfirmasi pengguna adalah **generate ERD baru memakai posisi dari ERD yang sebelumnya pernah dibuat**. Contoh: buka All tables, tutup diagram, kemudian generate focused ERD `A -> B -> C` pada connection, database, dan scope schema yang sama. Walaupun focused ERD itu baru pertama dibuka, tabel dapat tampil pada posisi lama dari diagram All tables.

Penyebab utamanya adalah penyimpanan posisi menggunakan key connection + database + scope schema, tanpa identitas focused roots. `hasUsablePersistedPositions()` cukup menemukan satu tabel yang cocok untuk membuat `restoreOrInitializeLayout()` melewati auto-layout. Tabel yang belum memiliki posisi hanya diberi posisi fallback. Ini juga bisa terjadi setelah membuka focused ERD lain yang memiliki tabel beririsan.

Jika tidak ada posisi tersimpan yang cocok, jalur lama menjalankan layout awal. Jadi masalah ini bukan setiap pembukaan selalu mengambil ERD terakhir, melainkan penggunaan kembali posisi yang cocok dalam scope penyimpanan yang sama.

Ada risiko terkait ketika berpindah scope dalam dialog yang masih terbuka:

`applyAutoLayout()` mengambil input dari `canvasVisibleTables` dan `canvasVisibleRelationships`. Keduanya diturunkan langsung dari `tables.value`, bukan dari scope layout eksplisit.

Pada perpindahan all tables ke focused, terutama saat focused cache tersedia, `loadingDiagram` dapat tetap `false` sebelum focused result selesai di-commit. Dalam window transisi tersebut tombol Auto Layout masih bisa menggunakan graph all tables. Ketergantungan pada `showAllTables` saja juga tidak cukup karena nilai itu merepresentasikan UI intent, bukan jaminan bahwa state graph focused sudah selesai diterapkan.

## 3. Kontrak Perilaku yang Diinginkan

### 3.1 Auto-layout awal

- Setelah metadata untuk suatu scope berhasil di-commit dan node siap dirender, jalankan pipeline yang sama dengan tombol **Auto Layout** satu kali sebelum `fitView()`.
- Berlaku untuk initial open focused maupun all tables.
- Berlaku juga ketika membuka ulang dari metadata cache, ketika hanya sebagian posisi cocok, dan ketika sebelumnya pernah membuka focused ERD lain dengan dependency yang sama.
- Refresh pada scope yang sudah terbuka mempertahankan posisi manual; tabel baru diberi posisi yang belum terpakai. Refresh bukan pembukaan scope baru.
- Jangan menjalankan auto-layout ulang karena search, panel toggle, resize, atau reactive render biasa.
- Perpindahan scope all/focused diperlakukan sebagai graph baru: scope tujuan disusun setelah data scope tersebut selesai di-commit.
- Auto-layout awal tidak membuat undo history entry.
- Auto-layout manual tetap membuat satu undo history entry.
- Jika request menjadi stale, dialog ditutup, atau scope berubah saat layout dihitung, hasil layout lama tidak boleh diterapkan.

Catatan posisi persisted: posisi boleh dipakai sebagai input awal/constraint untuk layer yang memang `free`, tetapi tidak boleh menyebabkan auto-layout awal focused dilewati hanya karena terdapat posisi schema-wide dari mode all tables.

### 3.2 Warna focused table

- Setiap root dari `focusTableName` atau `focusTableNames` ditandai sebagai focused root.
- Focused root menggunakan `#9F2B68` sebagai warna utama yang persisten selama node tampil.
- Warna focused bukan selection state. Klik node lain tidak menghilangkan warna focused root.
- Selection tetap terlihat sebagai ring/outline tambahan dan tidak menimpa identitas focused.
- Matching harus schema-aware agar tabel bernama sama di schema berbeda tidak ikut diberi warna.
- Jika terdapat beberapa focused roots, semuanya menggunakan treatment yang sama.
- Tampilan engineering diagram menggunakan predicate focused yang sama agar kedua mode konsisten.
- Baris kolom yang menjadi endpoint relasi diberi latar rose lembut: FK sumber dan kolom tujuan (termasuk PK) memakai treatment yang sama. Kolom lain serta tabel bernama sama di schema lain tidak ikut diwarnai.

Treatment visual yang disarankan:

- header node menggunakan background `#9F2B68` dan foreground putih;
- outer border/ring menggunakan `#9F2B68` dengan opacity yang cukup;
- layer color stripe tetap dipertahankan karena mewakili informasi berbeda;
- badge dan icon pada header harus tetap memiliki kontras yang terbaca di light/dark theme.

### 3.3 Gesture zoom dan pan

- Scroll dua jari tanpa modifier menggeser canvas secara horizontal/vertikal.
- Pinch/spread dua jari memperkecil/memperbesar canvas.
- `Ctrl + wheel up/down` memperbesar/memperkecil canvas.
- Zoom berpusat pada posisi pointer, bukan selalu di tengah canvas.
- Range zoom tombol, pinch, dan wheel menggunakan batas yang sama dengan Vue Flow: minimum `0.05`, maksimum `2`.
- Wheel/gesture yang ditangani canvas tidak ikut men-scroll dialog atau halaman di belakangnya.
- Delta pinch kecil harus terakumulasi tanpa pembulatan zoom per event. Tangani juga event native `gesturestart/change/end`, bukan hanya Ctrl-wheel, dan cegah satu pinch diproses dua kali.
- Mouse drag/space-pan, MiniMap, tombol zoom, dan `fitView()` yang sudah ada tetap berfungsi.
- Engineering diagram tidak ikut diubah pada tahap ini karena renderer-nya bukan Vue Flow dan toolbar zoom memang dinonaktifkan untuk mode tersebut.

### 3.4 Isolasi scope layout

- Sumber kebenaran layout adalah `loadedDiagramScope`, bukan `showAllTables`.
- Auto-layout hanya boleh berjalan jika scope request sudah selesai di-commit.
- Untuk scope `focused`, input layout harus merupakan focused closure aktif saja.
- Untuk scope `full`, input layout adalah seluruh tabel aktif yang lolos filter canvas/layer.
- Relationship yang dikirim ke layout wajib memiliki kedua endpoint di dalam set tabel scope tersebut.
- Scope transition harus mengunci Auto Layout sampai graph tujuan siap.
- Hasil layout dari generation lama tidak boleh menimpa generation baru.

## 4. Rancangan Implementasi

### 4.1 Buat graph layout berdasarkan scope eksplisit

Di `SchemaDiagramDialog.vue`:

1. Tambahkan state transisi yang membedakan:
   - scope yang sedang diminta;
   - scope yang sudah di-commit (`loadedDiagramScope`);
   - status metadata/layout initialization yang sedang berjalan.
2. Simpan set identity hasil focused closure ketika focused result di-commit. Identity menggunakan `diagramIdentityKey()`. Draft yang baru dibuat dalam sesi dapat ditambahkan ke set ini; draft tersimpan yang tidak terkait tidak ikut auto-layout.
3. Buat helper murni, misalnya `buildLayoutGraph(scope)`, yang menghasilkan:
   - tabel eligible untuk scope;
   - relationship dengan kedua endpoint eligible;
   - visible layer yang seluruh/eligible member-nya aman diproses.
4. `applyAutoLayout()` mengambil snapshot eksplisit dari `loadedDiagramScope` dan `buildLayoutGraph()` sebelum proses async dimulai, sehingga tidak membaca graph all-table yang berubah di tengah perhitungan.
5. Ambil snapshot generation sebelum `nextTick()`/ELK calculation dan validasi kembali sebelum menulis `positions`, layer bounds, waypoint, node, serta persistence.
6. Disable tombol Auto Layout selama scope transition, metadata load, atau initial auto-layout.

Dengan desain ini, sekalipun `tables.value` masih menyimpan full graph sesaat selama perpindahan, focused auto-layout tidak dapat menerima tabel di luar focused identity set.

### 4.2 Satukan initial layout dengan tombol Auto Layout

Refactor `restoreOrInitializeLayout()` menjadi orchestration yang jelas:

1. Muat posisi persisted yang relevan sebagai starting state.
2. Commit node/layer sementara agar ukuran node tersedia.
3. Jalankan `applyAutoLayout({ skipHistory: true, initial: true })` tepat satu kali untuk generation tersebut; scope diambil dari graph yang sudah di-commit.
4. Persist hasil melalui jalur focused/full yang sudah aman terhadap subset replacement.
5. Jalankan `fitView()` setelah node hasil layout selesai disinkronkan.

`computeLtrAutoLayout()` dapat tetap dipakai sebagai fallback bila ELK gagal atau memang dibutuhkan oleh flow lain, tetapi tidak lagi menjadi hasil default yang berbeda dari tombol Auto Layout. Failure auto-layout tidak boleh menghapus graph yang sudah berhasil dimuat; tampilkan graph dengan posisi fallback dan tetap izinkan pengguna menekan Auto Layout lagi.

Isolasi menggunakan snapshot graph per perhitungan dan generation guard. Setiap scope yang baru dibuka dihitung ulang sehingga tidak memerlukan cache layout per scope. Posisi persisted hanya menjadi starting state; layer `free` tetap mempertahankan posisi manual. Format persisted storage dan metadata cache tidak diubah.

### 4.3 Propagasikan focused identity ke node

Di `vue-flow-adapter.ts`:

1. Perluas table node data dengan `isFocused?: boolean`.
2. Tambahkan optional focused identity set/predicate ke `toVueFlowNodes()`.
3. Tentukan status focused memakai node ID schema-qualified; fallback nama polos hanya diperbolehkan bila tidak ambigu.

Di `TableNode.vue`:

1. Gunakan `data.isFocused` untuk style focused.
2. Pisahkan class/style focused dan selected agar keduanya dapat tampil bersamaan.
3. Gunakan constant warna tunggal untuk `#9F2B68`, tidak menduplikasi literal di beberapa expression.
4. Pertahankan layer stripe dan draft badge.

Di engineering renderer:

- ganti perbandingan nama tunggal dengan helper schema-aware/multi-root yang sama;
- gunakan `#9F2B68` pada focused entity.

### 4.4 Konfigurasi gesture Vue Flow

Pada `<VueFlow>`:

- set `pan-on-scroll` secara eksplisit;
- set `pan-on-scroll-mode` ke free/two-axis;
- set `zoom-on-pinch` secara eksplisit;
- nonaktifkan plain wheel zoom agar two-finger scroll menjadi pan;
- pertahankan `pan-on-drag` dan space-pan yang sekarang;
- gunakan activation key `Control` untuk keyboard wheel zoom.

Tambahkan handler wheel capture untuk event `ctrlKey` sebagai normalisasi lintas platform. Handler tersebut:

1. hanya aktif di table diagram dan di dalam pane;
2. memanggil `preventDefault()` dan menghentikan handler wheel lain agar satu event tidak di-apply dua kali;
3. menghitung zoom baru dari `deltaY` melalui `diagramZoom.ts`;
4. menghitung viewport `x/y` baru agar titik dunia di bawah pointer tetap berada di bawah pointer;
5. memanggil `setViewport()` dengan range zoom yang sama dengan Vue Flow.

Pinch Chromium/Tauri yang dikirim sebagai synthetic `ctrlKey + wheel` akan melewati jalur yang sama. Native pinch yang sudah dikenali Vue Flow tetap menggunakan `zoomOnPinch`; pengujian manual memastikan tidak terjadi double zoom.

Follow-up WebView desktop Windows: handler frontend saja belum menyelesaikan kegagalan pada perangkat pengguna. Wry bawaan mengaitkan `IsPinchZoomEnabled` dengan `zoom_hotkeys_enabled` yang default-nya false. Patch di `vendor/wry/src/webview2/mod.rs` memisahkan keduanya: ketika JavaScript aktif, pinch native diaktifkan sebelum navigation pertama. Script document-created membatalkan default Ctrl-wheel/multi-touch tanpa menghentikan propagasi event, sehingga canvas dapat mengelola zoom sendiri dan skala halaman aplikasi tetap terkunci. Browser keyboard zoom tetap mengikuti setting lama; view tanpa JavaScript mempertahankan setting native lama.

Patch host ini memerlukan rebuild dan restart Tauri; hot reload frontend tidak cukup. Build native dan uji pinch fisik untuk follow-up ini belum dijalankan, sesuai permintaan pengguna untuk melakukan pengujian sendiri.

Di `diagramZoom.ts`:

- samakan min/max dengan `0.05` dan `2`;
- pertahankan fungsi clamp dan kurva zoom;
- tambahkan helper murni untuk cursor-anchored viewport calculation;
- normalisasi `deltaMode` bila mouse menghasilkan line/page delta;
- abaikan delta nol/non-finite.

## 5. File yang Diperkirakan Berubah

### Utama

- `apps/desktop/src/components/diagram/SchemaDiagramDialog.vue`
  - scope transition state;
  - scoped layout graph;
  - initial auto-layout;
  - focused identity propagation;
  - gesture props dan `Ctrl+wheel` handler;
  - engineering focused styling.
- `apps/desktop/src/components/diagram/TableNode.vue`
  - focused visual state `#9F2B68`.
- `apps/desktop/src/lib/diagram/vue-flow-adapter.ts`
  - `isFocused` pada node data dan schema-aware matching.
- `apps/desktop/src/lib/diagram/diagramZoom.ts`
  - shared zoom bounds dan cursor-anchored viewport helper.
- `apps/desktop/src/lib/diagram/diagram-gestures.ts`
  - handler Ctrl-wheel dan gesture native, tanpa pembulatan delta kecil atau pemrosesan ganda.
- `apps/desktop/src/lib/diagram/layout-scope.ts`
  - pemilihan tabel, edge dengan kedua endpoint eligible, dan layer yang aman disusun.
- `apps/desktop/src/lib/diagram/focused-table.ts`
  - predicate identity focused dan warna bersama.
- `apps/desktop/src/components/diagram/DiagramToolbar.vue`
  - disable Auto Layout selama load/scope transition.

### Test

- `apps/desktop/src/components/diagram/__tests__/SchemaDiagramLoading.spec.ts`
- `apps/desktop/src/components/diagram/__tests__/DiagramToolbar.spec.ts`
- `apps/desktop/src/components/diagram/__tests__/TableNodeFocused.spec.ts` untuk rendered header, selection, layer stripe, dan identity focused.
- test baru `apps/desktop/src/lib/diagram/__tests__/diagramZoom.spec.ts`.
- `packages/app-tests/diagramVueFlowAdapter.test.ts`.

Follow-up native juga mengubah `vendor/wry/src/webview2/mod.rs` dan mendokumentasikannya di `vendor/wry/DBX-PATCH.md`. Tidak ada perubahan API database, metadata loader, atau cache TTL.

## 6. Rencana Pengujian

### 6.1 Auto-layout awal

- Focused initial open memanggil layout setelah closure `A -> B -> C` selesai dimuat.
- Full initial open memanggil layout setelah semua tabel selesai dimuat.
- Posisi lama dari All tables atau focused ERD lain, termasuk satu posisi yang cocok, tidak melewati auto-layout awal.
- Membuka ulang melalui metadata cache tetap menjalankan auto-layout tanpa request metadata baru.
- Refresh scope aktif tetap mempertahankan posisi manual.
- Initial layout tidak membuat undo history.
- `fitView()` dipanggil setelah layout selesai, bukan sebelum node diposisikan.
- Response/layout stale setelah dialog ditutup atau schema berubah tidak diterapkan.
- Failure layout mempertahankan diagram yang sudah dimuat.

### 6.2 Focused color

- Root `A` mendapat `data.isFocused = true`; dependency `B` dan `C` tidak.
- Multi-root menandai semua roots.
- `public.A` tidak salah menandai `other.A`.
- Focused + selected menampilkan kedua state.
- Warna yang dirender adalah `#9F2B68` dan teks header tetap kontras.

### 6.3 Scope isolation

Skenario regresi bug 4:

1. Simpan layout All tables dengan posisi tabel berjauhan, lalu tutup diagram.
2. Generate focused ERD `A, B, C` pada connection/database/scope schema yang sama.
3. Pastikan pipeline Auto Layout berjalan dan posisi lama bukan hasil akhir untuk tabel di luar layer `free`.
4. Pastikan posisi persisted tabel `unrelated` tetap utuh.
5. Ulangi dengan hanya satu posisi tersimpan yang cocok dan dengan metadata cache hit.

Skenario tambahan pergantian scope:

1. Buka focused closure `A, B, C`.
2. Pilih **Show all tables**, sehingga `unrelated` ikut dimuat.
3. Kembali ke focused.
4. Tekan **Auto Layout**.
5. Pastikan input/result layout hanya berisi `A, B, C`; posisi `unrelated` tidak berubah dan tidak ada edge ke node di luar scope.

Tambahkan juga test cache-hit transition untuk memastikan Auto Layout disabled sampai focused graph selesai di-commit.

### 6.4 Gesture

- Plain wheel/two-finger event tidak menjalankan zoom handler dan diserahkan ke pan-on-scroll.
- `Ctrl + wheel up` menaikkan zoom; `Ctrl + wheel down` menurunkan zoom.
- Zoom tidak melewati `0.05` dan `2`.
- World coordinate di bawah pointer tetap sama sebelum/sesudah zoom.
- Event yang ditangani menjadi `defaultPrevented` dan tidak double-applied.
- Tombol zoom, MiniMap, mouse/space pan, dan fit view tetap bekerja.

### 6.5 Verifikasi manual

Uji minimal pada Tauri/WebView Windows dan browser Chromium:

- touchpad dua jari horizontal/vertikal untuk pan;
- pinch in/out;
- mouse `Ctrl + wheel`;
- toggle focused/all/focused lalu Auto Layout;
- theme light dan dark untuk warna focused;
- satu root, multi-root, dan nama tabel sama lintas schema.

## 7. Perintah Verifikasi

Setelah implementasi:

```text
pnpm vitest run apps/desktop/src/components/diagram/__tests__/SchemaDiagramLoading.spec.ts
pnpm vitest run apps/desktop/src/components/diagram/__tests__/DiagramToolbar.spec.ts
pnpm vitest run apps/desktop/src/lib/diagram/__tests__/diagramZoom.spec.ts
pnpm vitest run packages/app-tests/diagramVueFlowAdapter.test.ts
pnpm typecheck
pnpm lint
```

Formatter dijalankan hanya pada file yang berubah sebelum verifikasi akhir.

## 8. Acceptance Criteria

- Saat diagram pertama kali tampil, tabel sudah tersusun otomatis tanpa klik Auto Layout.
- Generate ERD setelah ERD lain pernah dibuat tetap menyusun ulang scope aktif; adanya posisi schema-wide tidak melewati auto-layout awal.
- Hasil initial layout sama secara fungsional dengan tombol Auto Layout dan langsung di-fit ke viewport.
- Semua focused roots tampil dengan warna `#9F2B68`; related tables tetap memakai style normal.
- Dua jari dapat menggeser canvas, pinch dapat zoom, dan `Ctrl + wheel` dapat zoom dengan pusat di pointer.
- Seluruh jalur zoom memakai batas `0.05`–`2`.
- Setelah all tables dikembalikan ke focused, Auto Layout tidak membaca, memindahkan, atau merutekan tabel di luar focused closure.
- Auto Layout tidak dapat dijalankan pada graph lama selama scope transition.
- Tidak ada regresi pada cache focused, refresh, draft/patch persistence, layer visibility, undo/redo, export, MiniMap, atau full-schema loading.

## 9. Di Luar Scope

- Mengubah algoritma recursive FK closure atau TTL cache focused.
- Menambah endpoint backend baru.
- Menambahkan zoom gesture ke engineering diagram non-Vue-Flow.
- Mendesain ulang warna seluruh node/layer.
- Mengubah format persisted layout secara permanen kecuali diperlukan setelah hasil pengujian membuktikan adanya kebocoran state yang tidak dapat diselesaikan dengan scoped runtime state.

## 10. Hasil Implementasi dan Verifikasi

Implementasi dan hasil pengujian tersedia di [implementation-result.md](implementation-result.md).

- Auto-layout awal kini memakai pipeline ELK yang sama dengan tombol Auto Layout, termasuk ketika posisi lama tersedia.
- Isolasi memakai snapshot graph, identity closure aktif, state transisi, dan generation guard.
- Focused roots memakai `#9F2B68`; konfigurasi pan/pinch serta Ctrl-wheel telah ditambahkan.
- Suite regresi diagram sebelumnya: **306 test lulus dalam 35 file**, termasuk pembandingan initial/manual layout dengan ELK asli, pinch pecahan kecil, event gesture sintetis, dan warna baris FK/PK komposit. Hasil ini mendahului patch host WebView2 dan bukan bukti kelulusan patch native tersebut.
- Pengguna melaporkan pinch tetap gagal pada WebView desktop. Patch native telah ditambahkan; rebuild dan pengujian fisiknya masih menunggu verifikasi pengguna.
- Pengujian otomatis tidak menggantikan uji touchpad fisik dan canvas Tauri/browser secara penuh. Batas validasi dan langkah manual dicatat di laporan hasil.
