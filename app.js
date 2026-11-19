// ===== Login GitHub (device flow, seperti `gh auth login` di Termux) =====
// Isi dengan Client ID OAuth App milikmu (Settings > Developer settings > OAuth Apps,
// centang "Enable Device Flow"). Bisa juga diisi lewat menu Pengaturan di app.
const DEFAULT_CLIENT_ID = "Ov23li5FPClRpf4tZvRR";
const SCOPE = "repo workflow";   // "workflow" perlu agar bisa push .github/workflows
let TOKEN = localStorage.getItem('kg_token') || "";
let loginAbort = false;
let wakeUp = null;

// Layanan latar belakang Android (hanya ada di dalam APK; di browser diabaikan)
const BG = (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
    ? window.Capacitor.registerPlugin('BgService') : null;

async function bg(method, opts) {
    if (!BG) return;
    try { await BG[method](opts || {}); } catch (e) { console.warn('BgService', method, e); }
}

document.addEventListener("DOMContentLoaded", () => {
    renderHistory();
    document.getElementById('clientId').value = getClientId();
    // Client ID sudah tertanam di kode -> sembunyikan kolomnya, user cukup tekan Login
    if (DEFAULT_CLIENT_ID.trim()) document.getElementById('clientIdGroup').classList.add('hidden');
    if (TOKEN) loadRepos();
});

// Saat balik dari browser ke app, langsung cek status login tanpa nunggu interval
document.addEventListener("visibilitychange", () => {
    if (!document.hidden && wakeUp) wakeUp();
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

async function getBase64(data) {
    return new Promise(r => {
        const reader = new FileReader();
        reader.onload = e => r(window.btoa(e.target.result));
        reader.readAsBinaryString(new Blob([data]));
    });
}

function getClientId() {
    return (localStorage.getItem('kg_client_id') || DEFAULT_CLIENT_ID).trim();
}

function ghHeaders(json) {
    const h = { 'Authorization': `Bearer ${TOKEN}`, 'Accept': 'application/vnd.github+json' };
    if (json) h['Content-Type'] = 'application/json';
    return h;
}

function sleepOrWake(ms) {
    return new Promise(r => {
        const t = setTimeout(() => { wakeUp = null; r(); }, ms);
        wakeUp = () => { clearTimeout(t); wakeUp = null; r(); };
    });
}

async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
}

async function startLogin() {
    const typed = document.getElementById('clientId').value.trim();
    if (typed && !DEFAULT_CLIENT_ID.trim()) localStorage.setItem('kg_client_id', typed);
    const clientId = DEFAULT_CLIENT_ID.trim() || getClientId();
    if (!clientId) return alert("Client ID belum diisi. Isi DEFAULT_CLIENT_ID di app.js atau lewat menu Pengaturan.");

    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    loginAbort = false;
    await bg('start', { text: 'Menunggu login GitHub...' });

    try {
        const d = await postJson('https://github.com/login/device/code', { client_id: clientId, scope: SCOPE });
        if (d.error) throw new Error(d.error_description || d.error);

        window.__verifyUrl = d.verification_uri || 'https://github.com/login/device';
        document.getElementById('userCode').textContent = d.user_code;
        document.getElementById('loginIdle').classList.add('hidden');
        document.getElementById('loginCode').classList.remove('hidden');
        setLoginStatus("Menunggu otorisasi...");
        copyCode(true);

        const token = await pollToken(clientId, d);
        TOKEN = token;
        localStorage.setItem('kg_token', TOKEN);
        await loadRepos();
    } catch (e) {
        if (!loginAbort) {
            const msg = (e instanceof TypeError)
                ? "Gagal terhubung ke GitHub. Login kode hanya jalan di APK; di browser pakai token manual."
                : e.message;
            alert(msg);
        }
        resetLoginUi();
    } finally {
        btn.disabled = false;
        await bg('stop', { text: TOKEN ? "Login GitHub berhasil" : "Login dibatalkan" });
    }
}

async function pollToken(clientId, d) {
    let interval = (d.interval || 5) * 1000;
    const deadline = Date.now() + (d.expires_in || 900) * 1000;
    while (!loginAbort && Date.now() < deadline) {
        await sleepOrWake(interval);
        if (loginAbort) break;
        const t = await postJson('https://github.com/login/oauth/access_token', {
            client_id: clientId,
            device_code: d.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        });
        if (t.access_token) return t.access_token;
        if (t.error === 'authorization_pending') continue;
        if (t.error === 'slow_down') { interval = (t.interval ? t.interval * 1000 : interval + 5000); continue; }
        if (t.error === 'expired_token') throw new Error("Kode kedaluwarsa, coba login lagi.");
        if (t.error === 'access_denied') throw new Error("Login ditolak.");
        throw new Error(t.error_description || t.error || "Login gagal");
    }
    if (loginAbort) throw new Error("dibatalkan");
    throw new Error("Kode kedaluwarsa, coba login lagi.");
}

function setLoginStatus(t) { document.getElementById('loginStatus').textContent = t; }

async function copyCode(silent) {
    const code = document.getElementById('userCode').textContent;
    try {
        await navigator.clipboard.writeText(code);
        setLoginStatus(silent ? "Kode disalin. Buka GitHub lalu tempel." : "Kode disalin.");
    } catch (e) {
        if (!silent) alert("Salin manual: " + code);
    }
}

function openVerify() {
    window.open(window.__verifyUrl || 'https://github.com/login/device', '_blank');
}

function cancelLogin() {
    loginAbort = true;
    if (wakeUp) wakeUp();
    resetLoginUi();
}

function resetLoginUi() {
    document.getElementById('loginCode').classList.add('hidden');
    document.getElementById('loginIdle').classList.remove('hidden');
}

async function connectManual() {
    const t = document.getElementById('token').value.trim();
    if (!t) return;
    TOKEN = t;
    localStorage.setItem('kg_token', TOKEN);
    await loadRepos();
}

async function loadRepos() {
    try {
        const [meRes, res] = await Promise.all([
            fetch('https://api.github.com/user', { headers: ghHeaders() }),
            fetch('https://api.github.com/user/repos?per_page=100&sort=pushed', { headers: ghHeaders() })
        ]);
        if (meRes.status === 401 || res.status === 401) throw new Error("Sesi login habis, silakan login lagi.");
        if (!res.ok) throw new Error("Gagal memuat repo (" + res.status + ")");
        const me = await meRes.json();
        const d = await res.json();
        document.getElementById('whoami').textContent = "@" + me.login;
        document.getElementById('repoList').innerHTML = d.map(r => `<option value="${r.full_name}">${r.full_name}</option>`).join('');
        document.getElementById('step1').classList.add('hidden');
        document.getElementById('step2').classList.remove('hidden');
        writeLog("Ready.");
    } catch (e) {
        TOKEN = "";
        localStorage.removeItem('kg_token');
        resetLoginUi();
        document.getElementById('step1').classList.remove('hidden');
        document.getElementById('step2').classList.add('hidden');
        alert(e.message);
    }
}

function logout() {
    TOKEN = "";
    localStorage.removeItem('kg_token');
    document.getElementById('step2').classList.add('hidden');
    document.getElementById('step1').classList.remove('hidden');
    resetLoginUi();
}

async function startDeploy() {
    const repo = document.getElementById('repoList').value;
    const file = document.getElementById('zipInput').files[0];
    if(!file) return alert("Pilih ZIP!");
    const btn = document.getElementById('deployBtn'); 
    btn.disabled = true;
    let finalText = "Deploy gagal";
    await bg('start', { text: `Mengunggah ke ${repo}...` });
    
    try {
        writeLog(`Initializing ${repo}...`);
        const repoRes = await fetch(`https://api.github.com/repos/${repo}`, { 
            headers: ghHeaders() 
        });
        const repoInfo = await repoRes.json();
        const branch = repoInfo.default_branch;
        
        const branchRes = await fetch(`https://api.github.com/repos/${repo}/branches/${branch}`, { 
            headers: ghHeaders() 
        });
        const branchInfo = await branchRes.json();
        const parentSha = branchInfo.commit.sha;
        
        const arrayBuffer = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);
        const files = Object.keys(zip.files).filter(k => !zip.files[k].dir);
        
        const firstFolder = files[0].split('/')[0];
        const isNested = files.every(f => f.startsWith(firstFolder + '/'));
        
        const tree = [];
        let n = 0;
        for(const f of files) {
            n++;
            bg('update', { text: `Mengunggah ${n}/${files.length}: ${f}` });
            writeLog("Push: " + f);
            const content = await zip.files[f].async("uint8array");
            const b64 = await getBase64(content);
            const blobRes = await fetch(`https://api.github.com/repos/${repo}/git/blobs`, {
                method: 'POST', 
                headers: ghHeaders(true),
                body: JSON.stringify({ content: b64, encoding: 'base64' })
            });
            const blob = await blobRes.json();
            if(!blob.sha) throw new Error("Gagal mengunggah " + f);
            
            const githubPath = isNested ? f.substring(f.indexOf('/') + 1) : f;
            if(!githubPath) continue;

            tree.push({ path: githubPath, mode: "100644", type: "blob", sha: blob.sha });
        }
        
        const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees`, {
            method: 'POST', 
            headers: ghHeaders(true),
            body: JSON.stringify({ tree })
        });
        const newTree = await treeRes.json();
        
        const commitRes = await fetch(`https://api.github.com/repos/${repo}/git/commits`, {
            method: 'POST', 
            headers: ghHeaders(true),
            body: JSON.stringify({ message: "⚡ kev-git build", tree: newTree.sha, parents: [parentSha] })
        });
        const commit = await commitRes.json();
        
        const refRes = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${branch}`, {
            method: 'PATCH', 
            headers: ghHeaders(true),
            body: JSON.stringify({ sha: commit.sha, force: true })
        });
        if(!refRes.ok) throw new Error("Gagal memperbarui branch (" + refRes.status + ")");
        
        finalText = "Deploy selesai: " + repo;
        writeLog("Deployment success.", "#50e3c2");
        saveHistory(repo);
        alert("Done!");
    } catch(e) { 
        finalText = "Deploy gagal: " + e.message;
        writeLog("Error: " + e.message, "#ee0000"); 
    } finally { 
        btn.disabled = false; 
        await bg('stop', { text: finalText });
    }
}

function saveHistory(repo) {
    let history = JSON.parse(localStorage.getItem('kg_hist')) || [];
    const newLog = { repo: repo, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) };
    history.unshift(newLog);
    if(history.length > 3) history.pop();
    localStorage.setItem('kg_hist', JSON.stringify(history));
    renderHistory();
}

function renderHistory() {
    const history = JSON.parse(localStorage.getItem('kg_hist')) || [];
    const container = document.getElementById('historyContainer');
    if(history.length === 0) {
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
