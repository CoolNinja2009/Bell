/*
 * wifi_provision.h  —  Wi‑Fi Provisioning System
 * ─────────────────────────────────────────────────
 * Modular provisioning that integrates into the existing
 * ESP32 relay‑controller boot sequence without removing
 * any existing features.
 *
 * Dependencies:  WiFi.h + WebServer.h (both ESP32 core — no extra libs)
 *
 * Integration:   #include this, then call in setup():
 *     checkBootButtonReset();
 *     if (!connectSavedWiFi()) startSetupMode();
 *
 * NVS namespace:  "wifi_prov"  (keys "ssid", "pass")
 * AP:             Bell_Setup / 12345678  @  192.168.4.1
 */

#pragma once

#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>

// ============================================================================
//  CONFIGURATION  (tweak these if needed)
// ============================================================================
static const char   AP_SSID[]                = "Bell_Setup";
static const char   AP_PASS[]                = "12345678";
static const IPAddress AP_IP                 (192, 168, 4, 1);
static const IPAddress AP_GATEWAY            (192, 168, 4, 1);
static const IPAddress AP_NETMASK            (255, 255, 255, 0);

constexpr uint32_t  BOOT_BUTTON_HOLD_MS      = 5000;   // how long to hold BOOT for reset
constexpr uint32_t  WIFI_PROV_CONNECT_MS     = 30000;  // max time to wait for connection
constexpr uint32_t  SAVE_RESTART_DELAY_MS    = 2000;   // delay before reboot after saving
constexpr uint32_t  WIFI_RETRY_MS            = 30000;  // WiFi reconnect interval in loop()

// NVS keys — completely separate from the main firmware's "relay" namespace
static const char   WIFI_NVS_NS[]            = "wifi_prov";
static const char   WIFI_NVS_SSID_KEY[]      = "ssid";
static const char   WIFI_NVS_PASS_KEY[]      = "pass";

// ============================================================================
//  1.  ERASE CREDENTIALS
// ============================================================================
static void eraseWiFiCredentials() {
    Preferences prefs;
    prefs.begin(WIFI_NVS_NS, false);
    prefs.remove(WIFI_NVS_SSID_KEY);
    prefs.remove(WIFI_NVS_PASS_KEY);
    prefs.end();
    Serial.println(F("[WiFi] Credentials erased from NVS"));
}

// ============================================================================
//  2.  SAVE CREDENTIALS
// ============================================================================
static void saveCredentials(const char* ssid, const char* pass) {
    Preferences prefs;
    prefs.begin(WIFI_NVS_NS, false);
    prefs.putString(WIFI_NVS_SSID_KEY, ssid);
    prefs.putString(WIFI_NVS_PASS_KEY, pass);
    prefs.end();
    Serial.println(F("[WiFi] Credentials saved to NVS"));
}

// ============================================================================
//  3.  LOAD CREDENTIALS  (internal helper)
// ============================================================================
static bool loadCredentials(char* ssid_out, size_t ssid_max,
                            char* pass_out, size_t pass_max) {
    Preferences prefs;
    prefs.begin(WIFI_NVS_NS, true);
    const String s = prefs.getString(WIFI_NVS_SSID_KEY, "");
    const String p = prefs.getString(WIFI_NVS_PASS_KEY, "");
    prefs.end();

    if (s.length() == 0 || p.length() == 0) return false;

    strncpy(ssid_out, s.c_str(), ssid_max - 1);
    ssid_out[ssid_max - 1] = '\0';
    strncpy(pass_out, p.c_str(), pass_max - 1);
    pass_out[pass_max - 1] = '\0';
    return true;
}

// ============================================================================
//  4.  CHECK BOOT BUTTON RESET  (non-blocking — call from setup() AND loop())
//      If BOOT (GPIO0, INPUT_PULLUP) is held for 5 seconds at any time,
//      erase only WiFi credentials and restart.
//      Safe to call every loop() iteration — uses static state internally.
// ============================================================================
static void checkBootButtonReset() {
    // init pin once (first call only)
    static bool initialized = false;
    if (!initialized) {
        pinMode(0, INPUT_PULLUP);
        initialized = true;
    }

    static bool   held      = false;
    static uint32_t press_start = 0;

    const bool pressed = (digitalRead(0) == LOW);

    if (pressed && !held) {
        // Button just pressed — start timing
        held = true;
        press_start = millis();
        Serial.println(F("BOOT held — hold 5s for WiFi factory reset..."));
    } else if (pressed && held) {
        // Still holding — check if 5 seconds elapsed
        if (millis() - press_start >= BOOT_BUTTON_HOLD_MS) {
            Serial.println(F("WiFi Reset Successful"));
            eraseWiFiCredentials();
            delay(500);
            ESP.restart();
        }
    } else if (!pressed && held) {
        // Released early — cancel
        held = false;
    }
}

// ============================================================================
//  5.  CONNECT WITH SAVED CREDENTIALS
//      Reads SSID/password from NVS and connects.
//      Returns true if connected, false otherwise.
// ============================================================================
static bool connectSavedWiFi() {
    char ssid[32] = {0};
    char pass[64] = {0};

    Serial.println(F("Reading WiFi credentials..."));
    if (!loadCredentials(ssid, sizeof(ssid), pass, sizeof(pass))) {
        Serial.println(F("No WiFi configured."));
        return false;
    }

    Serial.printf("Connecting to %s...", ssid);
    WiFi.setAutoReconnect(true);
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, pass);

    const uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED
           && millis() - start < WIFI_PROV_CONNECT_MS) {
        delay(250);
        Serial.print(".");
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println(F(" connected"));
        return true;
    }

    Serial.println(F(""));
    return false;
}

// ============================================================================
//  EMBEDDED SETUP PORTAL HTML  (stored in flash / PROGMEM)
// ============================================================================
static const char SETUP_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>Bell Setup</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:#0a0e14;color:#d4dce8;min-height:100vh;
    display:flex;justify-content:center;align-items:center;padding:16px
  }
  .card{
    background:#131a24;border:1px solid #1c2736;border-radius:16px;
    padding:28px 24px;max-width:460px;width:100%;
    box-shadow:0 8px 32px rgba(0,0,0,.5)
  }
  .card h1{
    font-size:1.35rem;font-weight:700;margin-bottom:4px;
    display:flex;align-items:center;gap:10px
  }
  .card h1::before{
    content:"";width:10px;height:10px;background:#00d4a0;
    border-radius:3px;box-shadow:0 0 10px #00d4a0
  }
  .subtitle{color:#5e7088;font-size:.82rem;margin-bottom:22px}
  .connected-bar{
    display:flex;align-items:center;gap:8px;
    padding:10px 14px;background:#0a0f16;
    border:1px solid #1c2736;border-radius:10px;margin-bottom:20px;
    font-size:.84rem
  }
  .connected-bar .dot{
    width:8px;height:8px;border-radius:50%;
    background:#00e676;box-shadow:0 0 8px #00e676;flex-shrink:0
  }
  label{
    display:block;font-size:.7rem;color:#5e7088;
    text-transform:uppercase;letter-spacing:1.2px;
    font-weight:600;margin-bottom:5px;margin-top:16px
  }
  select,input[type=password],input[type=text]{
    width:100%;background:#0a0f16;border:1px solid #1c2736;
    color:#d4dce8;padding:11px 14px;border-radius:8px;
    font-size:.9rem;font-family:inherit;
    transition:border-color .2s,box-shadow .2s;
    -webkit-appearance:none;appearance:none
  }
  select:focus,input:focus{
    outline:0;border-color:#00d4a0;
    box-shadow:0 0 0 3px rgba(0,212,160,.12)
  }
  .btn-row{display:flex;gap:10px;margin-top:12px}
  .btn{
    flex:1;padding:11px 18px;border-radius:8px;border:none;
    font-size:.82rem;font-weight:700;cursor:pointer;
    transition:all .2s;letter-spacing:.3px;text-align:center
  }
  .btn:hover{transform:translateY(-1px)}
  .btn:active{transform:translateY(0)}
  .btn-scan{background:#15262e;color:#00d4a0;border:1px solid #1e3a3a}
  .btn-scan:hover{background:#1a3038}
  .btn-save{
    background:linear-gradient(135deg,#00d4a0,#00b38a);
    color:#000;box-shadow:0 2px 12px rgba(0,212,160,.25)
  }
  .btn-save:hover{box-shadow:0 4px 18px rgba(0,212,160,.4)}
  .btn-save:disabled{opacity:.5;cursor:not-allowed;transform:none}
  .net-list{margin-top:10px;max-height:220px;overflow-y:auto}
  .net-item{
    display:flex;justify-content:space-between;align-items:center;
    padding:9px 12px;border-radius:8px;cursor:pointer;
    transition:background .15s;border:1px solid transparent;margin-bottom:3px
  }
  .net-item:hover,.net-item.selected{background:#0f1620;border-color:#1c2736}
  .net-item .ssid{font-size:.85rem;word-break:break-all}
  .net-item .rssi{font-size:.72rem;color:#5e7088;white-space:nowrap;margin-left:8px}
  .manual-link{
    text-align:center;margin-top:8px;font-size:.78rem
  }
  .manual-link a{color:#5e7088;cursor:pointer;text-decoration:none}
  .manual-link a:hover{color:#00d4a0}
  .manual-input{display:none;margin-top:8px}
  .spinner{
    display:inline-block;width:16px;height:16px;
    border:2px solid #1c2736;border-top-color:#00d4a0;
    border-radius:50%;animation:spin .6s linear infinite;
    vertical-align:middle;margin-right:6px
  }
  @keyframes spin{to{transform:rotate(360deg)}}
  .toast{
    position:fixed;bottom:20px;right:20px;left:20px;
    max-width:400px;margin:0 auto;
    background:#00d4a0;color:#000;padding:12px 24px;
    border-radius:10px;font-weight:700;font-size:.84rem;
    opacity:0;transform:translateY(20px);
    transition:all .35s;pointer-events:none;z-index:100;text-align:center
  }
  .toast.show{opacity:1;transform:translateY(0)}
  .toast.error{background:#e0556a;color:#fff}
  ::-webkit-scrollbar{width:4px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:#1c2736;border-radius:2px}
</style>
</head>
<body>
<div class="card">
  <h1>Smart School Bell</h1>
  <div class="subtitle">Wi‑Fi Setup</div>
  <div class="connected-bar">
    <span class="dot"></span>
    <span>Connected to Access Point</span>
  </div>

  <div class="btn-row">
    <button class="btn btn-scan" id="scanBtn" onclick="scanNetworks()">
      <span class="spinner" id="scanSpinner" style="display:none"></span>
      Scan Networks
    </button>
  </div>

  <div id="networkContainer">
    <div class="net-list" id="netList"></div>
    <div class="manual-link">
      <a onclick="toggleManual()" id="manualToggle">+ Enter SSID manually</a>
    </div>
    <div class="manual-input" id="manualInput">
      <label>SSID</label>
      <input type="text" id="manualSsid" placeholder="Network name">
    </div>
  </div>

  <label>Password</label>
  <input type="password" id="wifiPass" placeholder="Wi‑Fi password">

  <div class="btn-row" style="margin-top:20px">
    <button class="btn btn-save" id="saveBtn" onclick="saveConfig()">Save &amp; Connect</button>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
var selectedSSID = '';
var scanDone = false;

function scanNetworks() {
  var btn = document.getElementById('scanBtn');
  var spinner = document.getElementById('scanSpinner');
  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btn.childNodes[2].textContent = ' Scanning...';

  var xhr = new XMLHttpRequest();
  xhr.onload = function() {
    btn.disabled = false;
    spinner.style.display = 'none';
    btn.childNodes[2].textContent = ' Scan Networks';
    if (xhr.status === 200) {
      renderNetworks(JSON.parse(xhr.responseText));
      scanDone = true;
    } else {
      showToast('Scan failed', true);
    }
  };
  xhr.onerror = function() {
    btn.disabled = false;
    spinner.style.display = 'none';
    btn.childNodes[2].textContent = ' Scan Networks';
    showToast('Connection error', true);
  };
  xhr.open('GET', '/api/scan', true);
  xhr.send();
}

function renderNetworks(nets) {
  var seen = {};
  var container = document.getElementById('netList');
  container.innerHTML = '';
  var count = 0;

  for (var i = 0; i < nets.length; i++) {
    var ssid = nets[i].ssid;
    var rssi = nets[i].rssi;
    if (!ssid || seen[ssid] || ssid.trim() === '') continue;
    seen[ssid] = true;
    count++;

    var div = document.createElement('div');
    div.className = 'net-item';
    div.setAttribute('data-ssid', ssid);
    div.onclick = function(s) { return function() { selectSSID(s); }; }(ssid);

    var bars = '';
    if (rssi > -50) bars = '\u2582\u2584\u2586\u2588';
    else if (rssi > -65) bars = '\u2582\u2584\u2586';
    else if (rssi > -80) bars = '\u2582\u2584';
    else bars = '\u2582';

    div.innerHTML = '<span class="ssid">' + escHtml(ssid) + '</span><span class="rssi">' + bars + ' ' + rssi + ' dBm</span>';
    container.appendChild(div);
  }

  if (count === 0) {
    container.innerHTML = '<div style="color:#5e7088;text-align:center;padding:12px">No networks found. Enter SSID manually below.</div>';
  }
}

function selectSSID(ssid) {
  selectedSSID = ssid;
  document.getElementById('manualSsid').value = ssid;
  var items = document.querySelectorAll('.net-item');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.remove('selected');
  }
  // find the clicked one
  var all = document.querySelectorAll('.net-item');
  for (var i = 0; i < all.length; i++) {
    if (all[i].getAttribute('data-ssid') === ssid) {
      all[i].classList.add('selected');
      break;
    }
  }
}

function toggleManual() {
  var el = document.getElementById('manualInput');
  var link = document.getElementById('manualToggle');
  if (el.style.display === 'block') {
    el.style.display = 'none';
    link.textContent = '+ Enter SSID manually';
    selectedSSID = '';
  } else {
    el.style.display = 'block';
    link.textContent = '- Hide manual entry';
    document.getElementById('manualSsid').focus();
  }
}

function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function saveConfig() {
  var ssid = selectedSSID || document.getElementById('manualSsid').value.trim();
  var pass = document.getElementById('wifiPass').value;

  if (!ssid) {
    showToast('Please select or enter a network name', true);
    return;
  }
  if (ssid.length > 31) {
    showToast('SSID too long (max 31 characters)', true);
    return;
  }

  var btn = document.getElementById('saveBtn');
  btn.textContent = 'Saving...';
  btn.disabled = true;

  var xhr = new XMLHttpRequest();
  xhr.onload = function() {
    if (xhr.status === 200) {
      document.body.innerHTML =
        '<div style="display:flex;justify-content:center;align-items:center;min-height:100vh;text-align:center;padding:20px">' +
        '<div style="background:#131a24;border:1px solid #1c2736;border-radius:16px;padding:40px;max-width:420px">' +
        '<div style="font-size:48px;color:#00d4a0;margin-bottom:12px">&#10003;</div>' +
        '<h2 style="margin-bottom:6px">Configuration Saved</h2>' +
        '<p style="color:#5e7088">Rebooting...</p>' +
        '</div></div>';
    } else {
      showToast('Save failed (server error)', true);
      btn.textContent = 'Save & Connect';
      btn.disabled = false;
    }
  };
  xhr.onerror = function() {
    showToast('Connection error — check AP connection', true);
    btn.textContent = 'Save & Connect';
    btn.disabled = false;
  };
  xhr.open('POST', '/api/save', true);
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  xhr.send('ssid=' + encodeURIComponent(ssid) + '&pass=' + encodeURIComponent(pass));
}

function showToast(msg, isError) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '') + ' show';
  setTimeout(function() { t.className = 'toast'; }, 3000);
}

// Auto-scan on page load
setTimeout(scanNetworks, 600);
</script>
</body>
</html>
)rawliteral";

// ============================================================================
//  6.  START SETUP MODE
//      Creates AP "Bell_Setup", runs a web server, and blocks until the user
//      submits credentials.  Then saves them and restarts.
// ============================================================================
static void startSetupMode() {
    Serial.println(F("Entering Setup Mode..."));

    // Start Access Point
    WiFi.mode(WIFI_AP);
    WiFi.softAPConfig(AP_IP, AP_GATEWAY, AP_NETMASK);
    WiFi.softAP(AP_SSID, AP_PASS);
    delay(200);

    Serial.print(F("AP Started\nSSID: Bell_Setup\nPassword: 12345678\nOpen: http://192.168.4.1\n"));

    // Build the web server
    WebServer server(80);

    // ── Serve the setup HTML page ────────────────────────────────────
    server.on("/", [&server]() {
        server.send_P(200, "text/html", SETUP_HTML);
    });

    // ── Wi‑Fi scan endpoint ──────────────────────────────────────────
    server.on("/api/scan", [&server]() {
        // Perform a synchronous scan (blocks ~1-3 s)
        int n = WiFi.scanComplete();
        if (n == -2 || n == -1) {
            n = WiFi.scanNetworks();  // synchronous
        }
        String json = "[";
        for (int i = 0; i < n; ++i) {
            if (i > 0) json += ",";
            const String ssid = WiFi.SSID(i);
            // Escape special JSON characters in SSID
            String escaped;
            for (size_t j = 0; j < ssid.length(); ++j) {
                const char c = ssid.charAt(j);
                if (c == '"') escaped += "\\\"";
                else if (c == '\\') escaped += "\\\\";
                else if (c < 0x20) escaped += " ";
                else escaped += c;
            }
            json += "{\"ssid\":\"" + escaped + "\",\"rssi\":" + WiFi.RSSI(i) + "}";
        }
        json += "]";
        server.send(200, "application/json", json);
        WiFi.scanDelete();
    });

    // ── Save credentials endpoint ────────────────────────────────────
    server.on("/api/save", HTTP_POST, [&server]() {
        if (server.hasArg("ssid") && server.arg("ssid").length() > 0) {
            const String ssid = server.arg("ssid");
            const String pass = server.arg("pass");

            Serial.print(F("Saving WiFi...\n"));
            saveCredentials(ssid.c_str(), pass.c_str());

            // Respond before restarting
            server.send(200, "text/plain", "OK");

            // Brief delay to let the HTTP response reach the client
            delay(SAVE_RESTART_DELAY_MS);

            Serial.println(F("Restarting..."));
            delay(500);
            ESP.restart();
        } else {
            server.send(400, "text/plain", "SSID required");
        }
    });

    // ── Catch‑all: redirect to / ─────────────────────────────────────
    server.onNotFound([&server]() {
        server.sendHeader("Location", "/", true);
        server.send(302, "text/plain", "");
    });

    server.begin();

    // ── Blocking loop — handles web requests until restart ──────────
    uint32_t last_button_check = millis();
    while (true) {
        server.handleClient();

        // Check BOOT button (GPIO0) — hold 5s to restart without saving
        if (millis() - last_button_check >= 100) {
            last_button_check = millis();
            if (digitalRead(0) == LOW) {
                Serial.println(F("BOOT held — waiting 5s to abort setup..."));
                const uint32_t btn_start = millis();
                bool held = true;
                while (millis() - btn_start < BOOT_BUTTON_HOLD_MS) {
                    server.handleClient();  // keep serving during countdown
                    delay(10);
                    if (digitalRead(0) != LOW) {
                        held = false;
                        break;
                    }
                }
                if (held) {
                    Serial.println(F("Setup aborted — restarting without saving"));
                    delay(500);
                    ESP.restart();
                }
            }
        }

        delay(10);
    }
}
