package id.kev.gitpusher

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.text.InputType
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var token: EditText
    private lateinit var repo: Spinner
    private lateinit var branch: EditText
    private lateinit var dMin: EditText
    private lateinit var dMax: EditText
    private lateinit var zipName: TextView
    private lateinit var go: Button
    private lateinit var logView: TextView
    private lateinit var scroll: ScrollView
    private var zip: Uri? = null
    private val prefs by lazy { getSharedPreferences("gp", MODE_PRIVATE) }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
    private fun label(t: String) = TextView(this).apply {
        text = t; textSize = 12f; setPadding(0, dp(14), 0, dp(2))
    }
    private fun field(h: String, v: String) = EditText(this).apply {
        this.hint = h; setText(v); setSingleLine()
    }

    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(28), dp(16), dp(24))
        }
        val head = LinearLayout(this).apply { gravity = android.view.Gravity.CENTER_VERTICAL }
        head.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_stat_github)
            setColorFilter(Color.parseColor("#24292F"))
        }, LinearLayout.LayoutParams(dp(36), dp(36)).apply { rightMargin = dp(10) })
        head.addView(TextView(this).apply { text = getString(R.string.app_name); textSize = 26f; typeface = Typeface.DEFAULT_BOLD })
        col.addView(head)

        col.addView(label("GitHub Personal Token"))
        token = field("ghp_... / github_pat_...", prefs.getString("token", "") ?: "")
        token.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        col.addView(token)
        col.addView(Button(this).apply { text = "Connect"; setOnClickListener { connect() } })

        col.addView(label("Repo tujuan"))
        repo = Spinner(this)
        col.addView(repo)

        col.addView(label("Branch (kosong = default)"))
        branch = field("main", prefs.getString("branch", "") ?: "")
        col.addView(branch)

        col.addView(label("Jeda antar commit (detik): min / max"))
        dMin = field("4", prefs.getString("dmin", "4") ?: "4")
        dMax = field("9", prefs.getString("dmax", "9") ?: "9")
        for (e in listOf(dMin, dMax)) e.inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
        val row = LinearLayout(this)
        row.addView(dMin, LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(dMax, LinearLayout.LayoutParams(0, -2, 1f))
        col.addView(row)

        col.addView(label("File ZIP"))
        zipName = TextView(this).apply { text = "(belum dipilih)" }
        col.addView(zipName)
        col.addView(Button(this).apply {
            text = "Pilih ZIP"
            setOnClickListener {
                startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_MIME_TYPES,
                        arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream"))
                }, 7)
            }
        })

        go = Button(this).apply { setOnClickListener { toggle() } }
        col.addView(go)

        logView = TextView(this).apply {
            typeface = Typeface.MONOSPACE; textSize = 11f
            setTextColor(Color.parseColor("#00ff66"))
            setBackgroundColor(Color.parseColor("#0d1117"))
            setPadding(dp(10), dp(10), dp(10), dp(10))
            minHeight = dp(160)
            setTextIsSelectable(true)
        }
        col.addView(logView, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(16) })

        scroll = ScrollView(this).apply { addView(col) }
        setContentView(scroll)
    }

    private fun connect() {
        val t = token.text.toString().trim()
        if (t.isEmpty()) return toast("Isi token dulu")
        prefs.edit().putString("token", t).apply()
        toast("Menghubungkan...")
        Thread {
            try {
                val list = Gh.repos(t)
                runOnUiThread {
                    repo.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, list)
                    toast("${list.size} repo ditemukan")
                }
            } catch (e: Exception) {
                runOnUiThread { toast(e.message ?: "Gagal") }
            }
        }.start()
    }

    private fun toggle() {
        if (PushState.running) {
            startService(Intent(this, PushService::class.java).setAction("STOP"))
            return
        }
        val r = repo.selectedItem as? String ?: return toast("Connect & pilih repo dulu")
        val z = zip ?: return toast("Pilih ZIP dulu")
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)

        val dmin = dMin.text.toString().toDoubleOrNull() ?: 4.0
        val dmax = dMax.text.toString().toDoubleOrNull() ?: 9.0
        prefs.edit().putString("branch", branch.text.toString())
            .putString("dmin", dMin.text.toString()).putString("dmax", dMax.text.toString()).apply()

        startForegroundService(Intent(this, PushService::class.java)
            .putExtra("token", token.text.toString().trim())
            .putExtra("repo", r)
            .putExtra("branch", branch.text.toString().trim())
            .putExtra("dmin", dmin)
            .putExtra("dmax", dmax)
            .putExtra("zip", z.toString()))
    }

    private fun refresh() {
        logView.text = PushState.text()
        go.text = if (PushState.running) "Hentikan" else "Mulai Push (1 per 1)"
        scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
    }

    override fun onResume() {
        super.onResume()
        PushState.listener = { runOnUiThread { refresh() } }
        refresh()
    }

    override fun onPause() {
        super.onPause()
        PushState.listener = null
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(req: Int, res: Int, data: Intent?) {
        super.onActivityResult(req, res, data)
        val u = data?.data
        if (req == 7 && res == RESULT_OK && u != null) {
            try { contentResolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            catch (_: Exception) {}
            zip = u
            contentResolver.query(u, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) zipName.text = c.getString(c.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME))
            }
        }
    }
}
