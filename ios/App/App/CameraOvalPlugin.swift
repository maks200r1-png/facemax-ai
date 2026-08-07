import UIKit
import WebKit
import AVFoundation
import Capacitor

// =====================================================================
// CameraOvalPlugin — embedded (inline) front-camera preview.
//
// Instead of presenting a full-screen native VC, this plugin inserts a
// live AVCaptureVideoPreviewLayer as a UIView directly behind/inside the
// Capacitor WKWebView, clipped to an oval shape, and positioned to exactly
// match the HTML `#capOval` element's on-screen rect. The dashed oval ring,
// labels, and shutter button stay in HTML/CSS exactly as before — only the
// video feed itself is native.
//
// JS-side contract (see native-bridge.js / index.html):
//   CameraOval.startEmbedded({ x, y, width, height, direction })
//     -> inserts/repositions the live preview at that CSS-pixel rect
//        (rect is in WKWebView point coordinates, i.e. what
//        getBoundingClientRect() returns — no devicePixelRatio scaling
//        needed, WKWebView already reports in points).
//   CameraOval.updateEmbeddedRect({ x, y, width, height })
//     -> call on scroll/resize/orientation change to keep the live
//        preview glued to the HTML oval as it moves.
//   CameraOval.capture()
//     -> takes the photo, resolves { dataUrl }.
//   CameraOval.stopEmbedded()
//     -> tears down the session + view (call when leaving the screen or
//        after a successful/cancelled capture).
// =====================================================================


// Send a log message to the JS fmLog function (no-op in production builds;
// kept for parity with diagnostics hooks used during development).
private func fmLog(_ webView: WKWebView?, _ level: String, _ msg: String) {
    guard let webView = webView else { return }
    let escaped = msg.replacingOccurrences(of: "\\", with: "\\\\")
                     .replacingOccurrences(of: "\"", with: "\\\"")
                     .replacingOccurrences(of: "\n", with: " ")
    let js = "if(window.fmLog)window.fmLog(\"\(level)\",\"[CameraOval] \(escaped)\")"
    DispatchQueue.main.async { webView.evaluateJavaScript(js, completionHandler: nil) }
}

final class CameraOvalEmbeddedView: UIView {

    var onSetupFailure: ((String) -> Void)?
    var onSessionStarted: (() -> Void)?
    weak var webView: WKWebView?

    private(set) var cameraPosition: AVCaptureDevice.Position = .front
    // OVAL is used by the face scanner. RECT is used by the Food Scanner's
    // full-screen camera, where the native preview must fill the viewport with
    // no oval/frame clipping.
    private(set) var previewShape: String = "OVAL"
    private(set) var adaptiveZoomEnabled: Bool = true
    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let maskLayer = CAShapeLayer()
    private var configured = false
    private let sessionQueue = DispatchQueue(label: "ai.facemax.cameraoval.session")

    private var pendingCaptureCompletion: ((String?, String?) -> Void)?

    // True once AVCaptureSession is running AND auto-exposure has stabilised.
    // Capture requests that arrive before this is true are queued and fired
    // automatically once the camera is ready. We use KVO on isAdjustingExposure
    // instead of a fixed timer so capture fires as soon as AE actually converges
    // (typically 150–300 ms) — no artificial wait added.
    private var isSessionReady = false
    private var pendingCaptureDeferral: (() -> Void)?
    private var aeObservation: NSKeyValueObservation?
    private var aeDevice: AVCaptureDevice?

    // width / height of the oval the preview is being clipped to. Used to
    // correct the zoom target for the actual visible aspect ratio (the oval
    // is taller than it is wide, so the vertical FOV — not the horizontal
    // FOV reported by AVFoundation — is what determines how much of the
    // face is visible with .resizeAspectFill).
    private var ovalAspectRatio: CGFloat = 230.0 / 300.0

    func configure(position: AVCaptureDevice.Position, ovalAspectRatio: CGFloat? = nil, shape: String = "OVAL", adaptiveZoom: Bool = true) {
        cameraPosition = position
        previewShape = (shape.uppercased() == "RECT") ? "RECT" : "OVAL"
        adaptiveZoomEnabled = adaptiveZoom
        if let ratio = ovalAspectRatio, ratio > 0 {
            self.ovalAspectRatio = ratio
        }
        // Stay transparent until the session is running and first frames arrive.
        // If we set .black here the dark native view shows through the transparent
        // WebView immediately — that IS the black screen. We switch to .black only
        // once onSessionStarted fires (i.e. the preview layer has live pixels).
        backgroundColor = .clear
        // Face scan keeps the existing CSS-matched oval mask; Food Scanner
        // requests RECT so the live rear-camera preview is truly full-screen.
        layer.mask = (previewShape == "RECT") ? nil : maskLayer

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        self.layer.insertSublayer(layer, at: 0)
        previewLayer = layer

        // insertEmbedded() sets `frame`/calls updateLayout() BEFORE configure()
        // runs (so the view has its on-screen size as early as possible), which
        // means `previewLayer` didn't exist yet when that updateLayout() ran —
        // its `frame`/mask were never applied and stayed at CGRect.zero forever
        // (nothing calls updateLayout() again unless the rect changes later).
        // Session frames were still captured fine (AVCapturePhotoOutput reads
        // straight from the sensor, independent of the preview layer's frame),
        // which is why a tapped photo came out correctly while the live preview
        // stayed an invisible/black zero-size layer the whole time. Apply the
        // current bounds/mask to the freshly-created layer right now so the
        // preview actually has a non-zero frame from the start.
        updateLayout()

        sessionQueue.async { [weak self] in
            self?.setupSession()
        }
    }

    private func setupSession() {
        session.beginConfiguration()
        // .high (not .photo) — full 12MP+ sensor resolution isn't needed for
        // face-analysis photos and directly inflates decode/redraw/encode
        // time on every capture (the photo delegate has to process whatever
        // resolution comes out of the session).
        session.sessionPreset = .high

        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera,
                                                    for: .video,
                                                    position: cameraPosition)
        else {
            session.commitConfiguration()
            let pos = cameraPosition == .front ? "front" : "back"
            DispatchQueue.main.async { [weak self] in
                fmLog(self?.webView, "error", "setupSession FAILED: no AVCaptureDevice for \(pos)")
                self?.onSetupFailure?("no AVCaptureDevice found for position \(pos)")
            }
            return
        }
        guard let input = try? AVCaptureDeviceInput(device: device) else {
            session.commitConfiguration()
            DispatchQueue.main.async { [weak self] in
                fmLog(self?.webView, "error", "setupSession FAILED: couldn't create AVCaptureDeviceInput")
                self?.onSetupFailure?("couldn't create AVCaptureDeviceInput")
            }
            return
        }
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            DispatchQueue.main.async { [weak self] in
                fmLog(self?.webView, "error", "setupSession FAILED: session.canAddInput returned false")
                self?.onSetupFailure?("session.canAddInput returned false")
            }
            return
        }
        session.addInput(input)
        if session.canAddOutput(photoOutput) {
            session.addOutput(photoOutput)
            // sessionPreset (.high, ~1080p) only governs the LIVE PREVIEW
            // stream — it does not cap what AVCapturePhotoOutput is allowed
            // to capture. AVCapturePhotoOutput pulls its still image from
            // the sensor on a separate path (this is also why a tapped
            // photo already came out correctly even when the preview layer
            // was broken — see the comment in configure() above). So we can
            // ask specifically for the photo output's max-resolution still
            // here, and it costs nothing on the preview/zoom side: the
            // preview keeps rendering at .high, AVCaptureVideoPreviewLayer
            // is untouched, and applyAdaptiveZoom() below still operates on
            // the same activeFormat/videoZoomFactor as before — zoom amount
            // is completely unrelated to this setting.
            //
            // This does NOT add latency to capture(): max photo dimensions
            // are negotiated once here, during setupSession(), not
            // per-shot. The shutter call in fireCapture() is unchanged.
            if #available(iOS 16.0, *) {
                // Resolution capped to session preset (.high ≈ 1920×1440) —
                // full 12MP+ causes 3-4 s of CPU work (decode → redraw → base64).
                // For face analysis 1920px is more than sufficient.
            } else {
                // isHighResolutionCaptureEnabled intentionally NOT set —
                // keeps output at session preset resolution for fast processing.
            }
        }
        session.commitConfiguration()

        // Force continuous auto-exposure and auto-white-balance BEFORE
        // startRunning so the sensor locks on correct values immediately.
        // Without this, the first ~1-2 seconds produce dark or colour-shifted
        // frames as the AE/AWB converges from a cold state.
        do {
            try device.lockForConfiguration()
            if device.isExposureModeSupported(.continuousAutoExposure) {
                device.exposureMode = .continuousAutoExposure
            }
            if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                device.whiteBalanceMode = .continuousAutoWhiteBalance
            }
            if device.isFocusModeSupported(.continuousAutoFocus) {
                device.focusMode = .continuousAutoFocus
            }
            device.unlockForConfiguration()
        } catch {
            print("[CameraOval] could not configure AE/AWB/AF: \(error)")
        }

        DispatchQueue.main.async { [weak self] in fmLog(self?.webView, "info", "session.startRunning() called — waiting for first frame") }
        session.startRunning()

        // Capture the exact device instance that's actually running in the
        // session (not a fresh lookup) so the zoom math always matches the
        // live activeFormat — some devices expose more than one physical
        // front camera / format combination, so re-querying by position
        // could in theory resolve to a different device.
        let liveDevice = device

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.previewLayer?.connection?.automaticallyAdjustsVideoMirroring = false
            self.previewLayer?.connection?.isVideoMirrored = (self.cameraPosition == .front)
            // The adaptive face-framing zoom is useful only for the oval selfie
            // camera. A meal camera must show the real rear-camera field of view.
            if self.adaptiveZoomEnabled && self.previewShape != "RECT" {
                self.applyAdaptiveZoom(to: liveDevice)
            }
            // Notify insertEmbedded that the session is running and first frames
            // are arriving. The JS promise only resolves at this point, so the
            // webview never goes transparent before there is a real camera feed
            // behind it (= no black screen flash on open).
            fmLog(self.webView, "info", "onSessionStarted fired — camera feed live, WebView going transparent")
            // Now that live frames are rendering, switch background to black
            // so the area outside the oval mask looks correct.
            self.backgroundColor = .black
            self.onSessionStarted?()
            self.onSessionStarted = nil
        }

        // Wait for AE to actually converge using KVO on isAdjustingExposure,
        // instead of a fixed ~400 ms blind timer. This fires as soon as the
        // sensor settles (typically 150–300 ms after startRunning), so capture()
        // can be triggered immediately after — no artificial wait. A 1.5 s
        // fallback timer ensures we never block capture forever if KVO misfires.
        aeDevice = device
        let fallback = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.aeObservation?.invalidate()
            self.aeObservation = nil
            self.aeDevice = nil
            self.markSessionReady()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: fallback)

        aeObservation = device.observe(\.isAdjustingExposure, options: [.new]) { [weak self] dev, _ in
            // isAdjustingExposure transitions: true (converging) → false (settled).
            guard !dev.isAdjustingExposure else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                fallback.cancel()
                self.aeObservation?.invalidate()
                self.aeObservation = nil
                self.aeDevice = nil
                self.markSessionReady()
            }
        }
    }

    private func markSessionReady() {
        guard !isSessionReady else { return }
        isSessionReady = true
        if let deferred = pendingCaptureDeferral {
            pendingCaptureDeferral = nil
            deferred()
        }
    }

    // Adaptive zoom: target a consistent effective FOV so the face fills the
    // oval similarly on every iPhone front camera.
    //
    // AVFoundation's `videoFieldOfView` is the camera's HORIZONTAL field of
    // view. Our preview is clipped to an oval that's taller than it is wide
    // (~230:300) and uses `.resizeAspectFill`, so it's the VERTICAL extent of
    // the frame that actually determines how tightly the face is cropped.
    // We convert the horizontal FOV to an equivalent vertical FOV using the
    // oval's aspect ratio before comparing it to our target, so the result
    // is correct regardless of how wide a given iPhone's front camera is.
    //
    // Newer iPhones (12+) have wider front cameras (~80-93 deg horizontal
    // FOV) while older models (X/XS/11) are ~73 deg. A fixed zoom over-crops
    // on narrower sensors and under-crops on wide ones — this adapts per
    // device using its own reported activeFormat.
    private func applyAdaptiveZoom(to device: AVCaptureDevice) {
        let toRad: CGFloat = .pi / 180.0
        let horizontalFOV = CGFloat(device.activeFormat.videoFieldOfView)

        // Convert horizontal FOV -> vertical FOV for this aspect ratio:
        // tan(vFOV/2) = tan(hFOV/2) * (height/width) = tan(hFOV/2) / aspectRatio
        let halfHorizontalRad = horizontalFOV / 2 * toRad
        let verticalFOV = 2 * atan(tan(halfHorizontalRad) / ovalAspectRatio) / toRad

        // Target vertical FOV that frames a face consistently inside the oval.
        let targetVerticalFOV: CGFloat = 70.0

        let computedZoom = tan(verticalFOV / 2 * toRad) / tan(targetVerticalFOV / 2 * toRad)

        // Clamp to a sane range. Raised the ceiling from the old 2.5 to 3.0
        // to leave headroom for future iPhones with even wider front cameras
        // — without headroom the zoom would silently stop tracking FOV
        // increases and the face would appear smaller than intended.
        let minZoom: CGFloat = 1.0
        let maxZoom: CGFloat = 3.0
        let target = min(max(computedZoom, minZoom), maxZoom)
        let deviceMaxZoom = device.activeFormat.videoMaxZoomFactor
        let zoom = min(target, deviceMaxZoom)

        if target > maxZoom || target < minZoom {
            print("[CameraOval] adaptive zoom hit clamp range: computed=\(computedZoom) clampedTo=\(target) (range \(minZoom)-\(maxZoom))")
        }
        if zoom < target {
            print("[CameraOval] adaptive zoom limited by device.videoMaxZoomFactor: wanted=\(target) deviceMax=\(deviceMaxZoom)")
        }

        guard zoom > 1.0 else { return }
        do {
            try device.lockForConfiguration()
            device.videoZoomFactor = zoom
            device.unlockForConfiguration()
        } catch {
            print("[CameraOval] failed to lock device for zoom configuration: \(error)")
        }
    }

    // Call whenever the HTML oval's rect changes (resize/scroll/orientation).
    func updateLayout() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        previewLayer?.frame = bounds
        if previewShape == "RECT" {
            // Full-screen Food Scanner camera: no native clipping/mask at all.
            layer.mask = nil
            maskLayer.path = nil
            maskLayer.frame = .zero
            CATransaction.commit()
            return
        }
        layer.mask = maskLayer
        // The HTML `.cap-oval` uses CSS `border-radius: 50% / 42%`, which is
        // NOT a true ellipse — it's a rounded rect whose corners are
        // elliptical arcs with rx = 50% of width and ry = 42% of height.
        // Because rx*2 == width, the left/right edges collapse to points
        // (so it still looks "oval"), but ry*2 (84% of height) is LESS than
        // the full height, leaving short straight vertical segments at the
        // top and bottom. A plain UIBezierPath(ovalIn:) draws a true ellipse
        // instead, which is visibly narrower/more pointed than the CSS shape
        // — that's why the live camera oval looked like a different shape
        // than the static EXAMPLE oval. This builds the exact same
        // rounded-rect-with-elliptical-corners shape CSS produces.
        let path = cssRoundedOvalPath(in: bounds, rxFraction: 0.5, ryFraction: 0.42)
        maskLayer.path = path.cgPath
        maskLayer.frame = bounds
        CATransaction.commit()
    }

    // Builds a path equivalent to CSS `border-radius: <rxFraction*100>% / <ryFraction*100>%`
    // applied to `rect` — a rectangle with elliptical-arc corners (rx, ry),
    // straight edges where the arcs don't meet, matching CSS's exact rounding
    // algorithm (radii are not allowed to overlap/overshoot the rect).
    private func cssRoundedOvalPath(in rect: CGRect, rxFraction: CGFloat, ryFraction: CGFloat) -> UIBezierPath {
        let rx = min(rect.width * rxFraction, rect.width / 2)
        let ry = min(rect.height * ryFraction, rect.height / 2)
        let minX = rect.minX, maxX = rect.maxX, minY = rect.minY, maxY = rect.maxY

        let path = UIBezierPath()
        // Start at top edge, just right of the top-left corner's arc.
        path.move(to: CGPoint(x: minX + rx, y: minY))
        // Top edge -> top-right corner.
        path.addLine(to: CGPoint(x: maxX - rx, y: minY))
        path.addCurve(to: CGPoint(x: maxX, y: minY + ry),
                      controlPoint1: CGPoint(x: maxX - rx * (1 - 0.5523), y: minY),
                      controlPoint2: CGPoint(x: maxX, y: minY + ry * (1 - 0.5523)))
        // Right edge -> bottom-right corner.
        path.addLine(to: CGPoint(x: maxX, y: maxY - ry))
        path.addCurve(to: CGPoint(x: maxX - rx, y: maxY),
                      controlPoint1: CGPoint(x: maxX, y: maxY - ry * (1 - 0.5523)),
                      controlPoint2: CGPoint(x: maxX - rx * (1 - 0.5523), y: maxY))
        // Bottom edge -> bottom-left corner.
        path.addLine(to: CGPoint(x: minX + rx, y: maxY))
        path.addCurve(to: CGPoint(x: minX, y: maxY - ry),
                      controlPoint1: CGPoint(x: minX + rx * (1 - 0.5523), y: maxY),
                      controlPoint2: CGPoint(x: minX, y: maxY - ry * (1 - 0.5523)))
        // Left edge -> top-left corner.
        path.addLine(to: CGPoint(x: minX, y: minY + ry))
        path.addCurve(to: CGPoint(x: minX + rx, y: minY),
                      controlPoint1: CGPoint(x: minX, y: minY + ry * (1 - 0.5523)),
                      controlPoint2: CGPoint(x: minX + rx * (1 - 0.5523), y: minY))
        path.close()
        return path
    }

    func capture(completion: @escaping (String?, String?) -> Void) {
        guard !session.inputs.isEmpty else {
            completion(nil, "capture called but session has no inputs")
            return
        }

        // If AE/AWB hasn't finished warming up, defer the actual shutter
        // until it has (max ~400 ms from session start — the user won't
        // notice because the preview is already live). This eliminates the
        // "5-second wait" caused by capture() queuing behind startRunning()
        // on the serial sessionQueue before the session was even running.
        guard isSessionReady else {
            pendingCaptureDeferral = { [weak self] in
                self?.fireCapture(completion: completion)
            }
            return
        }
        fireCapture(completion: completion)
    }

    private func fireCapture(completion: @escaping (String?, String?) -> Void) {
        pendingCaptureCompletion = completion
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            if self.photoOutput.availablePhotoCodecTypes.contains(.jpeg) {
                let s = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
                // maxPhotoDimensions intentionally NOT set on the per-shot
                // settings — output stays at session preset (.high ≈ 1920×1440)
                // which is ample for face analysis and keeps decode/encode fast.
                // Auto image stabilisation reduces blur from hand tremor
                // without adding latency (the shutter still fires immediately).
                if self.photoOutput.isStillImageStabilizationSupported {
                    s.isAutoStillImageStabilizationEnabled = true
                }
                self.photoOutput.capturePhoto(with: s, delegate: self)
            } else {
                self.photoOutput.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
            }
        }
    }

    // hideOnly: just hides the view, keeps session + isSessionReady intact for instant reopen.
    // Full stop (hideOnly=false) is only called when truly tearing down (e.g. app goes background).
    func stop(hideOnly: Bool = true, completion: (() -> Void)? = nil) {
        if hideOnly {
            // Session stays running and warm — next startEmbedded reuses it instantly.
            pendingCaptureDeferral = nil
            completion?()
            return
        }
        // Full teardown
        isSessionReady = false
        pendingCaptureDeferral = nil
        aeObservation?.invalidate()
        aeObservation = nil
        aeDevice = nil
        sessionQueue.async { [weak self] in
            self?.session.stopRunning()
            DispatchQueue.main.async {
                completion?()
            }
        }
    }
}

extension CameraOvalEmbeddedView: AVCapturePhotoCaptureDelegate {
    func photoOutput(_ output: AVCapturePhotoOutput,
                     didFinishProcessingPhoto photo: AVCapturePhoto,
                     error: Error?) {
        let completion = pendingCaptureCompletion
        pendingCaptureCompletion = nil
        let position = cameraPosition

        guard error == nil, let data = photo.fileDataRepresentation() else {
            let reason = error?.localizedDescription ?? "no fileDataRepresentation"
            DispatchQueue.main.async { completion?(nil, "photo capture failed: \(reason)") }
            return
        }

        // All of the work below (JPEG decode, two full-image redraws, JPEG
        // re-encode, base64 encode) is CPU-heavy on a full-resolution photo
        // (several MB). AVCapturePhotoCaptureDelegate callbacks land on the
        // main thread by default, so doing this work inline here used to
        // freeze the UI — and the live camera preview along with it, which
        // is what looked like "the whole oval blinks" — for multiple
        // seconds after tapping capture. Do it on a background queue and
        // only hop back to main for the final completion call.
        DispatchQueue.global(qos: .userInitiated).async {
            // Step 1: decode raw JPEG
            guard let rawImage = UIImage(data: data) else {
                DispatchQueue.main.async { completion?(nil, "UIImage(data:) returned nil") }
                return
            }

            // Single redraw pass that both normalises EXIF orientation and
            // mirrors for the front camera. UIImage.draw() respects the
            // EXIF orientation tag while CGContext transforms (translate/
            // scale) operate on the raw pixel buffer, so doing the mirror
            // flip in the same CGContext that UIImage.draw() renders into
            // bakes in the correct orientation AND the mirror in one pass,
            // instead of one full-image redraw per step.
            let renderer = UIGraphicsImageRenderer(size: rawImage.size)
            let image = renderer.image { ctx in
                if position == .front {
                    ctx.cgContext.translateBy(x: rawImage.size.width, y: 0)
                    ctx.cgContext.scaleBy(x: -1, y: 1)
                }
                rawImage.draw(in: CGRect(origin: .zero, size: rawImage.size))
            }

            let base64 = image.jpegData(compressionQuality: 0.82)?.base64EncodedString() ?? ""
            DispatchQueue.main.async {
                completion?("data:image/jpeg;base64,\(base64)", nil)
            }
        }
    }
}

// MARK: - Debug alert helper

private func fmShowDebugAlert(_ title: String, _ message: String) {
    DispatchQueue.main.async {
        let keyWindow = UIApplication.shared.windows.first(where: { $0.isKeyWindow })
        guard var top = keyWindow?.rootViewController else { return }
        while let presented = top.presentedViewController { top = presented }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        top.present(alert, animated: true)
    }
}

// MARK: - Capacitor Plugin

@objc(CameraOvalPlugin)
public class CameraOvalPlugin: CAPPlugin {

    private var embeddedView: CameraOvalEmbeddedView?

    // ------------------------------------------------------------------
    // startEmbedded({ x, y, width, height, direction })
    // Inserts (or repositions, if already running) the live camera view
    // at the given CSS-pixel rect, behind the WKWebView's transparent
    // background so the HTML oval ring/labels show on top.
    // ------------------------------------------------------------------
    @objc func startEmbedded(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let webView = self.bridge?.webView else {
                call.reject("Bridge/webView unavailable")
                return
            }

            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:
                self.insertEmbedded(call: call, webView: webView)
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .video) { granted in
                    DispatchQueue.main.async {
                        if granted { self.insertEmbedded(call: call, webView: webView) }
                        else { call.reject("Camera permission denied") }
                    }
                }
            case .denied, .restricted:
                fmShowDebugAlert("Camera", "Camera permission denied. Enable it in Settings → Privacy → Camera.")
                call.reject("Camera permission denied")
            @unknown default:
                call.reject("Camera permission denied")
            }
        }
    }

    private func insertEmbedded(call: CAPPluginCall, webView: WKWebView) {
        let x = call.getDouble("x") ?? 0
        let y = call.getDouble("y") ?? 0
        let w = call.getDouble("width") ?? 0
        let h = call.getDouble("height") ?? 0
        guard w > 0, h > 0 else {
            call.reject("Invalid rect")
            return
        }
        let direction = call.getString("direction", "FRONT").uppercased()
        let position: AVCaptureDevice.Position = (direction == "BACK") ? .back : .front
        let shape = call.getString("shape", "OVAL").uppercased() == "RECT" ? "RECT" : "OVAL"
        let adaptiveZoom = call.getBool("adaptiveZoom") ?? true

        // webView is already made transparent once at app launch (see
        // ViewController.capacitorDidLoad) — repeating it here is a harmless
        // no-op safety net in case some Capacitor internals ever recreate
        // the webView's layer.
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear

        // One plugin instance serves both cameras. If we switch from the oval
        // FRONT selfie session to the full-screen BACK food session (or back),
        // the existing AVCaptureSession cannot simply be unhidden: it still has
        // the old physical camera input and mask. Tear that old session down and
        // create a fresh view for the requested mode. Same-mode reopens remain
        // warm/instant via stopEmbedded(hideOnly: true).
        if let existing = embeddedView, hasConfigured(existing),
           (existing.cameraPosition != position ||
            existing.previewShape != shape ||
            existing.adaptiveZoomEnabled != adaptiveZoom) {
            existing.stop(hideOnly: false) { [weak self, weak webView] in
                guard let self = self, let webView = webView else {
                    call.reject("Bridge/webView unavailable")
                    return
                }
                existing.removeFromSuperview()
                self.embeddedView = nil
                self.startEmbeddedView(call: call, webView: webView,
                                       frame: CGRect(x: x, y: y, width: w, height: h),
                                       position: position, shape: shape, adaptiveZoom: adaptiveZoom)
            }
            return
        }

        startEmbeddedView(call: call, webView: webView,
                          frame: CGRect(x: x, y: y, width: w, height: h),
                          position: position, shape: shape, adaptiveZoom: adaptiveZoom)
    }

    private func startEmbeddedView(call: CAPPluginCall, webView: WKWebView,
                                   frame: CGRect, position: AVCaptureDevice.Position,
                                   shape: String, adaptiveZoom: Bool) {
        let view: CameraOvalEmbeddedView
        if let existing = embeddedView {
            view = existing
        } else {
            view = CameraOvalEmbeddedView()
            view.onSetupFailure = { reason in
                fmShowDebugAlert("Camera", "Camera failed: \(reason)")
            }
            // Insert BELOW the webview so transparent HTML areas reveal the live
            // AVCapture preview while our custom HTML controls remain above it.
            if let superview = webView.superview {
                superview.insertSubview(view, belowSubview: webView)
            } else {
                webView.addSubview(view)
                webView.sendSubviewToBack(view)
            }
            embeddedView = view
        }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        view.frame = frame
        view.updateLayout()
        CATransaction.commit()

        if !hasConfigured(view) {
            markConfigured(view)
            let aspectRatio = frame.height > 0 ? CGFloat(frame.width / frame.height) : nil
            view.webView = webView
            view.onSessionStarted = {
                call.resolve()
            }
            view.configure(position: position, ovalAspectRatio: aspectRatio,
                           shape: shape, adaptiveZoom: adaptiveZoom)
        } else {
            // Same camera/mode: session stayed warm while hidden.
            view.isHidden = false
            view.updateLayout()
            call.resolve()
        }
    }

    // Track "already configured" without adding stored properties to the view
    // (kept simple via associated object).
    private static var configuredKey: UInt8 = 0
    private func hasConfigured(_ view: CameraOvalEmbeddedView) -> Bool {
        return (objc_getAssociatedObject(view, &CameraOvalPlugin.configuredKey) as? Bool) ?? false
    }
    private func markConfigured(_ view: CameraOvalEmbeddedView) {
        objc_setAssociatedObject(view, &CameraOvalPlugin.configuredKey, true, .OBJC_ASSOCIATION_RETAIN)
    }

    // ------------------------------------------------------------------
    // updateEmbeddedRect({ x, y, width, height })
    // Re-positions the live view (call on scroll/resize/orientation change).
    // ------------------------------------------------------------------
    @objc func updateEmbeddedRect(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let view = self.embeddedView else {
                call.reject("Not started")
                return
            }
            let x = call.getDouble("x") ?? Double(view.frame.origin.x)
            let y = call.getDouble("y") ?? Double(view.frame.origin.y)
            let w = call.getDouble("width") ?? Double(view.frame.width)
            let h = call.getDouble("height") ?? Double(view.frame.height)
            let newFrame = CGRect(x: x, y: y, width: w, height: h)

            // Skip no-op updates (the periodic resync timers fire even when
            // nothing moved) and, more importantly, set `frame` inside a
            // CATransaction with implicit actions disabled. UIView.frame
            // changes are implicitly animated by UIKit (~0.25s) unless this
            // is done — that implicit animation is exactly what produced the
            // visible "whole oval blinks" flicker every time this method ran
            // (on every resize/orientation event AND on the unconditional
            // 150ms/500ms resync timers from the JS side).
            guard newFrame != view.frame else {
                call.resolve()
                return
            }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            view.frame = newFrame
            view.updateLayout()
            CATransaction.commit()
            call.resolve()
        }
    }

    // ------------------------------------------------------------------
    // capture() -> { dataUrl }
    // ------------------------------------------------------------------
    @objc func capture(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let view = self.embeddedView else {
                call.reject("Not started")
                return
            }
            view.capture { dataUrl, error in
                if let url = dataUrl {
                    call.resolve(["dataUrl": url])
                } else {
                    call.reject(error ?? "Capture failed")
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // stopEmbedded() — hides the camera view WITHOUT stopping the AVCaptureSession.
    //
    // Keeping the session alive means the next startEmbedded() call skips the
    // expensive AVCaptureSession.startRunning() + AE warm-up (~2-4 s on cold start)
    // and resolves in <50 ms instead. The session is torn down only when the plugin
    // itself is deallocated, or when the app moves to background (handled by iOS
    // automatically — AVCaptureSession suspends in background automatically).
    // ------------------------------------------------------------------
    @objc func stopEmbedded(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { call.resolve(); return }
            guard let view = self.embeddedView else { call.resolve(); return }
            // Just hide — don't destroy. Session stays warm for next open.
            // hideOnly=true keeps isSessionReady intact so next capture is instant.
            view.isHidden = true
            view.stop(hideOnly: true)
            call.resolve()
        }
    }

    // ------------------------------------------------------------------
    // Legacy full-screen API kept for backward compatibility — some older
    // JS call sites may still call `open()`. Internally this now just runs
    // the embedded flow full-screen as a fallback.
    // ------------------------------------------------------------------
    @objc func open(_ call: CAPPluginCall) {
        call.reject("open() is deprecated — use startEmbedded()/capture()/stopEmbedded()")
    }
}
