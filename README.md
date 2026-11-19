# Git Pusher (Android)

Aplikasi Android untuk push isi ZIP ke repo GitHub, 1 file = 1 commit
("Create x" / "Update x"), anti-limit, berjalan di latar belakang (foreground service).

## Build APK tanpa Android Studio
1. Buat repo baru di GitHub, upload seluruh isi folder ini (termasuk `.github`).
2. Buka tab **Actions → Build APK → Run workflow**, isi nama, package, versi, warna logo, lalu Run.
   (Workflow harus ada di branch default repo agar tombolnya muncul.)
3. Selesai ±5 menit → buka **Releases**, unduh `GitPusher-v….apk`, install di HP.

## Pakai
1. Isi token (PAT dengan akses *Contents: Read and write*) → Connect.
2. Pilih repo, pilih ZIP, tekan **Mulai Push**.
3. Layar boleh mati / app ditutup; ada notifikasi progres dengan tombol Stop.
Jalankan ulang aman: file yang sama dilewati.

Android Studio: File → Open folder ini, lalu Run.
