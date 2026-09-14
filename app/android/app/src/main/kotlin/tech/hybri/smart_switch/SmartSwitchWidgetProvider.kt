package tech.hybri.smart_switch

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import es.antonborri.home_widget.HomeWidgetBackgroundIntent
import es.antonborri.home_widget.HomeWidgetLaunchIntent
import es.antonborri.home_widget.HomeWidgetProvider
import org.json.JSONArray

/// Renders up to 4 pinned switches (chosen in-app, Settings > Home screen
/// widget) as tappable rows. Each row's data is written by
/// widget_service.dart via HomeWidget.saveWidgetData; a tap fires a
/// HomeWidgetBackgroundIntent that a headless Dart isolate handles by
/// calling the device directly over HTTP (no full app launch needed).
class SmartSwitchWidgetProvider : HomeWidgetProvider() {
    private val rowIds = intArrayOf(R.id.row0, R.id.row1, R.id.row2, R.id.row3)

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
        widgetData: SharedPreferences,
    ) {
        val pinnedJson = widgetData.getString("pinned_switches", null)
        val pinned = try {
            if (pinnedJson != null) JSONArray(pinnedJson) else JSONArray()
        } catch (e: Exception) {
            JSONArray()
        }

        appWidgetIds.forEach { widgetId ->
            val views = RemoteViews(context.packageName, R.layout.widget_smart_switch)
            views.setOnClickPendingIntent(
                R.id.widget_title,
                HomeWidgetLaunchIntent.getActivity(context, MainActivity::class.java),
            )

            for (i in rowIds.indices) {
                if (i < pinned.length()) {
                    val entry = pinned.getJSONObject(i)
                    val name = entry.optString("switch_name", "Switch")
                    val state = entry.optString("state", "OFF")
                    val deviceId = entry.optString("device_id")
                    val ip = entry.optString("last_known_ip")
                    val channelIdx = entry.optInt("channel_idx")

                    views.setTextViewText(rowIds[i], "$name — $state")
                    views.setViewVisibility(rowIds[i], View.VISIBLE)

                    val uri = Uri.parse(
                        "smartswitch://toggle" +
                            "?device_id=${Uri.encode(deviceId)}" +
                            "&ip=${Uri.encode(ip)}" +
                            "&channel_idx=$channelIdx" +
                            "&current_state=${Uri.encode(state)}",
                    )
                    views.setOnClickPendingIntent(
                        rowIds[i],
                        HomeWidgetBackgroundIntent.getBroadcast(context, uri),
                    )
                } else {
                    views.setViewVisibility(rowIds[i], View.GONE)
                }
            }

            appWidgetManager.updateAppWidget(widgetId, views)
        }
    }
}
