package tech.hybri.smart_switch

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import es.antonborri.home_widget.HomeWidgetBackgroundIntent
import org.json.JSONArray
import org.json.JSONObject

/// Shared rendering for both home-screen widgets. Switch data comes from
/// the `pinned_switches` JSON that widget_service.dart writes (name, state,
/// device_id, channel_idx, optional last_known_ip).
object WidgetRender {
    const val PREFS = "HomeWidgetPreferences"

    fun pinned(widgetData: SharedPreferences): List<JSONObject> {
        val raw = widgetData.getString("pinned_switches", null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { arr.getJSONObject(it) }
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun keyOf(entry: JSONObject) = "${entry.optString("device_id")}:${entry.optInt("channel_idx")}"

    fun isOn(entry: JSONObject) = entry.optString("state", "OFF") == "ON"

    /// Same name-keyword mapping as the app's DeviceVisualKind.fromName.
    fun iconFor(name: String): Int {
        val n = name.lowercase()
        return when {
            "led" in n || "strip" in n -> R.drawable.ic_widget_strip
            "fish" in n || "tank" in n || "aquarium" in n -> R.drawable.ic_widget_aquarium
            "pump" in n || "water" in n -> R.drawable.ic_widget_pump
            "motor" in n -> R.drawable.ic_widget_motor
            "fan" in n -> R.drawable.ic_widget_fan
            "multi" in n || "power strip" in n -> R.drawable.ic_widget_socket
            "tv" in n || "television" in n -> R.drawable.ic_widget_tv
            "router" in n || "wifi" in n -> R.drawable.ic_widget_router
            "plug" in n -> R.drawable.ic_widget_plug
            "socket" in n || "outlet" in n -> R.drawable.ic_widget_socket
            "light" in n || "lamp" in n || "bulb" in n -> R.drawable.ic_widget_light
            else -> R.drawable.ic_widget_power
        }
    }

    /// Paints one switch tile (background, icon circle, icon tint, texts)
    /// and wires a tap on [tileId] to the headless toggle callback.
    fun bindTile(
        context: Context,
        views: RemoteViews,
        entry: JSONObject,
        tileId: Int,
        circleId: Int,
        iconId: Int,
        nameId: Int,
        stateId: Int,
    ) {
        val on = isOn(entry)
        val name = entry.optString("switch_name", "Switch")
        views.setInt(tileId, "setBackgroundResource", if (on) R.drawable.widget_tile_on else R.drawable.widget_tile_off)
        views.setInt(circleId, "setBackgroundResource", if (on) R.drawable.widget_circle_on else R.drawable.widget_circle_off)
        views.setImageViewResource(iconId, iconFor(name))
        views.setInt(iconId, "setColorFilter", color(context, if (on) R.color.widget_icon_on else R.color.widget_icon_off))
        views.setTextViewText(nameId, name)
        views.setTextColor(nameId, color(context, if (on) R.color.widget_text_on else R.color.widget_text))
        views.setTextViewText(stateId, if (on) "On" else "Off")
        views.setTextColor(stateId, color(context, if (on) R.color.widget_text_on else R.color.widget_text_muted))
        views.setOnClickPendingIntent(tileId, HomeWidgetBackgroundIntent.getBroadcast(context, toggleUri(entry)))
    }

    fun toggleUri(entry: JSONObject): Uri = Uri.parse(
        "smartswitch://toggle" +
            "?device_id=${Uri.encode(entry.optString("device_id"))}" +
            "&ip=${Uri.encode(entry.optString("last_known_ip"))}" +
            "&channel_idx=${entry.optInt("channel_idx")}" +
            "&current_state=${Uri.encode(entry.optString("state", "OFF"))}",
    )

    private fun color(context: Context, res: Int) = ContextCompat.getColor(context, res)
}
