// Copy this file to secrets.h and fill in your local values.

#ifndef SECRETS_H
#define SECRETS_H

#define WIFI_SSID     "YourWiFi_SSID"
#define WIFI_PASS     "YourWiFi_Password"
#define API_BASE_URL  "https://your-project.vercel.app"
#define API_KEY       "your-api-key-here"
#define NODE_ID       "ADXL345-01"

// TLS verification against the GTS Root R1 CA is ON by default (tls_certs.h).
// Only define this for lab/dev on a trusted network — it disables certificate
// verification entirely:
// #define TLS_INSECURE 1

#endif