package tech.hybri.smart_switch

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import es.antonborri.home_widget.HomeWidgetProvider

/// One switch per widget instance, picked in SingleSwitchConfigureActivity
/// when the widget is added. The choice is stored as
/// `single_widget_<appWidgetId>` = "deviceId:channelIdx" in the same prefs
/// widget_service.dart writes pinned switch states into.
class SingleSwitchWidgetProvider : HomeWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
        widgetData: SharedPreferences,
    ) {
        val pinned = WidgetRender.pinned(widgetData)
        appWidgetIds.forEach { widgetId ->
            val views = RemoteViews(context.packageName, R.layout.widget_single_switch)
            val key = widgetData.getString(prefKey(widgetId), null)
            val entry = pinned.firstOrNull { WidgetRender.keyOf(it) == key }
            if (entry != null) {
                WidgetRender.bindTile(
                    context, views, entry,
                    R.id.single_root, R.id.single_circle, R.id.single_icon, R.id.single_name, R.id.single_state,
                )
            } else {
                // Not configured yet, or the switch was unpinned in the app —
                // tapping reopens the picker.
                views.setInt(R.id.single_root, "setBackgroundResource", R.drawable.widget_tile_off)
                views.setTextViewText(R.id.single_name, "Choose a switch")
                views.setTextViewText(R.id.single_state, "Tap to set up")
                views.setInt(
                    R.id.single_icon, "setColorFilter",
                    ContextCompat.getColor(context, R.color.widget_icon_off),
                )
                views.setOnClickPendingIntent(R.id.single_root, configureIntent(context, widgetId))
            }
            appWidgetManager.updateAppWidget(widgetId, views)
        }
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        val prefs = context.getSharedPreferences(WidgetRender.PREFS, Context.MODE_PRIVATE).edit()
        appWidgetIds.forEach { prefs.remove(prefKey(it)) }
        prefs.apply()
    }

    private fun configureIntent(context: Context, widgetId: Int): PendingIntent {
        val intent = Intent(context, SingleSwitchConfigureActivity::class.java).apply {
            putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return PendingIntent.getActivity(
            context, widgetId, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        fun prefKey(widgetId: Int) = "single_widget_$widgetId"
    }
}
