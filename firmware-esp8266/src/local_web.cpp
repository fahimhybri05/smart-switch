#include "local_web.h"

#include <ArduinoJson.h>
#include <uri/UriBraces.h>

#include "channel_control.h"
#include "cloud_client.h"
#include "config_store.h"
#include "http_api.h"
#include "local_schedule.h"
#include "relay_hal.h"
#include "wifi_provisioning.h"

// No auth beyond the hotspot's WPA2 password (SS_AP_PASSWORD) — same trust
// boundary as the existing SoftAP provisioning endpoint. Backend-only rules
// (switch locks, min-off time) aren't enforced here: offline control is
// the same "device owns its relays" exception as a physical wall switch.

static bool requireLocalMode() {
  if (wifiProvisioningIsLocalMode()) return true;
  httpServer.send(403, "application/json",
                  "{\"error\":\"offline controls are only available on the device hotspot "
                  "while it has no WiFi connection\"}");
  return false;
}

static void sendError(int status, const String &msg) {
  JsonDocument doc;
  doc["error"] = msg;
  String out;
  serializeJson(doc, out);
  httpServer.send(status, "application/json", out);
}

static void handleState() {
  if (!requireLocalMode()) return;
  const SsConfig &cfg = configStore.cfg();
  JsonDocument doc;
  doc["device_id"] = cfg.device_id;
  doc["cloud"] = cloudClientIsConnected();
  doc["interlock"] = cfg.interlockEnabled;
  JsonObject clock = doc["clock"].to<JsonObject>();
  clock["valid"] = localClockValid();
  clock["utc"] = (long)localClockNowUtc();
  clock["tz"] = localClockTzOffsetMin();
  JsonArray chans = doc["channels"].to<JsonArray>();
  for (uint8_t i = 0; i < relayHalChannelCount(); i++) {
    JsonObject c = chans.add<JsonObject>();
    c["idx"] = i;
    const char *name = "";
    for (uint8_t j = 0; j < cfg.channelHwCount; j++) {
      if (cfg.channelHw[j].channel_idx == i) { name = cfg.channelHw[j].name; break; }
    }
    c["name"] = name;
    c["on"] = relayHalGetState(i);
  }
  String out;
  serializeJson(doc, out);
  httpServer.send(200, "application/json", out);
}

static void handleSetChannel() {
  if (!requireLocalMode()) return;
  int idx = httpServer.pathArg(0).toInt();
  if (httpServer.pathArg(0).length() == 0 || idx < 0 || idx >= relayHalChannelCount()) {
    sendError(400, "invalid channel");
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, httpServer.arg("plain")) != DeserializationError::Ok ||
      !doc["on"].is<bool>()) {
    sendError(400, "expected {\"on\": true|false}");
    return;
  }
  channelControlSetState((uint8_t)idx, doc["on"].as<bool>());
  httpServer.send(200, "application/json", "{\"ok\":true}");
}

static void handleAllOff() {
  if (!requireLocalMode()) return;
  for (uint8_t i = 0; i < relayHalChannelCount(); i++) {
    if (relayHalGetState(i)) channelControlSetState(i, false);
  }
  httpServer.send(200, "application/json", "{\"ok\":true}");
}

static void handleListSchedules() {
  if (!requireLocalMode()) return;
  httpServer.send(200, "application/json", localScheduleListJson());
}

static void handleUpsertSchedule() {
  if (!requireLocalMode()) return;
  JsonDocument doc;
  if (deserializeJson(doc, httpServer.arg("plain")) != DeserializationError::Ok) {
    sendError(400, "invalid JSON");
    return;
  }
  String err;
  if (!localScheduleUpsert(doc.as<JsonVariantConst>(), &err)) {
    sendError(400, err);
    return;
  }
  httpServer.send(200, "application/json", localScheduleListJson());
}

static void handleDeleteSchedule() {
  if (!requireLocalMode()) return;
  if (!localScheduleDelete((uint16_t)httpServer.pathArg(0).toInt())) {
    sendError(404, "schedule not found");
    return;
  }
  httpServer.send(200, "application/json", localScheduleListJson());
}

static void handleSetTime() {
  if (!requireLocalMode()) return;
  JsonDocument doc;
  if (deserializeJson(doc, httpServer.arg("plain")) != DeserializationError::Ok) {
    sendError(400, "invalid JSON");
    return;
  }
  long epoch = doc["epoch"] | 0L;
  int tz = doc["tz"] | 0;
  if (epoch < 1700000000L || tz < -720 || tz > 840) {
    sendError(400, "expected {\"epoch\": <utc seconds>, \"tz\": <minutes east of UTC>}");
    return;
  }
  localClockSet((time_t)epoch, (int16_t)tz);
  httpServer.send(200, "application/json", "{\"ok\":true}");
}

static const char ONLINE_PAGE[] PROGMEM = R"HTML(<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Smart Switch</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#222}</style>
</head><body><h3>Smart Switch</h3>
<p>This device is online. Use the Smart Switch app to control it.</p>
<p>The offline control page appears here only when the device can't reach
its WiFi and opens its own hotspot.</p></body></html>)HTML";

static const char LOCAL_PAGE[] PROGMEM = R"HTML(<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Smart Switch (offline)</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d1f23;--mut:#6b7280;--acc:#2563eb;--on:#16a34a;--bd:#e5e7eb;--err:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#111318;--card:#1b1e25;--fg:#e8eaed;--mut:#9aa0a6;--bd:#2c3038}}
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:12px}
.w{max-width:520px;margin:0 auto}h1{font-size:20px;margin:4px 0}h2{font-size:16px;margin:0 0 10px}
.c{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px;margin:12px 0}
.m{color:var(--mut);font-size:13px}.row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--bd)}
.row:last-child{border-bottom:0}.g{flex:1;min-width:0}
button{font:inherit;border:0;border-radius:8px;padding:8px 14px;background:var(--acc);color:#fff;cursor:pointer}
button.s{background:transparent;color:var(--acc);border:1px solid var(--bd)}button:disabled{opacity:.5}
.t{width:64px;padding:8px 0;background:#9ca3af}.t.on{background:var(--on)}
input,select{font:inherit;padding:8px;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg);width:100%}
.f{display:grid;gap:8px}.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.days{display:flex;gap:4px;flex-wrap:wrap}.days label{font-size:13px;display:flex;align-items:center;gap:2px}
.days input{width:auto}.err{color:var(--err)}.net{cursor:pointer}.net:hover{background:var(--bg)}
</style></head><body><div class="w">
<h1>Smart Switch <span class="m" id="dev"></span></h1>
<div class="m" id="st">Loading…</div>

<div class="c"><h2>Switches</h2><div id="ch"></div>
<div style="margin-top:10px"><button class="s" onclick="allOff()">All off</button></div></div>

<div class="c"><h2>Offline schedules</h2>
<div class="m">Run only while the device can't reach the internet. Your normal
schedules in the app take over again once it's back online.</div>
<div id="sc" style="margin:8px 0"></div>
<div class="f">
<div class="two"><select id="sch"></select><select id="sact"><option value="1">Turn ON</option><option value="0">Turn OFF</option></select></div>
<input id="stime" type="time" value="07:00">
<div class="days" id="sdays"></div>
<button onclick="addSch()">Add schedule</button><div id="serr" class="err"></div>
</div></div>

<div class="c"><h2>Connect to WiFi</h2>
<div class="m" id="wst"></div>
<div id="nets" style="margin:8px 0"></div>
<div class="f">
<button class="s" onclick="scan(1)">Scan again</button>
<input id="ssid" placeholder="WiFi network name" autocomplete="off">
<input id="pw" type="password" placeholder="WiFi password (empty if open)">
<button onclick="connectWifi()">Connect</button>
</div></div>
</div>
<script>
var D=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],chans=[];
function $(i){return document.getElementById(i)}
function j(u,o){o=o||{};if(o.body)o.headers={'Content-Type':'application/json'};
return fetch(u,o).then(function(r){return r.json().then(function(b){if(!r.ok)throw new Error(b.error||r.status);return b})})}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return'&#'+c.charCodeAt(0)+';'})}
function nm(c){return c.name||('Switch '+(c.idx+1))}
function p2(n){return(n<10?'0':'')+n}
function state(){j('/local/state').then(function(s){
$('dev').textContent=s.device_id;
var t='Offline mode — hotspot';
t+=s.clock.valid?' · device clock '+new Date((s.clock.utc)*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):' · clock not set';
$('st').textContent=t;chans=s.channels;
$('ch').innerHTML=s.channels.map(function(c){return'<div class="row"><div class="g">'+esc(nm(c))+'</div><button class="t'+(c.on?' on':'')+'" onclick="tog('+c.idx+','+!c.on+')">'+(c.on?'ON':'OFF')+'</button></div>'}).join('');
var sel=$('sch'),v=sel.value;sel.innerHTML=s.channels.map(function(c){return'<option value="'+c.idx+'">'+esc(nm(c))+'</option>'}).join('');if(v)sel.value=v;
}).catch(function(e){$('st').textContent='Not available: '+e.message})}
function tog(i,on){j('/local/channels/'+i,{method:'POST',body:JSON.stringify({on:on})}).then(state).catch(function(e){alert(e.message)})}
function allOff(){j('/local/all-off',{method:'POST',body:'{}'}).then(state)}
function days(m){if(m==127)return'Every day';if(m==62)return'Weekdays';if(m==65)return'Weekends';
var o=[];for(var i=0;i<7;i++)if(m&(1<<i))o.push(D[i]);return o.join(' ')}
function chName(i){for(var k=0;k<chans.length;k++)if(chans[k].idx==i)return nm(chans[k]);return'Switch '+(i+1)}
function drawSch(r){var it=r.items;$('sc').innerHTML=it.length?it.map(function(s){
return'<div class="row"><div class="g"><b>'+p2(s.hour)+':'+p2(s.minute)+'</b> '+esc(chName(s.channel))+' → '+(s.on?'ON':'OFF')+'<div class="m">'+days(s.days)+(s.enabled?'':' · paused')+'</div></div>'+
'<button class="s" onclick=\'upd('+JSON.stringify(s)+')\'>'+(s.enabled?'Pause':'Resume')+'</button>'+
'<button class="s" onclick="del('+s.id+')">✕</button></div>'}).join(''):'<div class="m">No offline schedules yet.</div>'}
function loadSch(){j('/local/schedules').then(drawSch)}
function upd(s){s.enabled=!s.enabled;j('/local/schedules',{method:'POST',body:JSON.stringify(s)}).then(drawSch)}
function del(id){j('/local/schedules/'+id,{method:'DELETE'}).then(drawSch)}
function addSch(){var t=$('stime').value.split(':'),m=0;
for(var i=0;i<7;i++)if($('d'+i).checked)m|=1<<i;$('serr').textContent='';
j('/local/schedules',{method:'POST',body:JSON.stringify({channel:+$('sch').value,on:$('sact').value=='1',hour:+t[0],minute:+t[1],days:m,enabled:true})})
.then(drawSch).catch(function(e){$('serr').textContent=e.message})}
function bars(r){return r>=-55?'▂▄▆█':r>=-67?'▂▄▆':r>=-75?'▂▄':'▂'}
function scan(f){$('nets').innerHTML='<div class="m">Scanning…</div>';var n=0;
(function poll(){j('/api/wifi/scan'+(f&&n==0?'?refresh=1':'')).then(function(r){n++;
if(r.scanning&&n<10){setTimeout(poll,1500);return}
$('nets').innerHTML=r.networks.length?r.networks.map(function(w){return'<div class="row net" onclick=\'pick('+JSON.stringify(w.ssid)+')\'><div class="g">'+esc(w.ssid)+'</div><span class="m">'+(w.secure?'🔒 ':'')+bars(w.rssi)+'</span></div>'}).join(''):'<div class="m">No networks found.</div>'
}).catch(function(){n++;if(n<10)setTimeout(poll,1500)})})()}
function pick(s){$('ssid').value=s;$('pw').focus()}
function connectWifi(){var s=$('ssid').value.trim();if(!s)return;
j('/api/wifi',{method:'POST',body:JSON.stringify({ssid:s,password:$('pw').value})}).then(function(){
$('wst').textContent='Connecting to "'+s+'"… if it works this hotspot turns off and the device goes back online (reconnect your phone to your WiFi). If not, it stays here.';
var k=0;(function poll(){setTimeout(function(){j('/api/wifi').then(function(w){
if(w.state=='FAILED_ROLLED_BACK')$('wst').textContent='Could not join "'+s+'". Check the password and try again.';
else if(w.state=='TESTING'&&++k<12)poll();}).catch(function(){})},3000)})()
}).catch(function(e){$('wst').textContent=e.message})}
$('sdays').innerHTML=D.map(function(d,i){return'<label><input type="checkbox" id="d'+i+'" checked>'+d+'</label>'}).join('');
j('/local/time',{method:'POST',body:JSON.stringify({epoch:Math.floor(Date.now()/1000),tz:-new Date().getTimezoneOffset()})}).catch(function(){}).then(function(){state();loadSch()});
scan(0);setInterval(state,3000);
</script></body></html>)HTML";

static void handleRoot() {
  if (wifiProvisioningIsLocalMode()) {
    httpServer.send_P(200, "text/html; charset=utf-8", LOCAL_PAGE);
  } else {
    httpServer.send_P(200, "text/html; charset=utf-8", ONLINE_PAGE);
  }
}

void localWebRegister() {
  httpServer.on("/", HTTP_GET, handleRoot);
  httpServer.on("/local/state", HTTP_GET, handleState);
  httpServer.on(UriBraces("/local/channels/{}"), HTTP_POST, handleSetChannel);
  httpServer.on("/local/all-off", HTTP_POST, handleAllOff);
  httpServer.on("/local/schedules", HTTP_GET, handleListSchedules);
  httpServer.on("/local/schedules", HTTP_POST, handleUpsertSchedule);
  httpServer.on(UriBraces("/local/schedules/{}"), HTTP_DELETE, handleDeleteSchedule);
  httpServer.on("/local/time", HTTP_POST, handleSetTime);
}
