# Git Pusher (GitHub Actions)

1. Taruh repo ini di GitHub, lalu buat secret **PUSH_TOKEN**
   (Settings → Secrets and variables → Actions).
   - Fine-grained PAT: akses ke repo tujuan, *Contents: Read and write*
     (tambah *Workflows: write* jika ZIP berisi `.github/workflows`).
   - Atau classic PAT dengan scope `repo` (+ `workflow`).
2. Upload ZIP ke `uploads/bundle.zip` (atau pakai input `zip_url`).
3. Tab **Actions → Git Pusher → Run workflow**, isi `target_repo`, jalankan.
   Tutup browser pun tidak masalah, proses jalan di server GitHub.

Hasil: tiap file jadi 1 commit ("Create x" / "Update x") atas nama pemilik token.
