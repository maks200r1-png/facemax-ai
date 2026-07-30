import UIKit
import Capacitor
import WebKit

@objc(ScreenshotPlugin)
public class ScreenshotPlugin: CAPPlugin {

    @objc func take(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let webView = self.webView else {
                call.reject("No webView available")
                return
            }

            let config = WKSnapshotConfiguration()

            // If the caller supplies an element rect (from JS getBoundingClientRect),
            // capture only that region — pixel-perfect crop of the rendered element.
            // CSS pixels == UIKit points on iOS (viewport = device-width), so the
            // values from JS map directly to WKSnapshotConfiguration.rect.
            let x      = call.getDouble("x")      ?? 0
            let y      = call.getDouble("y")      ?? 0
            let width  = call.getDouble("width")  ?? Double(webView.bounds.width)
            let height = call.getDouble("height") ?? Double(webView.bounds.height)

            if width > 0 && height > 0 {
                config.rect = CGRect(x: x, y: y, width: width, height: height)
            } else {
                config.rect = CGRect(origin: .zero, size: webView.bounds.size)
            }

            webView.takeSnapshot(with: config) { image, error in
                if let error = error {
                    call.reject("Snapshot failed: \(error.localizedDescription)")
                    return
                }
                guard let image = image,
                      let pngData = image.pngData() else {
                    call.reject("Could not encode snapshot")
                    return
                }
                let base64 = pngData.base64EncodedString()
                call.resolve(["base64": base64])
            }
        }
    }
}
