// The demo backend runs over plain HTTP on the Mac's LAN IP. Debug builds allow
// cleartext already; this keeps release APKs installed on a phone working too.
const { withAndroidManifest } = require('@expo/config-plugins');

function withAndroidCleartext(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) app.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });
}

module.exports = withAndroidCleartext;
