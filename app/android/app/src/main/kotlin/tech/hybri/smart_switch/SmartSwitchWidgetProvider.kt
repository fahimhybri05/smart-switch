package tech.hybri.smart_switch

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.SharedPreferences
import android.view.View
import android.widget.RemoteViews
import es.antonborri.home_widget.HomeWidgetLaunchIntent
import es.antonborri.home_widget.HomeWidgetProvider

/// Up to 4 pinned switches (Settings > Pinned switches) as a 2x2 grid of
/// tiles. A tile tap toggles the switch through widget_service.dart's
/// headless isolate; the header opens the app.
class SmartSwitchWidgetProvider : HomeWidgetProvider() {
    private val tiles = arrayOf(
        intArrayOf(R.id.tile0, R.id.circle0, R.id.icon0, R.id.name0, R.id.state0),
        intArrayOf(R.id.tile1, R.id.circle1, R.id.icon1, R.id.name1, R.id.state1),
        intArrayOf(R.id.tile2, R.id.circle2, R.id.icon2, R.id.name2, R.id.state2),
        intArrayOf(R.id.tile3, R.id.circle3, R.id.icon3, R.id.name3, R.id.state3),
    )

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
        widgetData: SharedPreferences,
    ) {
        val pinned = WidgetRender.pinned(widgetData).take(tiles.size)
        appWidgetIds.forEach { widgetId ->
            val views = RemoteViews(context.packageName, R.layout.widget_smart_switch)
            views.setOnClickPendingIntent(
                R.id.widget_header,
                HomeWidgetLaunchIntent.getActivity(context, MainActivity::class.java),
            )

            val empty = pinned.isEmpty()
            views.setViewVisibility(R.id.widget_empty, if (empty) View.VISIBLE else View.GONE)
            views.setViewVisibility(R.id.grid_row0, if (empty) View.GONE else View.VISIBLE)
            views.setViewVisibility(R.id.grid_row1, if (pinned.size > 2) View.VISIBLE else View.GONE)
            val onCount = pinned.count { WidgetRender.isOn(it) }
            views.setTextViewText(R.id.widget_summary, if (empty) "" else "$onCount of ${pinned.size} on")

            tiles.forEachIndexed { i, ids ->
                if (i < pinned.size) {
                    views.setViewVisibility(ids[0], View.VISIBLE)
                    WidgetRender.bindTile(context, views, pinned[i], ids[0], ids[1], ids[2], ids[3], ids[4])
                } else {
                    // INVISIBLE (not GONE) keeps a lone tile at half width.
                    views.setViewVisibility(ids[0], View.INVISIBLE)
                }
            }
            appWidgetManager.updateAppWidget(widgetId, views)
        }
    }
}
