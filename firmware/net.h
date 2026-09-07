// ================================================================
//  net.h — HTTPS POST helpers (fresh client per request)
//
//  ESP32 WiFiClientSecure leaves stale TLS state when reused
//  across requests — http.begin() fails with code -1.
//  Creating a fresh client each time is the only reliable approach.
//  Mutex guards concurrent access from alert + heartbeat tasks.
// ================================================================

#pragma once
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <freertos/semphr.h>

#ifndef API_BASE_URL
#define API_BASE_URL ""
#endif
#ifndef API_KEY
#define API_KEY ""
#endif

// HTTPS read/connect timeout. A single POST now carries up to 200 samples
// (1 s @ 200 Hz) into Supabase, plus an occasional Vercel edge cold start.
// 8 s was too short: a slow server round-trip returned HTTPC_ERROR_READ_TIMEOUT
// (-11) and dropped the whole batch. 20 s absorbs cold starts while the 1 Hz
// upload cadence still bounds how long we wait per request.
#define NET_TIMEOUT_MS 20000

static SemaphoreHandle_t g_netMutex = nullptr;

inline void netInit() {
    g_netMutex = xSemaphoreCreateMutex();
}

static char dbgResp[1024];
static void _dumpResp(HTTPClient& http, int code, size_t len, const String& path) {
    String resp = http.getString();
    resp.replace('\n', ' ');
    size_t rl = resp.length();
    snprintf(dbgResp, sizeof(dbgResp), "%.1s", "");
    memcpy(dbgResp, resp.c_str(), rl < sizeof(dbgResp) - 1 ? rl : sizeof(dbgResp) - 1);
    dbgResp[rl < sizeof(dbgResp) - 1 ? rl : sizeof(dbgResp) - 1] = 0;
    Serial.printf("[NET] %s HTTP %d bodyLen=%u respLen=%u RESP: %.700s\n",
                  path.c_str(), code, (unsigned)len, (unsigned)rl, dbgResp);
    String hdr = http.header("x-vercel-id");
    if (hdr.length()) Serial.printf("[NET]   x-vercel-id=%s\n", hdr.c_str());
    hdr = http.header("x-vercel-error");
    if (hdr.length()) Serial.printf("[NET]   x-vercel-error=%s\n", hdr.c_str());
    hdr = http.header("x-vercel-error-code");
    if (hdr.length()) Serial.printf("[NET]   x-vercel-error-code=%s\n", hdr.c_str());
}

static String _extractHost() {
    String h(API_BASE_URL);
    if (h.startsWith("https://")) h.remove(0, 8);
    else if (h.startsWith("http://")) h.remove(0, 7);
    if (h.endsWith("/")) h.remove(h.length() - 1);
    return h;
}

static int _httpsPost(const char* path, const String& body) {
    if (WiFi.status() != WL_CONNECTED) return -99;

    if (g_netMutex) xSemaphoreTake(g_netMutex, portMAX_DELAY);

    String apiHost = _extractHost();

    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(NET_TIMEOUT_MS);

    HTTPClient http;
    http.setTimeout(NET_TIMEOUT_MS);

    if (!http.begin(client, apiHost, (uint16_t)443, String(path), true)) {
        Serial.printf("[NET] begin() failed: %s freeHeap=%d\n",
                      apiHost.c_str(), ESP.getFreeHeap());
        http.end();
        client.stop();
        if (g_netMutex) xSemaphoreGive(g_netMutex);
        delay(200);
        if (g_netMutex) xSemaphoreTake(g_netMutex, portMAX_DELAY);

        WiFiClientSecure retryClient;
        retryClient.setInsecure();
        retryClient.setTimeout(NET_TIMEOUT_MS);
        HTTPClient http2;
        http2.setTimeout(NET_TIMEOUT_MS);

        if (!http2.begin(retryClient, apiHost, (uint16_t)443, String(path), true)) {
            Serial.printf("[NET] begin() failed (2nd try): %s freeHeap=%d\n",
                          apiHost.c_str(), ESP.getFreeHeap());
            http2.end();
            if (g_netMutex) xSemaphoreGive(g_netMutex);
            return -1;
        }

        http2.addHeader("Content-Type", "application/json");
        http2.addHeader("X-Api-Key",    API_KEY);

        int code = http2.POST(body);
        if (code < 0) {
            Serial.printf("[NET] POST error %d (%s) freeHeap=%d maxAlloc=%d bodyLen=%u\n", code,
                          code == -1 ? "begin/TLS failed" : http2.errorToString(code).c_str(),
                          ESP.getFreeHeap(), ESP.getMaxAllocHeap(), body.length());
        } else if (code >= 400) {
            _dumpResp(http2, code, body.length(), path);
        }

        http2.end();
        retryClient.stop();
        if (g_netMutex) xSemaphoreGive(g_netMutex);
        return code;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Api-Key",    API_KEY);

    int code = http.POST(body);
    if (code < 0) {
        Serial.printf("[NET] POST error %d (%s) freeHeap=%d maxAlloc=%d bodyLen=%u\n", code,
                      code == -1 ? "begin/TLS failed" : http.errorToString(code).c_str(),
                      ESP.getFreeHeap(), ESP.getMaxAllocHeap(), body.length());
    } else if (code >= 400) {
        _dumpResp(http, code, body.length(), path);
    }

    http.end();
    client.stop();
    if (g_netMutex) xSemaphoreGive(g_netMutex);
    return code;
}

// ── Raw-buffer (byte-array) transport ────────────────────────────────
// Same as _httpsPost(String) but takes a static char buffer + length so the
// payload never occupies DRAM heap while the mbedTLS handshake runs. Without
// this the ~25KB body leaves ssl_setup() with -32512 (MBEDTLS_ERR_SSL_ALLOC_FAILED).
static int _httpsPost(const char* path, const char* body, size_t len) {
    if (WiFi.status() != WL_CONNECTED) return -99;

    if (g_netMutex) xSemaphoreTake(g_netMutex, portMAX_DELAY);

    String apiHost = _extractHost();

    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(NET_TIMEOUT_MS);

    HTTPClient http;
    http.setTimeout(NET_TIMEOUT_MS);

    if (!http.begin(client, apiHost, (uint16_t)443, String(path), true)) {
        http.end();
        client.stop();
        if (g_netMutex) xSemaphoreGive(g_netMutex);
        return -1;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Api-Key",    API_KEY);

    int code = http.POST((uint8_t*)body, len);
    if (code < 0) {
        Serial.printf("[NET] POST error %d (%s) freeHeap=%d maxAlloc=%d bodyLen=%u\n", code,
                      code == -1 ? "begin/TLS failed" : http.errorToString(code).c_str(),
                      ESP.getFreeHeap(), ESP.getMaxAllocHeap(), (unsigned)len);
    } else if (code >= 400) {
        _dumpResp(http, code, len, path);
        int dbg = len < 300 ? len : 300;
        char dbgBody[320];
        memcpy(dbgBody, body, dbg);
        dbgBody[dbg] = 0;
        Serial.printf("[NET]   BODYHEAD: %.300s\n", dbgBody);
        if (len > 300) {
            int tailStart = len - 120;
            if (tailStart < 301) tailStart = 301;
            int tlen = len - tailStart;
            char dbgTail[140];
            memcpy(dbgTail, body + tailStart, tlen);
            dbgTail[tlen] = 0;
            Serial.printf("[NET]   BODYTAIL(%d..%u): %.140s\n", tailStart, (unsigned)len, dbgTail);
        }
    }

    http.end();
    client.stop();
    if (g_netMutex) xSemaphoreGive(g_netMutex);
    return code;
}

// taskWiFiUpload — calls from single task, mutex still protects shared WiFiClientSecure internals
inline int netIngestPost(const String& body) {
    return _httpsPost("/api/ingest", body);
}

// Raw-buffer POST. The body lives in a static BSS buffer (not heap) so TLS keeps
// maxAlloc for its own ~32KB contiguous handshake buffers.
inline int netIngestPost(const char* body, size_t len) {
    return _httpsPost("/api/ingest", body, len);
}

// taskAlert + taskHeartbeat — mutex guarded
inline int netAlertPost(const char* path, const String& body) {
    return _httpsPost(path, body);
}
