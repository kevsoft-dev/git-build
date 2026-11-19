#!/usr/bin/env python3
"""
Git Pusher
Dorong isi ZIP ke repo GitHub: 1 file = 1 commit (lewat Contents API),
sehingga hasilnya sama seperti edit/upload file langsung di GitHub web.

- Pesan commit gaya GitHub web: "Create <file>" / "Update <file>"
- Tidak mengatur author/committer -> commit atas nama pemilik token
- Hormat rate limit: jeda acak, jatah per menit/jam, Retry-After, backoff
- Idempotent: file yang isinya sama dilewati, jadi aman dijalankan ulang/dilanjut
"""
import base64
import hashlib
import io
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

START = time.time()


def env(name, default=""):
    return os.environ.get(name, default).strip()


def flag(name, default=False):
    v = env(name)
    return default if v == "" else v.lower() in ("1", "true", "yes", "y")


API = env("GITHUB_API_URL", "https://api.github.com").rstrip("/")
TOKEN = env("PUSH_TOKEN")
TARGET = env("TARGET_REPO")
ZIP_PATH = env("ZIP_PATH")
ZIP_URL = env("ZIP_URL")
BRANCH = env("BRANCH")
DELAY_MIN = float(env("DELAY_MIN", "4"))
DELAY_MAX = float(env("DELAY_MAX", "9"))
MSG_TEMPLATE = env("COMMIT_MESSAGE")
SKIP_UNCHANGED = flag("SKIP_UNCHANGED", True)
DELETE_MISSING = flag("DELETE_MISSING", False)
MAX_RUNTIME = int(env("MAX_RUNTIME", "16200"))   # detik, lalu lanjut run baru
PER_HOUR = int(env("PER_HOUR", "450"))           # batas GitHub: 500/jam
PER_MINUTE = int(env("PER_MINUTE", "50"))        # batas GitHub: 80/menit

writes = []  # timestamp tiap request tulis


def log(msg):
    print(msg, flush=True)


def set_output(key, value):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            f.write(f"{key}={value}\n")


def summary(text):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write(text + "\n")


def die(msg):
    print(f"::error::{msg}", flush=True)
    set_output("resume", "false")
    sys.exit(1)


class ApiError(Exception):
    def __init__(self, status, payload):
        super().__init__(f"HTTP {status}: {payload.get('message', payload)}")
        self.status = status
        self.payload = payload


# ----------------------------------------------------------------- rate limit
def throttle():
    """Tahan request tulis supaya tidak melewati batas per menit / per jam."""
    while True:
        now = time.time()
        writes[:] = [t for t in writes if now - t < 3600]
        last_min = [t for t in writes if now - t < 60]
        if len(writes) >= PER_HOUR:
            wait = 3600 - (now - writes[0]) + 1
            log(f"  ⏸ jatah per jam penuh, menunggu {int(wait)} dtk")
        elif len(last_min) >= PER_MINUTE:
            wait = 60 - (now - last_min[0]) + 1
        else:
            return
        time.sleep(max(wait, 1))


def retry_wait(err, payload, attempt):
    h = err.headers
    msg = (payload.get("message") or "").lower()
    jitter = random.uniform(1, 4)
    if err.code in (403, 429):
        if h.get("Retry-After"):
            return float(h["Retry-After"]) + jitter
        if h.get("X-RateLimit-Remaining") == "0":
            reset = float(h.get("X-RateLimit-Reset", time.time() + 60))
            return max(reset - time.time(), 1) + jitter + 2
        if "rate limit" in msg or "abuse" in msg or "secondary" in msg:
            return min(60 * attempt, 600) + jitter
        return None
    if err.code in (500, 502, 503, 504):
        return min(5 * 2 ** attempt, 120) + jitter
    if err.code == 409:  # branch sedang berubah / lock
        return min(3 * attempt, 30) + jitter
    return None


def call(method, path, body=None, allow=(200, 201), write=False):
    url = path if path.startswith("http") else API + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "git-pusher",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    attempt = 0
    while True:
        if write:
            throttle()
            writes.append(time.time())
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                payload = json.loads(raw)
            except Exception:
                payload = {"message": raw.decode("utf-8", "replace")[:300]}
            if e.code in allow:
                return e.code, payload
            attempt += 1
            wait = retry_wait(e, payload, attempt)
            if wait is None or attempt > 8:
                raise ApiError(e.code, payload)
            log(f"  ↻ HTTP {e.code} ({str(payload.get('message', ''))[:70]}), ulangi {int(wait)} dtk lagi")
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            attempt += 1
            if attempt > 8:
                raise
            wait = min(5 * 2 ** attempt, 120)
            log(f"  ↻ koneksi bermasalah ({e}), ulangi {wait} dtk lagi")
            time.sleep(wait)


# ----------------------------------------------------------------------- zip
def load_zip():
    if ZIP_URL:
        log("Mengunduh ZIP dari URL...")
        req = urllib.request.Request(ZIP_URL, headers={"User-Agent": "git-pusher"})
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
    else:
        ws = os.path.realpath(os.environ.get("GITHUB_WORKSPACE", "."))
        path = os.path.realpath(os.path.join(ws, ZIP_PATH or "uploads/bundle.zip"))
        if not path.startswith(ws + os.sep):
            die("zip_path harus berada di dalam repo ini")
        if not os.path.isfile(path):
            die(f"ZIP tidak ditemukan: {ZIP_PATH}")
        with open(path, "rb") as f:
            data = f.read()
    try:
        return zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        die("File bukan ZIP yang valid")


def collect(z):
    """Kembalikan {path_di_repo: ZipInfo}. Buang folder root jika semua file berbagi satu root."""
    items = []
    for info in z.infolist():
        n = info.filename
        parts = n.split("/")
        if info.is_dir() or n.startswith("/") or ".." in parts:
            continue
        if parts[0] in ("__MACOSX", ".git") or parts[-1] == ".DS_Store":
            continue
        items.append((n, info))
    if not items:
        die("ZIP kosong")
    first = items[0][0].split("/")[0]
    nested = all(n.startswith(first + "/") for n, _ in items)
    out = {}
    for n, info in items:
        p = n.split("/", 1)[1] if nested else n
        if p:
            out[p] = info
    return dict(sorted(out.items()))


def blob_sha(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


# ------------------------------------------------------------------- github
def quote_path(p):
    return urllib.parse.quote(p, safe="/")


def get_sha(path, branch):
    q = f"?ref={urllib.parse.quote(branch, safe='')}" if branch else ""
    st, p = call("GET", f"/repos/{TARGET}/contents/{quote_path(path)}{q}", allow=(200, 404))
    return p.get("sha") if st == 200 and isinstance(p, dict) else None


def message_for(action, path):
    if MSG_TEMPLATE:
        return MSG_TEMPLATE.replace("{action}", action).replace("{file}", path)
    return f"{action} {path}"  # sama persis dengan default editor web GitHub


def put_file(path, data, existing_sha, branch, send_branch):
    local = blob_sha(data)
    for attempt in range(2):
        action = "Update" if existing_sha else "Create"
        body = {"message": message_for(action, path),
                "content": base64.b64encode(data).decode()}
        if send_branch:
            body["branch"] = branch
        if existing_sha:
            body["sha"] = existing_sha
        try:
            call("PUT", f"/repos/{TARGET}/contents/{quote_path(path)}", body, write=True)
            return True
        except ApiError as e:
            if e.status == 422 and attempt == 0:
                fresh = get_sha(path, branch if send_branch else "")
                if fresh == local:
                    return False  # ternyata sudah sama
                existing_sha = fresh
                continue
            raise
    return False


def main():
    if not TOKEN:
        die("Secret PUSH_TOKEN belum diisi (Settings → Secrets and variables → Actions)")
    if "/" not in TARGET:
        die("target_repo harus berformat owner/nama-repo")

    # --- info repo & branch
    try:
        _, repo = call("GET", f"/repos/{TARGET}")
    except ApiError as e:
        die(f"Tidak bisa membuka {TARGET}: {e}")
    if (repo.get("permissions") or {}).get("push") is False:
        die("Token tidak punya izin tulis ke repo tujuan")
    default = repo["default_branch"]
    branch = BRANCH or default

    st, b = call("GET", f"/repos/{TARGET}/branches/{urllib.parse.quote(branch, safe='/')}", allow=(200, 404))
    empty_repo = False
    tree, tree_ok = {}, True
    if st == 404:
        if branch == default:
            empty_repo = True      # repo kosong, commit pertama membuat branch
        else:
            st2, d = call("GET", f"/repos/{TARGET}/branches/{urllib.parse.quote(default, safe='/')}", allow=(200, 404))
            if st2 != 200:
                die(f"Branch {branch} tidak ada dan branch default juga belum ada")
            call("POST", f"/repos/{TARGET}/git/refs",
                 {"ref": f"refs/heads/{branch}", "sha": d["commit"]["sha"]}, write=True)
            b = d
            log(f"Branch baru dibuat: {branch}")
    if not empty_repo:
        st, t = call("GET", f"/repos/{TARGET}/git/trees/{b['commit']['sha']}?recursive=1", allow=(200, 404, 409))
        if st == 200:
            tree = {i["path"]: i["sha"] for i in t.get("tree", []) if i["type"] == "blob"}
            tree_ok = not t.get("truncated", False)

    z = load_zip()
    files = collect(z)
    total = len(files)
    log(f"Repo: {TARGET} @ {branch} | {total} file | jeda {DELAY_MIN}-{DELAY_MAX} dtk")

    pushed = skipped = failed = 0
    resume = False
    send_branch = not empty_repo
    lo, hi = min(DELAY_MIN, DELAY_MAX), max(DELAY_MIN, DELAY_MAX)

    for i, (path, info) in enumerate(files.items(), 1):
        if time.time() - START > MAX_RUNTIME:
            resume = True
            log("⏱ Batas waktu run tercapai, sisanya dilanjutkan run berikutnya")
            break
        if info.file_size > 95 * 1024 * 1024:
            log(f"[{i}/{total}] ✗ {path} (>95MB, dilewati)")
            failed += 1
            continue
        data = z.read(info)
        local = blob_sha(data)
        remote = tree.get(path) if tree_ok else get_sha(path, branch if send_branch else "")
        if SKIP_UNCHANGED and remote == local:
            skipped += 1
            log(f"[{i}/{total}] = {path} (sama, dilewati)")
            continue
        try:
            done = put_file(path, data, remote, branch, send_branch)
        except ApiError as e:
            failed += 1
            log(f"[{i}/{total}] ✗ {path} → {e}")
            continue
        send_branch = True
        tree[path] = local
        if done:
            pushed += 1
            log(f"[{i}/{total}] ✓ {message_for('Update' if remote else 'Create', path)}")
            if i < total:
                time.sleep(random.uniform(lo, hi))
        else:
            skipped += 1

    # --- hapus file yang tidak ada di ZIP (opsional)
    deleted = 0
    if DELETE_MISSING and not resume and files:
        for path in [p for p in tree if p not in files]:
            try:
                call("DELETE", f"/repos/{TARGET}/contents/{quote_path(path)}",
                     {"message": message_for("Delete", path), "sha": tree[path], "branch": branch},
                     write=True)
                deleted += 1
                log(f"✓ Delete {path}")
                time.sleep(random.uniform(lo, hi))
            except ApiError as e:
                failed += 1
                log(f"✗ hapus {path} → {e}")

    set_output("resume", "true" if resume else "false")
    summary(f"### Git Pusher → `{TARGET}` (`{branch}`)\n"
            f"- Commit baru: **{pushed}**\n- Dilewati (sama): **{skipped}**\n"
            f"- Dihapus: **{deleted}**\n- Gagal: **{failed}**\n"
            f"- Lanjut otomatis: **{'ya' if resume else 'tidak'}**")
    log(f"Selesai: {pushed} commit, {skipped} dilewati, {deleted} dihapus, {failed} gagal")
    if failed and not resume:
        sys.exit(1)


if __name__ == "__main__":
    main()
