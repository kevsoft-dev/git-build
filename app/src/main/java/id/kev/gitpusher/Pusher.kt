package id.kev.gitpusher

import android.net.Uri
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import kotlin.random.Random

/** Daftar repo milik token (untuk dropdown). */
object Gh {
    fun repos(token: String): List<String> {
        val out = mutableListOf<String>()
        for (page in 1..5) {
            val c = URL("https://api.github.com/user/repos?per_page=100&sort=pushed&page=$page")
                .openConnection() as HttpURLConnection
            c.setRequestProperty("Authorization", "Bearer $token")
            c.setRequestProperty("Accept", "application/vnd.github+json")
            c.setRequestProperty("User-Agent", "git-pusher-android")
            if (c.responseCode != 200) throw IOException("Token tidak valid (HTTP ${c.responseCode})")
            val arr = JSONArray(c.inputStream.bufferedReader().use { it.readText() })
            for (i in 0 until arr.length()) out.add(arr.getJSONObject(i).getString("full_name"))
            c.disconnect()
            if (arr.length() < 100) break
        }
        return out
    }
}

/**
 * Dorong isi ZIP ke repo: 1 file = 1 commit via Contents API.
 * Pesan commit "Create x" / "Update x" (sama seperti editor web GitHub).
 */
class Pusher(
    private val token: String,
    private val repo: String,
    private val branchIn: String,
    private val dMin: Double,
    private val dMax: Double,
    private val log: (String) -> Unit,
    private val progress: (Int, Int) -> Unit,
    private val cancelled: () -> Boolean,
) {
    class Stop : Exception()
    class ApiError(val code: Int, msg: String) : Exception("HTTP $code: $msg")
    private class Resp(val code: Int, val body: String, val retryAfter: String?, val remaining: String?, val reset: String?)

    private val writes = mutableListOf<Long>()

    // ------------------------------------------------------------ rate limit
    private fun nap(ms: Long) {
        var left = ms
        while (left > 0) {
            if (cancelled()) throw Stop()
            val s = minOf(left, 500L)
            Thread.sleep(s)
            left -= s
        }
    }

    private fun throttle() {
        while (true) {
            val now = System.currentTimeMillis()
            writes.removeAll { now - it > 3_600_000L }
            val lastMin = writes.filter { now - it < 60_000L }
            val wait: Long = when {
                writes.size >= 450 -> 3_600_000L - (now - writes[0]) + 1000L   // batas GitHub 500/jam
                lastMin.size >= 50 -> 60_000L - (now - lastMin[0]) + 1000L      // batas GitHub 80/menit
                else -> return
            }
            log("⏸ menunggu jatah limit ${wait / 1000} dtk")
            nap(wait)
        }
    }

    private fun retryWait(r: Resp, msg: String, attempt: Int): Long? {
        val jitter = Random.nextLong(1000, 4000)
        return when {
            r.code == 403 || r.code == 429 -> when {
                r.retryAfter != null -> ((r.retryAfter.toDoubleOrNull() ?: 60.0) * 1000).toLong() + jitter
                r.remaining == "0" ->
                    maxOf((r.reset?.toLongOrNull() ?: 0L) * 1000 - System.currentTimeMillis(), 1000L) + jitter + 2000L
                msg.contains("rate limit", true) || msg.contains("abuse", true) || msg.contains("secondary", true) ->
                    minOf(60_000L * attempt, 600_000L) + jitter
                else -> null
            }
            r.code in 500..504 -> minOf(5_000L * (1 shl attempt), 120_000L) + jitter
            r.code == 409 -> minOf(3_000L * attempt, 30_000L) + jitter
            else -> null
        }
    }

    // ------------------------------------------------------------------ http
    private fun http(method: String, path: String, body: JSONObject?): Resp {
        val c = URL("https://api.github.com$path").openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 30_000
            c.readTimeout = 120_000
            c.setRequestProperty("Authorization", "Bearer $token")
            c.setRequestProperty("Accept", "application/vnd.github+json")
            c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
            c.setRequestProperty("User-Agent", "git-pusher-android")
            if (body != null) {
                val bytes = body.toString().toByteArray()
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.setFixedLengthStreamingMode(bytes.size)
                c.outputStream.use { it.write(bytes) }
            }
            val code = c.responseCode
            val stream = if (code >= 400) c.errorStream else c.inputStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            return Resp(code, text, c.getHeaderField("Retry-After"),
                c.getHeaderField("X-RateLimit-Remaining"), c.getHeaderField("X-RateLimit-Reset"))
        } finally {
            c.disconnect()
        }
    }

    private fun call(
        method: String, path: String, body: JSONObject? = null,
        allow: Set<Int> = emptySet(), write: Boolean = false,
    ): Resp {
        var attempt = 0
        while (true) {
            if (cancelled()) throw Stop()
            if (write) { throttle(); writes.add(System.currentTimeMillis()) }
            val r = try {
                http(method, path, body)
            } catch (e: IOException) {
                if (++attempt > 8) throw e
                val w = minOf(5_000L * (1 shl attempt), 120_000L)
                log("↻ koneksi bermasalah, ulang ${w / 1000} dtk")
                nap(w)
                continue
            }
            if (r.code in 200..299 || r.code in allow) return r
            attempt++
            val msg = runCatching { JSONObject(r.body).optString("message") }.getOrDefault("")
            val wait = retryWait(r, msg, attempt)
            if (wait == null || attempt > 8) throw ApiError(r.code, msg)
            log("↻ HTTP ${r.code} ($msg), ulang ${wait / 1000} dtk")
            nap(wait)
        }
    }

    // ------------------------------------------------------------------- zip
    private fun collect(zf: ZipFile): Map<String, ZipEntry> {
        val items = zf.entries().asSequence().filter { e ->
            val p = e.name.split("/")
            !e.isDirectory && !e.name.startsWith("/") && ".." !in p &&
                p[0] != "__MACOSX" && p[0] != ".git" && p.last() != ".DS_Store"
        }.toList()
        if (items.isEmpty()) throw IllegalStateException("ZIP kosong")
        val first = items[0].name.substringBefore("/")
        val nested = items.all { it.name.startsWith("$first/") }
        return items.associateBy { if (nested) it.name.substringAfter("/") else it.name }
            .filterKeys { it.isNotEmpty() }
            .toSortedMap()
    }

    private fun blobSha(d: ByteArray): String {
        val md = MessageDigest.getInstance("SHA-1")
        md.update("blob ${d.size}\u0000".toByteArray())
        return md.digest(d).joinToString("") { "%02x".format(it) }
    }

    private fun q(path: String) = path.split("/").joinToString("/") { Uri.encode(it) }

    private fun getSha(path: String, branch: String?): String? {
        val ref = if (branch != null) "?ref=${Uri.encode(branch)}" else ""
        val r = call("GET", "/repos/$repo/contents/${q(path)}$ref", allow = setOf(404))
        return if (r.code == 200) runCatching { JSONObject(r.body).getString("sha") }.getOrNull() else null
    }

    private fun putFile(path: String, data: ByteArray, existing: String?, branch: String, sendBranch: Boolean): Boolean {
        var sha = existing
        for (attempt in 0..1) {
            val body = JSONObject()
                .put("message", (if (sha != null) "Update " else "Create ") + path)
                .put("content", Base64.encodeToString(data, Base64.NO_WRAP))
            if (sendBranch) body.put("branch", branch)
            if (sha != null) body.put("sha", sha)
            try {
                call("PUT", "/repos/$repo/contents/${q(path)}", body, write = true)
                return true
            } catch (e: ApiError) {
                if (e.code == 422 && attempt == 0) {
                    val fresh = getSha(path, if (sendBranch) branch else null)
                    if (fresh == blobSha(data)) return false
                    sha = fresh
                    continue
                }
                throw e
            }
        }
        return false
    }

    // ------------------------------------------------------------------- run
    fun run(zipFile: File): String {
        val info = JSONObject(call("GET", "/repos/$repo").body)
        if (info.optJSONObject("permissions")?.optBoolean("push", true) == false)
            throw IllegalStateException("Token tidak punya izin tulis ke repo ini")
        val defBranch = info.getString("default_branch")
        val branch = branchIn.ifBlank { defBranch }

        var empty = false
        var head: String? = null
        val b = call("GET", "/repos/$repo/branches/${Uri.encode(branch, "/")}", allow = setOf(404))
        if (b.code == 404) {
            if (branch == defBranch) {
                empty = true   // repo kosong: commit pertama membuat branch
            } else {
                val d = call("GET", "/repos/$repo/branches/${Uri.encode(defBranch, "/")}", allow = setOf(404))
                if (d.code != 200) throw IllegalStateException("Branch default belum ada")
                val sha = JSONObject(d.body).getJSONObject("commit").getString("sha")
                call("POST", "/repos/$repo/git/refs",
                    JSONObject().put("ref", "refs/heads/$branch").put("sha", sha), write = true)
                head = sha
                log("Branch baru dibuat: $branch")
            }
        } else {
            head = JSONObject(b.body).getJSONObject("commit").getString("sha")
        }

        val tree = HashMap<String, String>()
        var treeOk = true
        if (head != null) {
            val t = call("GET", "/repos/$repo/git/trees/$head?recursive=1", allow = setOf(404, 409))
            if (t.code == 200) {
                val j = JSONObject(t.body)
                val arr = j.getJSONArray("tree")
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    if (o.getString("type") == "blob") tree[o.getString("path")] = o.getString("sha")
                }
                treeOk = !j.optBoolean("truncated", false)
            }
        }

        val lo = minOf(dMin, dMax)
        val hi = maxOf(dMin, dMax)

        return ZipFile(zipFile).use { zf ->
            val files = collect(zf)
            val total = files.size
            log("Repo: $repo @ $branch | $total file")
            var pushed = 0
            var skipped = 0
            var failed = 0
            var sendBranch = !empty
            var i = 0
            for ((path, entry) in files) {
                i++
                if (cancelled()) throw Stop()
                progress(i - 1, total)
                if (entry.size > 95L * 1024 * 1024) {
                    failed++
                    log("[$i/$total] ✗ $path (>95MB, dilewati)")
                    continue
                }
                val data = zf.getInputStream(entry).use { it.readBytes() }
                val local = blobSha(data)
                val remote = if (treeOk) tree[path] else getSha(path, if (sendBranch) branch else null)
                if (remote == local) {
                    skipped++
                    log("[$i/$total] = $path (sama, dilewati)")
                    continue
                }
                try {
                    if (putFile(path, data, remote, branch, sendBranch)) {
                        pushed++
                        log("[$i/$total] ✓ ${if (remote != null) "Update" else "Create"} $path")
                    } else skipped++
                    sendBranch = true
                    tree[path] = local
                } catch (e: ApiError) {
                    failed++
                    log("[$i/$total] ✗ $path → ${e.message}")
                }
                if (i < total) {
                    val sec = if (hi > lo) Random.nextDouble(lo, hi) else lo
                    nap((sec * 1000).toLong())
                }
            }
            progress(total, total)
            val s = "Selesai: $pushed commit, $skipped dilewati, $failed gagal"
            log(s)
            s
        }
    }
}
