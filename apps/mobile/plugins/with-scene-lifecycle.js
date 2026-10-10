// Adds the UIKit scene lifecycle that the iOS 27 SDK requires.
// Runs on every `expo prebuild`, so the generated ios/ folder keeps working.
const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  withInfoPlist,
  withDangerousMod,
  withXcodeProject,
} = require('@expo/config-plugins');

const SCENE_DELEGATE = `import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    appDelegate.reactNativeFactory?.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: nil)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    for context in URLContexts {
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: [:])
    }
  }
}
`;

// The window is now created by the scene, so AppDelegate must not create it too.
const LEGACY_WINDOW_BLOCK = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`;

function withSceneLifecycle(config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    };
    return cfg;
  });

  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      const dir = path.join(
        cfg.modRequest.platformProjectRoot,
        cfg.modRequest.projectName,
      );
      fs.writeFileSync(path.join(dir, 'SceneDelegate.swift'), SCENE_DELEGATE);

      const appDelegatePath = path.join(dir, 'AppDelegate.swift');
      const appDelegate = fs.readFileSync(appDelegatePath, 'utf8');
      if (appDelegate.includes(LEGACY_WINDOW_BLOCK)) {
        fs.writeFileSync(
          appDelegatePath,
          appDelegate.replace(LEGACY_WINDOW_BLOCK, ''),
        );
      }
      return cfg;
    },
  ]);

  config = withXcodeProject(config, (cfg) => {
    const { projectName } = cfg.modRequest;
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: path.join(projectName, 'SceneDelegate.swift'),
      groupName: projectName,
      project: cfg.modResults,
    });
    return cfg;
  });

  return config;
}

module.exports = withSceneLifecycle;
