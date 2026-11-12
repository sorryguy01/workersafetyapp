#!/usr/bin/env node
'use strict';

/*
 * Writes one test telemetry frame to Firebase Realtime Database.
 * Use it to check your database URL and rules before touching the ESP32.
 *
 *   node scripts/test-firebase.js https://<project>-default-rtdb.firebaseio.com
 *
 * Optional second argument adds ?auth=<database secret>:
 *   node scripts/test-firebase.js https://<project>-default-rtdb.firebaseio.com <secret>
 */

const rawHost = process.argv[2];
const secret = process.argv[3];

if (!rawHost) {
  console.error('Usage: node scripts/test-firebase.js <databaseURL> [databaseSecret]');
  process.exit(1);
}

const host = rawHost
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '');

const frame = {
  x: 0.12,
  y: 0.34,
  z: 9.81,
  gx: 1.2,
  gy: 0.5,
  gz: 0.3,
  temp: 25.0,
  hum: 60.0,
  gas: 123,
  bpm: 78,
  flame: 0,
  sos: 0,
};

const url =
  `https://${host}/telemetry.json` +
  (secret ? `?auth=${encodeURIComponent(secret)}` : '');

(async () => {
  console.log(`PUT ${url.replace(/auth=[^&]+/, 'auth=***')}`);
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(frame),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`FAILED ${res.status}: ${text}`);
      if (res.status === 401 || res.status === 403) {
        console.error('Database rules rejected the write. Set .write to true for testing.');
      }
      process.exit(1);
    }
    console.log(`OK ${res.status} — frame written to /telemetry`);
    console.log('Open the dashboard: it should show ESP32 ONLINE within a couple of seconds.');
  } catch (err) {
    console.error(`NETWORK ERROR: ${err.message}`);
    console.error('Check the databaseURL (it must be <project>-default-rtdb.<region>.firebasedatabase.app or .firebaseio.com).');
    process.exit(1);
  }
})();
