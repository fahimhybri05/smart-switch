#pragma once

// Offline control page served at http://192.168.4.1/ — basic on/off
// control, offline schedules (local_schedule.h) and WiFi setup with a
// nearby-network list. Served ONLY while wifiProvisioningIsLocalMode()
// (hotspot up, no WiFi connection); otherwise GET / is a short notice and
// every /local/* endpoint answers 403. Registered from httpApiBegin().
void localWebRegister();
