package tech.hybri.smart_switch

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/// Android silently drops incoming multicast packets unless the app holds a
/// WifiManager.MulticastLock — the `multicast_dns` package doesn't acquire
/// this itself, so mDNS discovery finds nothing on a real device without it.
class MainActivity : FlutterActivity() {
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

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
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
