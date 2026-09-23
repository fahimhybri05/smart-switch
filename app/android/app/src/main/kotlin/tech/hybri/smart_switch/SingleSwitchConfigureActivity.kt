package tech.hybri.smart_switch

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.TextView

/// Opens when a single-switch widget is added (or reconfigured): lists the
/// switches pinned in the app and saves the chosen one for this widget.
class SingleSwitchConfigureActivity : Activity() {
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Cancelled (back pressed) unless a switch is picked below.
        setResult(RESULT_CANCELED)
        widgetId = intent?.extras?.getInt(
            AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID,
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        title = "Choose a switch"

        val prefs = getSharedPreferences(WidgetRender.PREFS, Context.MODE_PRIVATE)
        val pinned = WidgetRender.pinned(prefs)
        if (pinned.isEmpty()) {
            setContentView(TextView(this).apply {
                text = "No pinned switches yet.\n\nOpen Smart Switch → Settings → Pinned switches, pin a switch, then add this widget again."
                textSize = 16f
                setPadding(48, 48, 48, 48)
            })
            return
        }

        val list = ListView(this)
        list.adapter = ArrayAdapter(
            this, android.R.layout.simple_list_item_1,
            pinned.map { it.optString("switch_name", "Switch") },
        )
        list.setOnItemClickListener { _, _, position, _ ->
            prefs.edit()
                .putString(SingleSwitchWidgetProvider.prefKey(widgetId), WidgetRender.keyOf(pinned[position]))
                .apply()
            refreshWidget()
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
            finish()
        }
        setContentView(list)
    }

    private fun refreshWidget() {
        val intent = Intent(this, SingleSwitchWidgetProvider::class.java).apply {
            action = AppWidgetManager.ACTION_APPWIDGET_UPDATE
            putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, intArrayOf(widgetId))
        }
        sendBroadcast(intent)
    }
}
