package com.kevsoft.gittools;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/** Jembatan JS -> foreground service. Dipanggil sebagai Capacitor.registerPlugin('BgService'). */
@CapacitorPlugin(
        name = "BgService",
        permissions = {@Permission(alias = "notifications", strings = {"android.permission.POST_NOTIFICATIONS"})}
)
public class BgServicePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        // Jangan menunggu dialog izin: layanan tetap jalan, JS langsung lanjut.
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED
                && getActivity() != null) {
            try {
                ActivityCompat.requestPermissions(getActivity(),
                        new String[]{"android.permission.POST_NOTIFICATIONS"}, 4711);
            } catch (Exception ignored) { }
        }
        launch(call);
    }

    @PluginMethod
    public void update(PluginCall call) {
        launch(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        ctx.stopService(new Intent(ctx, BgService.class));

        String text = call.getString("text");
        if (text != null) {
            try {
                BgService.ensureChannels(ctx);
                NotificationManagerCompat.from(ctx).notify(BgService.ID_DONE,
                        new NotificationCompat.Builder(ctx, BgService.CH_DONE)
                                .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                                .setContentTitle("kev-git")
                                .setContentText(text)
                                .setAutoCancel(true)
                                .setContentIntent(BgService.openAppIntent(ctx))
                                .build());
            } catch (Exception ignored) {
                // izin notifikasi ditolak: abaikan
            }
        }
        call.resolve();
    }

    private void launch(PluginCall call) {
        try {
            Context ctx = getContext();
            Intent i = new Intent(ctx, BgService.class);
            i.putExtra("text", call.getString("text", "Berjalan di latar belakang"));
            ContextCompat.startForegroundService(ctx, i);
            call.resolve();
        } catch (Exception e) {
            // Jangan sampai gagal start service menahan proses upload
            call.resolve();
        }
    }
}
