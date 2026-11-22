'use strict';

require('dotenv').config();

// The mobile app can either (a) load a URL baked in at build time, or
// (b) ship a local "app shell" that asks for the server URL on first launch.
// Option (b) is used when RENTFLOW_URL is empty, so one APK works with any deployment.
const raw = (process.env.RENTFLOW_URL || process.env.MOBILE_SERVER_URL || '').trim();
const url = raw || 'http://localhost:3000';

if (raw) {
  console.log(`[RentFlow Mobile] Baking server URL: ${url}`);
} else {
  console.log('[RentFlow Mobile] No RENTFLOW_URL set - building the app shell with in-app server setup.');
}

// allowNavigation is needed so the local shell can open the configured server.
const server = { allowNavigation: ['*'] };
if (raw) {
  server.url = url;
  server.androidScheme = url.startsWith('http://') ? 'http' : 'https';
}

module.exports = {
  appId: 'com.rentflow.family',
  appName: 'RentFlow',
  webDir: 'public',
  server,
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#123C30',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
    StatusBar: {
      color: '#123C30',
      style: 'LIGHT',
    },
    Camera: {
      quality: 80,
      allowEditing: false,
      resultType: 'dataUrl',
    },
  },
  android: {
    allowMixedContent: url.startsWith('http://'),
  },
  ios: {
    contentInset: 'always',
  },
};
