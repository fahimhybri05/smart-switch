package tech.hybri.smart_switch

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/// Android silently drops incoming multicast packets unless the app holds a
/// WifiManager.MulticastLock — the `multicast_dns` package doesn't acquire
/// this itself, so mDNS discovery finds nothing on a real device without it.
// FlutterFragmentActivity (not FlutterActivity): local_auth's biometric
// prompt is a fragment and needs a FragmentActivity host.
class MainActivity : FlutterFragmentActivity() {
    private val multicastChannelName = "tech.hybri.smart_switch/multicast_lock"
    private var multicastLock: WifiManager.MulticastLock? = null

    // Android deprioritizes (and often fully routes app traffic away from) a
    // WiFi network with no internet access — e.g. an ESP32's SoftAP — even
    // while the phone shows as "connected" to it in system settings. Without
    // explicitly binding this process to that network, HTTP calls during
    // provisioning silently go out over mobile data instead and never reach
    // the device. See lib/services/provisioning/network_binding.dart.
    private val networkChannelName = "tech.hybri.smart_switch/network_binding"
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    // Widget taps run while the app is in the background, where Battery
    // Saver / app standby block this app's network entirely unless it's on
    // the battery-optimization allowlist. See lib/services/battery_exemption.dart.
    private val batteryChannelName = "tech.hybri.smart_switch/battery"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestHighRefreshRate()
    }

    override fun onResume() {
        super.onResume()
        // Some OEM skins drop the preference when the app comes back.
        requestHighRefreshRate()
    }

    // Many Android phones (Samsung, OnePlus, Xiaomi…) keep apps at 60 Hz
    // unless the window asks for more. Pick the fastest mode the panel offers
    // at its current resolution — 90/120/144 Hz where available. The system
    // can still lower it (battery saver, user's "standard" motion setting).
    private fun requestHighRefreshRate() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val display = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            display
        } else {
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay
        } ?: return
        val current = display.mode
        val best = display.supportedModes
            .filter {
                it.physicalWidth == current.physicalWidth &&
                    it.physicalHeight == current.physicalHeight
            }
            .maxByOrNull { it.refreshRate } ?: return
        val attrs = window.attributes
        if (attrs.preferredDisplayModeId != best.modeId) {
            attrs.preferredDisplayModeId = best.modeId
            window.attributes = attrs
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, batteryChannelName).setMethodCallHandler { call, result ->
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            when (call.method) {
                "isExempt" -> result.success(pm.isIgnoringBatteryOptimizations(packageName))
                "requestExemption" -> {
                    if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                        startActivity(
                            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                                .setData(Uri.parse("package:$packageName")),
                        )
                    }
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, multicastChannelName).setMethodCallHandler { call, result ->
            when (call.method) {
                "acquire" -> {
                    if (multicastLock == null) {
                        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                        multicastLock = wifi.createMulticastLock("smart_switch_mdns").apply {
                            setReferenceCounted(true)
                        }
                    }
                    multicastLock?.acquire()
                    result.success(null)
                }
                "release" -> {
                    multicastLock?.let { if (it.isHeld) it.release() }
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, networkChannelName).setMethodCallHandler { call, result ->
            when (call.method) {
                "bindToWifi" -> bindProcessToCurrentWifi(result)
                "unbindNetwork" -> {
                    unbindNetwork()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun bindProcessToCurrentWifi(result: MethodChannel.Result) {
        val cm = applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

        unbindNetwork() // drop any stale binding from a previous attempt first

        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        var replied = false
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                cm.bindProcessToNetwork(network)
                if (!replied) {
                    replied = true
                    result.success(true)
                }
            }

            override fun onUnavailable() {
                if (!replied) {
                    replied = true
                    result.success(false)
                }
            }
        }
        networkCallback = callback
        // 3-arg overload auto-fires onUnavailable() if nothing matches within
        // the timeout, so this can never hang the Dart-side await forever.
        cm.requestNetwork(request, callback, 8000)
    }

    private fun unbindNetwork() {
        val cm = applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        cm.bindProcessToNetwork(null)
        networkCallback?.let {
            try {
                cm.unregisterNetworkCallback(it)
            } catch (_: IllegalArgumentException) {
                // already unregistered — fine
            }
        }
        networkCallback = null
    }
}
