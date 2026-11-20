// ===== kev-git: deploy ZIP ke GitHub hanya pakai Personal Access Token (API key) =====
const API = 'https://api.github.com';
const MAX_FILE_BYTES = 50 * 1024 * 1024;   // file lebih besar dilewati (batas aman blob API)
const PARALLEL = 4;                         // jumlah upload blob bersamaan
let TOKEN = localStorage.getItem('kg_token') || "";

// Layanan latar belakang Android (hanya ada di dalam APK; di browser diabaikan)
const BG = (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
    ? window.Capacitor.registerPlugin('BgService') : null;

// Jembatan native tidak boleh menahan UI/log: maksimal 2 detik, error diabaikan
function bg(method, opts) {
    if (!BG) return Promise.resolve();
    const call = Promise.resolve().then(() => BG[method](opts || {})).catch(e => console.warn('BgService', method, e));
    return Promise.race([call, new Promise(r => setTimeout(r, 2000))]);
}

// Semua error tak terduga ikut tampil di log, bukan diam saja
if (window.addEventListener) {
    window.addEventListener('error', ev => { try { writeLog("Error: " + (ev.message || ev.error), "#ee0000"); } catch (e) {} });
    window.addEventListener('unhandledrejection', ev => { try { writeLog("Error: " + ((ev.reason && ev.reason.message) || ev.reason), "#ee0000"); } catch (e) {} });
}

document.addEventListener("DOMContentLoaded", () => {
    renderHistory();
    if (TOKEN) loadRepos(true);
});

function writeLog(text, color = "#00ff66") {
    const l = document.getElementById('log');
    l.style.display = "block";
    const e = document.createElement('div');
    e.style.color = color;
    e.textContent = "› " + text;
    l.appendChild(e);
    l.scrollTop = l.scrollHeight;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class FatalError extends Error {}

function ghHeaders(json) {
    const h = { 'Authorization': `Bearer ${TOKEN}`, 'Accept': 'application/vnd.github+json' };
    if (json) h['Content-Type'] = 'application/json';
    return h;
}

// fetch ke GitHub dengan retry otomatis (jaringan putus, 5xx, rate limit)
async function gh(path, opts = {}, tries = 5) {
    const { method = 'GET', body } = opts;
    const url = path.startsWith('http') ? path : API + path;
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
        try {
            const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeout || 60000) : null;
            let res;
            try {
                res = await fetch(url, {
                    method,
                    headers: ghHeaders(body !== undefined),
                    body: body !== undefined ? JSON.stringify(body) : undefined,
                    signal: ctrl ? ctrl.signal : undefined
                });
            } finally { if (timer) clearTimeout(timer); }
            if (res.status === 401) throw new FatalError("Token tidak valid atau sudah kedaluwarsa (401).");
            if (res.status === 403 || res.status === 429) {
                const text = await res.clone().text();
                const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
                const remaining = res.headers.get('x-ratelimit-remaining');
                const reset = parseInt(res.headers.get('x-ratelimit-reset') || '0', 10);
                const limited = retryAfter || remaining === '0' || /rate limit|abuse|secondary/i.test(text);
                if (!limited) return res;                       // 403 biasa (izin kurang) -> biar caller yang lapor
                let wait = retryAfter * 1000;
                if (!wait && remaining === '0' && reset) wait = Math.max(1000, reset * 1000 - Date.now() + 1000);
                if (!wait) wait = 15000 * (i + 1);
                if (wait > 90000) throw new FatalError("Rate limit GitHub habis, coba lagi beberapa menit lagi.");
                writeLog(`Kena rate limit, menunggu ${Math.ceil(wait / 1000)} dtk...`, "#f5a623");
                await sleep(wait);
                continue;
            }
            if (res.status >= 500) {
                lastErr = new Error("Server GitHub error " + res.status);
                await sleep(1000 * (i + 1));
                continue;
            }
            return res;
        } catch (e) {
            if (e instanceof FatalError) throw e;
            lastErr = (e && e.name === 'AbortError') ? new Error("waktu habis (koneksi lambat)") : e;
            if (i < tries - 1) writeLog(`Koneksi bermasalah, mengulang (${i + 1}/${tries - 1})...`, "#f5a623");
            await sleep(1000 * (i + 1));
        }
    }
    throw new Error("Koneksi ke GitHub gagal: " + (lastErr ? lastErr.message : "tidak diketahui"));
}

async function errMsg(res) {
    try {
        const j = await res.json();
        return (j && j.message) ? j.message : ("HTTP " + res.status);
    } catch (e) { return "HTTP " + res.status; }
}

async function must(res, what) {
    if (res.ok) return res;
    const m = await errMsg(res);
    let hint = "";
    if (/workflow/i.test(m)) hint = " → Token perlu izin 'workflow' (classic) / 'Workflows: Read and write' (fine-grained).";
    else if (/protected branch|required status|review/i.test(m)) hint = " → Branch diproteksi, matikan proteksi atau pakai repo lain.";
    else if (res.status === 403 || res.status === 404) hint = " → Cek izin token ke repo ini (Contents: Read and write).";
    throw new Error(`${what} gagal (${res.status}): ${m}${hint}`);
}

// ===== Login pakai token =====
async function connect() {
    const t = document.getElementById('token').value.trim();
    if (!t) return alert("Isi token dulu.");
    TOKEN = t;
    const btn = document.getElementById('connectBtn');
    btn.disabled = true;
    try {
        await loadRepos(false);
    } finally {
        btn.disabled = false;
    }
}

async function loadRepos(silent) {
    try {
        const meRes = await gh('/user');
        await must(meRes, "Cek token");
        const me = await meRes.json();

        const scopes = meRes.headers.get('x-oauth-scopes');   // hanya ada di token classic
        if (scopes !== null) {
            const list = scopes.split(',').map(s => s.trim());
            if (!list.includes('repo')) throw new FatalError("Token classic belum punya scope 'repo'.");
            if (!list.includes('workflow')) writeLog("Peringatan: token tanpa scope 'workflow' tidak bisa push folder .github/workflows.", "#f5a623");
        }

        let repos = [];
        for (let page = 1; page <= 10; page++) {
            const r = await gh(`/user/repos?per_page=100&sort=pushed&page=${page}`);
            await must(r, "Memuat repo");
            const d = await r.json();
            repos = repos.concat(d);
            if (d.length < 100) break;
        }
        repos = repos.filter(r => !r.archived && (!r.permissions || r.permissions.push !== false));
        if (!repos.length) throw new Error("Tidak ada repo yang bisa kamu push.");

        localStorage.setItem('kg_token', TOKEN);
        document.getElementById('whoami').textContent = "@" + me.login;
        document.getElementById('repoList').innerHTML = repos.map(r => `<option value="${r.full_name}">${r.full_name}</option>`).join('');
        document.getElementById('step1').classList.add('hidden');
        document.getElementById('step2').classList.remove('hidden');
        writeLog("Ready.");
    } catch (e) {
        const bad = e instanceof FatalError || /401|Token/.test(e.message);
        if (bad) { TOKEN = ""; localStorage.removeItem('kg_token'); }
        document.getElementById('step1').classList.remove('hidden');
        document.getElementById('step2').classList.add('hidden');
        if (!(silent && !bad)) alert(e.message);
    }
}

function logout() {
    TOKEN = "";
    localStorage.removeItem('kg_token');
    document.getElementById('token').value = "";
    document.getElementById('step2').classList.add('hidden');
    document.getElementById('step1').classList.remove('hidden');
}

// ===== Util ZIP =====
function toBase64(u8) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
}

function cleanPath(p) {
    p = p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    const parts = p.split('/');
    if (parts.some(x => x === '..' || x === '')) return null;
    if (parts[0] === '.git') return null;
    return parts.join('/');
}

async function runPool(items, limit, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            await worker(items[i], i);
        }
    });
    await Promise.all(runners);
}

// SHA blob git dihitung lokal, supaya file yang tidak berubah tidak perlu diunggah ulang
async function gitBlobSha(u8) {
    if (!(window.crypto && window.crypto.subtle)) return null;
    const head = new TextEncoder().encode(`blob ${u8.length}\0`);
    const all = new Uint8Array(head.length + u8.length);
    all.set(head, 0); all.set(u8, head.length);
    const d = await crypto.subtle.digest('SHA-1', all);
    return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const encPath = p => p.split('/').map(encodeURIComponent).join('/');

// Pastikan branch ada. Repo kosong: file pertama dari ZIP jadi commit pertama (seperti upload biasa)
async function ensureBranch(repo, branch, getInit) {
    for (let attempt = 0; attempt < 6; attempt++) {
        const r = await gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
        if (r.ok) return (await r.json()).object.sha;
        if (r.status === 404 || r.status === 409) {
            if (attempt === 0 && getInit) {
                const init = await getInit();
                writeLog("Repo kosong, membuat commit pertama...");
                const put = await gh(`/repos/${repo}/contents/${encPath(init.path)}`, {
                    method: 'PUT',
                    body: { message: `Add ${init.path}`, content: init.data.length ? toBase64(init.data) : btoa("\n") }
                });
                if (!put.ok && put.status !== 422) await must(put, "Membuat commit pertama");
            }
            await sleep(1500);
            continue;
        }
        await must(r, "Membaca branch");
    }
    throw new Error("Branch '" + branch + "' tidak ditemukan dan gagal dibuat.");
}

// Isi tree terkini di branch (path -> {sha, mode, type}); null kalau terlalu besar / gagal dibaca
async function readExistingTree(repo, commitSha) {
    try {
        const c = await gh(`/repos/${repo}/git/commits/${commitSha}`);
        if (!c.ok) return null;
        const treeSha = (await c.json()).tree.sha;
        const t = await gh(`/repos/${repo}/git/trees/${treeSha}?recursive=1`);
        if (!t.ok) return null;
        const j = await t.json();
        if (j.truncated) return null;
        const map = new Map();
        for (const x of j.tree) if (x.type === 'blob' || x.type === 'commit') map.set(x.path, { sha: x.sha, mode: x.mode, type: x.type });
        return map;
    } catch (e) { return null; }
}

// Pesan commit gaya edit manual di GitHub: "Update app.js", "Add style.css", "Delete old.txt"
function autoMessage(created, updated, deleted) {
    const names = a => a.length <= 2 ? a.join(" and ") : null;
    const total = created.length + updated.length + deleted.length;
    if (total === 1) {
        if (created.length) return "Add " + created[0];
        if (updated.length) return "Update " + updated[0];
        return "Delete " + deleted[0];
    }
    if (!updated.length && !deleted.length) return names(created) ? "Add " + names(created) : `Add ${created.length} files`;
    if (!created.length && !deleted.length) return names(updated) ? "Update " + names(updated) : `Update ${updated.length} files`;
    if (!created.length && !updated.length) return names(deleted) ? "Delete " + names(deleted) : `Delete ${deleted.length} files`;
    return `Update ${total} files`;
}

// ===== Deploy =====
async function startDeploy() {
    const repo = document.getElementById('repoList').value;
    const file = document.getElementById('zipInput').files[0];
    if (!repo) return alert("Pilih repo!");
    if (!file) return alert("Pilih ZIP!");
    const customMsg = (document.getElementById('commitMsg').value || "").trim();
    const btn = document.getElementById('deployBtn');
    btn.disabled = true;
    let finalText = "Deploy gagal";
    writeLog(`Memulai deploy ke ${repo}...`);
    bg('start', { text: `Mengunggah ke ${repo}...` });   // tidak ditunggu, supaya log tidak tertahan

    try {
        writeLog(`Initializing ${repo}...`);
        const repoRes = await gh(`/repos/${repo}`);
        await must(repoRes, "Membaca repo");
        const repoInfo = await repoRes.json();
        if (repoInfo.archived) throw new Error("Repo diarsipkan (read-only).");
        if (repoInfo.permissions && repoInfo.permissions.push === false) throw new Error("Token tidak punya izin push ke repo ini.");
        const branch = repoInfo.default_branch || 'main';

        // Baca ZIP
        if (typeof JSZip === 'undefined') throw new Error("Library ZIP belum termuat. Cek internet lalu buka ulang app.");
        writeLog("Membaca ZIP...");
        let zip;
        try { zip = await JSZip.loadAsync(await file.arrayBuffer()); }
        catch (e) { throw new Error("File ZIP rusak atau tidak bisa dibaca."); }

        let entries = [];
        for (const name of Object.keys(zip.files)) {
            const z = zip.files[name];
            if (z.dir) continue;
            if (/(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/.test(name)) continue;
            entries.push({ zipName: name, norm: name.replace(/\\/g, '/') });
        }
        if (!entries.length) throw new Error("ZIP kosong.");

        // Kalau semua file ada di dalam satu folder induk, buang folder itu
        const firstFolder = entries[0].norm.split('/')[0];
        const isNested = entries[0].norm.includes('/') && entries.every(x => x.norm.startsWith(firstFolder + '/'));

        const items = new Map();
        for (const x of entries) {
            const rel = isNested ? x.norm.substring(firstFolder.length + 1) : x.norm;
            const p = cleanPath(rel);
            if (!p) { writeLog("Lewati path tidak valid: " + x.norm, "#f5a623"); continue; }
            items.set(p, x.zipName);
        }
        if (!items.size) throw new Error("Tidak ada file valid di ZIP.");
        const list = Array.from(items.entries());

        const getInit = async () => {
            for (const [path, zipName] of list) {
                const data = await zip.files[zipName].async("uint8array");
                if (data.length && data.length < 20 * 1024 * 1024) return { path, data };
            }
            const [path, zipName] = list[0];
            return { path, data: await zip.files[zipName].async("uint8array") };
        };

        const branchSha = await ensureBranch(repo, branch, getInit);
        const existing = await readExistingTree(repo, branchSha);
        if (!existing) writeLog("Tidak bisa membandingkan dengan isi repo, semua file diunggah.", "#f5a623");

        // Upload hanya file yang baru / berubah
        const tree = [];
        const created = [], updated = [];
        let done = 0, same = 0;
        await runPool(list, PARALLEL, async ([path, zipName]) => {
            const zf = zip.files[zipName];
            const data = await zf.async("uint8array");
            done++;
            const old = existing ? existing.get(path) : null;
            if (data.length > MAX_FILE_BYTES) {
                writeLog(`Lewati (terlalu besar >50MB): ${path}`, "#f5a623");
                if (old) tree.push({ path, mode: old.mode, type: old.type, sha: old.sha });
                return;
            }
            const execBit = zf.unixPermissions && (zf.unixPermissions & 0o111);
            const mode = old ? old.mode : (execBit ? "100755" : "100644");
            const sha = await gitBlobSha(data);
            if (old && sha && old.sha === sha) {
                same++;
                tree.push({ path, mode, type: "blob", sha });
                return;
            }
            bg('update', { text: `Mengunggah ${done}/${list.length}: ${path}` });
            writeLog("Push: " + path);
            const body = data.length
                ? { content: toBase64(data), encoding: 'base64' }
                : { content: "", encoding: 'utf-8' };
            const r = await gh(`/repos/${repo}/git/blobs`, { method: 'POST', body, timeout: 180000 });
            if (!r.ok) {
                if (!data.length) { writeLog("Lewati file kosong: " + path, "#f5a623"); return; }
                await must(r, "Upload " + path);
            }
            const blob = await r.json();
            if (!blob.sha) throw new Error("Gagal mengunggah " + path);
            tree.push({ path, mode, type: "blob", sha: blob.sha });
            (old ? updated : created).push(path);
        });
        if (!tree.length) throw new Error("Tidak ada file yang berhasil diunggah.");

        // File yang ada di repo tapi tidak ada di ZIP = dihapus (submodule dibiarkan)
        const deleted = [];
        if (existing) {
            for (const [p, o] of existing) {
                if (items.has(p)) continue;
                if (o.type === 'commit') tree.push({ path: p, mode: o.mode, type: "commit", sha: o.sha });
                else deleted.push(p);
            }
        }
        created.sort(); updated.sort(); deleted.sort();
        tree.sort((a, b) => a.path < b.path ? -1 : 1);

        if (existing && !created.length && !updated.length && !deleted.length) {
            finalText = "Tidak ada perubahan: " + repo;
            writeLog("Tidak ada perubahan, tidak ada commit dibuat.", "#50e3c2");
            alert("Isi ZIP sama persis dengan repo, tidak ada yang perlu di-push.");
            return;
        }

        const message = customMsg || (existing ? autoMessage(created, updated, deleted) : "Update files");

        writeLog("Membuat tree...");
        const treeRes = await gh(`/repos/${repo}/git/trees`, { method: 'POST', body: { tree } });
        await must(treeRes, "Membuat tree");
        const newTree = await treeRes.json();

        // Ambil ulang SHA branch terbaru supaya parent selalu valid
        const parentSha = await ensureBranch(repo, branch, null).catch(() => branchSha);

        writeLog("Commit: " + message);
        const commitRes = await gh(`/repos/${repo}/git/commits`, {
            method: 'POST',
            body: { message, tree: newTree.sha, parents: [parentSha] }
        });
        await must(commitRes, "Membuat commit");
        const commit = await commitRes.json();

        writeLog("Memperbarui branch " + branch + "...");
        const refRes = await gh(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
            method: 'PATCH',
            body: { sha: commit.sha, force: true }
        });
        await must(refRes, "Memperbarui branch");

        finalText = "Deploy selesai: " + repo;
        writeLog(`Selesai: ${created.length} baru, ${updated.length} diubah, ${deleted.length} dihapus, ${same} tetap.`, "#50e3c2");
        saveHistory(repo);
        alert("Done!");
    } catch (e) {
        finalText = "Deploy gagal: " + e.message;
        writeLog("Error: " + e.message, "#ee0000");
        if (e instanceof FatalError) logout();
    } finally {
        btn.disabled = false;
        bg('stop', { text: finalText });
    }
}

// ===== Riwayat =====
function saveHistory(repo) {
    let history = [];
    try { history = JSON.parse(localStorage.getItem('kg_hist')) || []; } catch (e) {}
    history.unshift({ repo: repo, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    if (history.length > 3) history.pop();
    localStorage.setItem('kg_hist', JSON.stringify(history));
    renderHistory();
}

function renderHistory() {
    let history = [];
    try { history = JSON.parse(localStorage.getItem('kg_hist')) || []; } catch (e) {}
    const container = document.getElementById('historyContainer');
    if (history.length === 0) {
        container.innerHTML = '<div class="history-empty">No deployments logged.</div>';
        return;
    }
    container.innerHTML = history.map(item => `
        <div class="history-item">
            <span class="history-repo">${item.repo}</span>
            <span class="history-time">${item.time}</span>
        </div>
    `).join('');
}

function clearHistory() {
    localStorage.removeItem('kg_hist');
    renderHistory();
}
