import UIKit
import Capacitor

class ViewController: CAPBridgeViewController {

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(CameraOvalPlugin())

        // IMPORTANT: WKWebView's isOpaque/backgroundColor must be set as early
        // as possible (here, right after load) rather than lazily when the
        // camera screen opens. Toggling it later, after the WebView has
        // already rendered/composited its content, is unreliable on iOS and
        // can leave the view effectively opaque even though the properties
        // report as changed — which is what caused the persistent black
        // oval behind the live camera preview. Doing it once at startup
        // ensures the compositing layer is created transparent from the
        // start; the HTML's own opaque backgrounds (body, .app, etc.) still
        // render normally on top everywhere except the oval's transparent
        // "hole", so nothing else visually changes.
        if let webView = bridge?.webView {
            webView.isOpaque = false
            webView.backgroundColor = .clear
            webView.scrollView.backgroundColor = .clear

            // The HTML already handles the notch / home-indicator with CSS
            // env(safe-area-inset-*). Letting UIScrollView also apply an
            // automatic content inset means iOS can temporarily double-adjust
            // the WebView after StoreKit/system sheets or foreground transitions,
            // which makes the fixed bottom navigation jump below the viewport.
            webView.scrollView.contentInsetAdjustmentBehavior = .never
            webView.scrollView.contentInset = .zero
            webView.scrollView.scrollIndicatorInsets = .zero
            if #available(iOS 13.0, *) {
                webView.scrollView.automaticallyAdjustsScrollIndicatorInsets = false
            }
        }
    }
}
