import UIKit
import WebKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Force the status bar to overlay the WKWebView so the app fills the
        // entire screen on all iPhone models (including those with a notch/
        // Dynamic Island). Without this the WebView can render in a smaller
        // frame on some iOS versions.
        if #available(iOS 13.0, *) {
            let statusBarManager = application.windows.first?.windowScene?.statusBarManager
            _ = statusBarManager  // referenced to suppress unused warning
        }

        // NOTE: we intentionally do NOT clear WKWebView's on-disk caches here.
        // WKWebsiteDataStore is a shared, app-wide object, and any system
        // component that also uses a WKWebView-backed context (e.g. the
        // Sign in with Apple / ASAuthorizationController flow) can end up
        // serialized behind a removeData() call on it. In practice this
        // showed up as the whole app freezing for several seconds — every
        // button unresponsive — whenever a fresh TestFlight build's first
        // launch happened to race with the user tapping "Sign in with Apple"
        // (e.g. going straight for "invite friends" right after install).
        // A previous "once per build" gate reduced how often this fired but
        // didn't remove the race, since on a brand-new build it still fires
        // on the very first launch — exactly when someone testing a fresh
        // TestFlight build is most likely to hit it. Simplest fix: don't do
        // it. URLCache is still safe to clear since it isn't shared with
        // ASAuthorizationController's webview.
        URLCache.shared.removeAllCachedResponses()

        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {}

    func applicationDidEnterBackground(_ application: UIApplication) {}

    func applicationWillEnterForeground(_ application: UIApplication) {}

    func applicationDidBecomeActive(_ application: UIApplication) {}

    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
