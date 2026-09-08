// ================================================================
//  net.h - HTTPS POST helpers over a persistent TLS connection
//
//  A fresh TLS handshake per POST cost 2-5 s on the ESP32 (RSA-2048
//  server chain), throttling uploads to one ~100-sample batch every
//  3-6 s (~30 rows/s instead of the sampled 200 Hz). The dashboard
//  then advances in bursts with a growing right-edge gap (choppy +
//  cutoff).
//
//  The connection is now PERSISTENT: one WiFiClientSecure stays
//  connected (HTTP/1.1 keep-alive) and each request only pays the
//  write round-trip (~100-300 ms), restoring the 500 ms batch
//  cadence. A FRESH HTTPClient is still created per request -
//  reusing the HTTPClient object across requests is what previously
//  failed with begin() == -1 (stale response state), not the socket
//  itself. Any transport failure tears the connection down and the
//  next POST transparently falls back to a full handshake, so the
//  worst case equals the old fresh-client behavior.
//  Mutex guards concurrent access from alert + heartbeat tasks.
// ================================================================

#pragma once
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <freertos/semphr.h>

// TLS verification: embed the GTS Root R1 CA (tls_certs.h) and verify the
// server certificate on every handshake, so a MITM cannot present a forged
// cert to steal X-Api-Key. Define TLS_INSECURE=1 in secrets.h to fall back
// to setInsecure() for lab/dev only.
#include "tls_certs.h"
#ifndef TLS_INSECURE
#define TLS_INSECURE 0
#endif

#ifndef API_BASE_URL
#define API_BASE_URL ""
#endif
#ifndef API_KEY
#define API_KEY ""
#endif

// HTTPS read/connect timeout. A single POST carries up to 100 samples into
// Supabase, plus an occasional Vercel edge cold start. 8 s was too short: a
// slow server round-trip returned HTTPC_ERROR_READ_TIMEOUT (-11) and dropped
// the whole batch. 20 s absorbs cold starts while the 500 ms upload cadence
// still bounds how long we wait per request.
#define NET_TIMEOUT_MS 20000

static SemaphoreHandle_t g_netMutex = nullptr;

// Persistent TLS connection state. The socket stays open between POSTs;
// g_tlsUp tracks whether we BELIEVE it is up (re-verified via connected()).
static WiFiClientSecure g_tlsClient;
static bool g_tlsUp = false;

inline void netInit() {
    g_netMutex = xSemaphoreCreateMutex();
}

// Configure TLS: verify against the embedded CA root unless TLS_INSECURE
// is explicitly enabled in secrets.h.
static inline void _configTls(WiFiClientSecure& client) {
#if TLS_INSECURE
    client.setInsecure();
#else
    client.setCACert(TLS_CA_ROOT_PEM);
#endif
    client.setTimeout(NET_TIMEOUT_MS);
}

// Tear the persistent connection down (next POST pays a full handshake).
static void _tlsDown() {
    g_tlsClient.stop();
    g_tlsUp = false;
}

// Make sure the persistent TLS connection is up, (re)connecting if needed.
static bool _tlsEnsure(const String& apiHost) {
    if (g_tlsUp && g_tlsClient.connected()) return true;
    _tlsDown();
    _configTls(g_tlsClient);
    if (!g_tlsClient.connect(apiHost.c_str(), 443)) {
        Serial.printf("[NET] TLS connect failed to %s freeHeap=%d maxAlloc=%d\n",
                      apiHost.c_str(), ESP.getFreeHeap(), ESP.getMaxAllocHeap());
        _tlsDown();
        return false;
    }
    g_tlsUp = true;
    Serial.printf("[NET] TLS session established to %s freeHeap=%d\n",
                  apiHost.c_str(), ESP.getFreeHeap());
    return true;
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

// One request over the persistent connection (fresh HTTPClient per call).
// Retries are handled by the caller; a transport failure (code < 0) here
// always tears the connection down so the next attempt re-handshakes.
static int _httpsPostOnce(const char* path, const char* body, size_t len) {
    String apiHost = _extractHost();

    if (!_tlsEnsure(apiHost)) return -1;

    HTTPClient http;
    http.setTimeout(NET_TIMEOUT_MS);
    http.setReuse(true);

    if (!http.begin(g_tlsClient, apiHost, (uint16_t)443, String(path), true)) {
        _tlsDown();
        return -1;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Api-Key",    API_KEY);

    int code = http.POST((uint8_t*)body, len);
    if (code < 0) {
        Serial.printf("[NET] POST error %d (%s) freeHeap=%d maxAlloc=%d bodyLen=%u\n", code,
                      code == -1 ? "begin/TLS failed" : http.errorToString(code).c_str(),
                      ESP.getFreeHeap(), ESP.getMaxAllocHeap(), (unsigned)len);
        _tlsDown();
    } else if (code >= 400) {
        // Application-level failure - the transport is fine, keep it up.
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

    // Keeps the TLS socket open when the server allows keep-alive; the
    // available()>0 flush inside disconnect() also drains any unread body.
    http.end();
    g_tlsUp = g_tlsClient.connected();
    return code;
}

static int _httpsPost(const char* path, const char* body, size_t len) {
    if (WiFi.status() != WL_CONNECTED) return -99;

    if (g_netMutex) xSemaphoreTake(g_netMutex, portMAX_DELAY);

    int code = _httpsPostOnce(path, body, len);
    if (code < 0) {
        // One transparent reconnect-and-retry: the usual cause is the server
        // having closed an idle keep-alive socket, which only surfaces as a
        // failed write. Never retried for HTTP 4xx/5xx - those came back fine.
        code = _httpsPostOnce(path, body, len);
    }

    if (g_netMutex) xSemaphoreGive(g_netMutex);
    return code;
}

// taskWiFiUpload - single-task caller; the mutex still guards the shared
// persistent client against the alert + heartbeat tasks.
inline int netIngestPost(const char* body, size_t len) {
    return _httpsPost("/api/ingest", body, len);
}

inline int netIngestPost(const String& body) {
    return _httpsPost("/api/ingest", body.c_str(), body.length());
}

// taskAlert + taskHeartbeat - mutex guarded
inline int netAlertPost(const char* path, const String& body) {
    return _httpsPost(path, body.c_str(), body.length());
}