const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('node:path');

const config = getDefaultConfig(__dirname);

// @noble/hashes v1 remaps "./crypto" through its "browser" field to "./crypto.js",
// which its "exports" map does not list, so Metro warns on every bundle. Resolve the
// WebCrypto shim directly (it reads globalThis.crypto, filled in by src/lib/polyfills).
const nobleCrypto = path.join(
  // "./package.json" is not exported either, so locate the package via an exported entry.
  path.dirname(require.resolve('@noble/hashes/utils', { paths: [__dirname] })),
  'crypto.js',
);
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === '@noble/hashes/crypto' ||
    moduleName === '@noble/hashes/crypto.js'
  ) {
    return { type: 'sourceFile', filePath: nobleCrypto };
  }
  return (defaultResolveRequest ?? context.resolveRequest)(
    context,
    moduleName,
    platform,
  );
};

module.exports = withNativeWind(config, {
  input: path.join(__dirname, 'global.css'),
  configPath: path.join(__dirname, 'tailwind.config.js'),
});
