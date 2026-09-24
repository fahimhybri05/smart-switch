package tech.hybri.smart_switch

import android.content.Context
import android.content.SharedPreferences
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import es.antonborri.home_widget.HomeWidgetBackgroundIntent
import org.json.JSONObject

/// Quick Settings tile that toggles the FIRST pinned switch. It reads the
/// same `pinned_switches` data the home-screen widgets render from and sends
/// the same headless toggle broadcast a widget tap does (widget_service.dart
/// → widgetInteractionCallback), so there is one control path for all of them.
class SwitchTileService : TileService() {
    private val prefs: SharedPreferences
        get() = getSharedPreferences(WidgetRender.PREFS, Context.MODE_PRIVATE)

    // The Dart side rewrites pinned_switches after every toggle / refresh;
    // repaint while the shade is open so the tile follows the real state.
    private val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == "pinned_switches") render()
    }

    override fun onStartListening() {
        super.onStartListening()
        prefs.registerOnSharedPreferenceChangeListener(listener)
        render()
    }

    override fun onStopListening() {
        prefs.unregisterOnSharedPreferenceChangeListener(listener)
        super.onStopListening()
    }

    override fun onClick() {
        super.onClick()
        val entry = target() ?: return
        // Never switch a pump or motor from a locked phone without unlocking.
        if (isLocked) unlockAndRun { toggle(entry) } else toggle(entry)
    }

    private fun target(): JSONObject? = WidgetRender.pinned(prefs).firstOrNull()

    private fun toggle(entry: JSONObject) {
        // Instant feedback; the prefs listener corrects it once the device answers.
        qsTile?.let {
            it.state = if (WidgetRender.isOn(entry)) Tile.STATE_INACTIVE else Tile.STATE_ACTIVE
            it.updateTile()
        }
        try {
            HomeWidgetBackgroundIntent.getBroadcast(this, WidgetRender.toggleUri(entry)).send()
        } catch (e: Exception) {
            render()
        }
    }

    private fun render() {
        val tile = qsTile ?: return
        val entry = target()
        if (entry == null) {
            tile.label = "Smart Control"
            tile.state = Tile.STATE_UNAVAILABLE
            tile.icon = Icon.createWithResource(this, R.drawable.ic_widget_power)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) tile.subtitle = "Pin a switch in the app"
        } else {
            val name = entry.optString("switch_name", "Switch")
            val on = WidgetRender.isOn(entry)
            tile.label = name
            tile.state = if (on) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
            tile.icon = Icon.createWithResource(this, WidgetRender.iconFor(name))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) tile.subtitle = if (on) "On" else "Off"
        }
        tile.updateTile()
    }

}
