package id.kev.gitpusher

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import java.io.File

/** Status bersama antara service dan layar. */
object PushState {
    private val lines = mutableListOf<String>()
    @Volatile var running = false
    @Volatile var listener: (() -> Unit)? = null

    @Synchronized fun add(s: String) {
        lines.add(s)
        if (lines.size > 400) lines.removeAt(0)
        listener?.invoke()
    }
    @Synchronized fun text(): String = lines.joinToString("\n")
    @Synchronized fun clear() = lines.clear()
    fun setRunning(v: Boolean) { running = v; listener?.invoke() }
}

/** Foreground service: push tetap jalan saat aplikasi ditutup / layar mati. */
class PushService : Service() {
    companion object { const val CH = "push" }

    @Volatile private var stop = false

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(i: Intent?, flags: Int, startId: Int): Int {
        if (i?.action == "STOP") { stop = true; return START_NOT_STICKY }

        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH, "Git Pusher", NotificationManager.IMPORTANCE_LOW))
        val n = notif("Menyiapkan...", 0, 0, true)
        if (Build.VERSION.SDK_INT >= 29)
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(1, n)

        if (i == null || PushState.running) { if (i == null) stopSelf(); return START_NOT_STICKY }
        stop = false
        PushState.clear()
        PushState.setRunning(true)
        Thread { work(i) }.start()
        return START_NOT_STICKY
    }

    private fun notif(text: String, done: Int, total: Int, ongoing: Boolean): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val b = Notification.Builder(this, CH)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Git Pusher")
            .setContentText(text)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
        if (ongoing) {
            b.setProgress(total, done, total == 0)
            val stopPi = PendingIntent.getService(this, 1,
                Intent(this, PushService::class.java).setAction("STOP"), PendingIntent.FLAG_IMMUTABLE)
            @Suppress("DEPRECATION")
            b.addAction(Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPi).build())
        }
        return b.build()
    }

    private fun work(i: Intent) {
        val nm = getSystemService(NotificationManager::class.java)
        val wake = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gitpusher:push")
        wake.acquire(6 * 60 * 60 * 1000L)
        var summary: String
        try {
            val tmp = File(cacheDir, "in.zip")
            contentResolver.openInputStream(Uri.parse(i.getStringExtra("zip")))!!.use { a ->
                tmp.outputStream().use { a.copyTo(it) }
            }
            val p = Pusher(
                token = i.getStringExtra("token") ?: "",
                repo = i.getStringExtra("repo") ?: "",
                branchIn = i.getStringExtra("branch") ?: "",
                dMin = i.getDoubleExtra("dmin", 4.0),
                dMax = i.getDoubleExtra("dmax", 9.0),
                log = { PushState.add(it) },
                progress = { d, t -> nm.notify(1, notif("$d/$t file", d, t, true)) },
                cancelled = { stop },
            )
            summary = p.run(tmp)
            tmp.delete()
        } catch (e: Pusher.Stop) {
            summary = "Dihentikan"
            PushState.add("■ Dihentikan")
        } catch (e: Exception) {
            summary = "Error: ${e.message}"
            PushState.add("✗ $summary")
        } finally {
            if (wake.isHeld) wake.release()
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        nm.notify(2, notif(summary, 0, 0, false))
        PushState.setRunning(false)
        stopSelf()
    }
}
