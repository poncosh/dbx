# Hasil implementasi diagram fokus

Implementasi mengikuti kontrak `Implementation.md`.

## Perilaku akhir

- Pembukaan dari satu atau beberapa tabel memakai breadth-first traversal FK keluar, dengan maksimum empat tabel diproses bersamaan. Kolom, FK, dan indeks wajib berhasil; komentar boleh gagal. Hasil diurutkan berdasarkan schema dan nama tabel, tanpa memanggil `listTables()` pada mode fokus.
- Cache memori menyimpan seluruh closure selama tepat 300.000 ms sejak hasil lengkap berhasil dimuat. Key mencakup versi kontrak, koneksi, database, catalog, root dengan schema, dan arah traversal. Snapshot disalin saat masuk dan keluar cache.
- Permintaan serentak untuk key yang sama berbagi proses pemuatan. Refresh mengabaikan cache; refresh serentak berbagi pemuatan paksa. Hanya proses yang masih terdaftar boleh mengganti cache, sehingga hasil lama tidak menimpa refresh baru.
- Refresh gagal mempertahankan cache yang masih valid dan diagram sebelumnya. Respons yang datang setelah konteks berubah atau dialog ditutup diabaikan oleh komponen.
- `Show all tables` menjalankan loader schema penuh. Kembali ke mode fokus memakai cache bila masih valid. Diagram tanpa root tetap memakai loader penuh dengan toleransi kesalahan yang sudah ada.
- Identitas node, posisi awal, dan snapshot history menggunakan schema ketika diperlukan untuk mencegah tabrakan nama tabel lintas schema.
- Snapshot pilihan database/schema disimpan di memori agar membuka ulang closure yang masih valid juga tidak memicu discovery namespace.

## Keamanan data lokal

Mode fokus membandingkan tabel dengan snapshot terakhir yang diterapkan. Hanya draft dan live patch yang benar-benar berubah yang di-upsert atau dihapus. Posisi digabungkan hanya untuk identitas dalam cakupan pemuatan. Keanggotaan layer untuk tabel yang tidak dimuat dipertahankan, dan layer yang belum lengkap tidak ditata ulang otomatis. Patch lama tanpa schema diterapkan pada schema asal, bukan pada tabel bernama sama di schema lain.

## Berkas ditambahkan

- `apps/desktop/src/lib/diagram/diagramMetadataLoader.ts`
- `apps/desktop/src/lib/diagram/diagramMetadataCache.ts`
- `apps/desktop/src/lib/diagram/__tests__/diagramMetadataLoader.spec.ts`
- `apps/desktop/src/lib/diagram/__tests__/diagramMetadataCache.spec.ts`
- `apps/desktop/src/lib/diagram/__tests__/diagramFocusedStorage.spec.ts`
- `apps/desktop/src/components/diagram/__tests__/SchemaDiagramLoading.spec.ts`
- `Implementation-result.md`

## Berkas dimodifikasi

- `apps/desktop/src/components/diagram/SchemaDiagramDialog.vue`
- `apps/desktop/src/components/diagram/DiagramToolbar.vue`
- `apps/desktop/src/lib/diagram/draft-storage.ts`
- `apps/desktop/src/components/layout/AppDialogs.vue`
- `apps/desktop/src/components/objects/ObjectBrowser.vue`
- `apps/desktop/src/composables/useDialogSources.ts`
- `apps/desktop/src/composables/useSidebarTreeToolRuntime.ts`
- `apps/desktop/src/stores/connectionStore.ts`
- `packages/app-tests/diagramRefreshConfirm.test.ts`

## Verifikasi

Perintah utama yang dijalankan:

```powershell
$diagramTests = @(rg --files packages/app-tests | Where-Object { $_ -match '(diagram|erDiagram).*\.test\.ts$' })
pnpm exec vitest run @diagramTests apps/desktop/src/lib/diagram/__tests__ apps/desktop/src/components/diagram/__tests__ packages/app-tests/sidebarDialogRouting.test.ts

$env:NODE_OPTIONS='--max-old-space-size=12288'
pnpm typecheck

$env:NODE_OPTIONS='--max-old-space-size=6144'
pnpm exec vue-tsc --noEmit --project apps/desktop/tsconfig.json

pnpm lint
git diff --check
```

- Pemeriksaan luas: **277 pengujian lulus dalam 32 berkas**.
- Seluruh acceptance criteria memiliki validasi otomatis langsung pada loader, cache, persistence, atau orchestration/UI component boundary.
- Refresh diuji dengan perubahan nyata pada payload kolom, indeks, dan foreign key; hasil baru harus diterapkan ke diagram dan cache.
- Jalur focused loader diuji memakai `listForeignKeys()` per tabel dan tidak memanggil `listForeignKeysForDatabase()`.
- Drag dan edit diuji melalui handler komponen, lalu refresh memastikan state lokal tabel lain tetap tersimpan.
- Toolbar dirender dan diverifikasi hanya memiliki satu kontrol Refresh yang menghasilkan satu event.
- Typecheck dan pemeriksaan incremental lulus. Percobaan awal dengan batas heap bawaan 4 GB kehabisan memori; pengulangan dengan batas lebih besar berhasil.
- Lint lulus dengan peringatan yang sudah ada. Pemeriksaan whitespace lulus.
- Formatter `oxfmt` dijalankan hanya pada berkas yang diubah untuk implementasi ini.

Pengujian menggunakan adapter metadata yang diinjeksi dan mock API di batas komponen; loader, cache, orkestrasi komponen, event drag/edit, toolbar, serta penyimpanan lokal dijalankan. Renderer canvas dihilangkan dari harness integrasi. Semua acceptance criteria terverifikasi pada batas kontrak aplikasi. Koneksi database nyata, perubahan DDL eksternal, dan tampilan interaktif Tauri/browser tetap merupakan verifikasi provider/manual di luar acceptance suite ini.

Tidak diperlukan perubahan backend/Rust atau endpoint baru. Tambahan di luar daftar berkas usulan hanya penerusan catalog melalui `AppDialogs.vue`, pengujian keamanan penyimpanan/integrasi, serta laporan ini.
