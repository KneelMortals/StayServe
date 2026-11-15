package com.stayserve.stayserve

import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        createNotificationChannels()
    }

    /**
     * Creates the channel the push messages are posted to.
     *
     * The server sends every push message with
     * `channelId: "stayserve_notifications"` — but a channel is **not**
     * something the system creates on its own. Without this method the
     * channel never existed, and Android dropped every message into the
     * fallback channel of the Firebase SDK: no name, no description and the
     * default importance, so the notifications looked like they came from
     * nobody and were easy to miss.
     *
     * The channel is created natively (and not with `flutter_local_notifications`)
     * because it has to exist **before** the first message arrives — the
     * channel of a message that is posted while the app is closed is
     * created by the system from the metadata of the manifest, and the
     * settings of the channel (the name the user sees, the vibration) can
     * only be set while the app is running.
     */
    private fun createNotificationChannels() {
        // Channels only exist from Android 8 (Oreo) on. On older versions
        // the channel of a notification is ignored by the system.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = getSystemService(NotificationManager::class.java) ?: return

        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "StayServe notifications",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Bookings, payments, requests and messages"
            enableVibration(true)
            setShowBadge(true)
        }

        manager.createNotificationChannel(channel)
    }

    companion object {
        /**
         * The id of the channel — the **same** id the server uses
         * (`functions/src/notifications.ts`).
         */
        const val NOTIFICATION_CHANNEL_ID = "stayserve_notifications"
    }
}
