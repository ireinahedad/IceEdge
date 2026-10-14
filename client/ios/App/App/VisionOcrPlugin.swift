import Foundation
import Capacitor
import UIKit
import Vision

/// SCAN_TICKET_PLAN § 2.1 — OCR on the device with Apple Vision. Free, offline,
/// and the image never leaves the phone.
///
/// Receives the screenshot as base64 (the Capacitor bridge only carries JSON),
/// returns one entry per text line: { text, box: {x,y,w,h}, confidence } with the
/// box in PIXELS of the image, origin top-left — the same shape Tesseract produces
/// on the web, so the JS segmentation (slipScan.ts) is shared.
///
/// JS side: client/src/app/services/ocr/visionOcr.ts. Registered in MainViewController.
/// Keep the recognition settings in sync with client/scripts/ocr-bench/vision-ocr.swift
/// (the benchmark runs the same request on a Mac).
@objc(VisionOcrPlugin)
public class VisionOcrPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VisionOcrPlugin"
    public let jsName = "VisionOcr"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "recognize", returnType: CAPPluginReturnPromise),
    ]

    private let queue = DispatchQueue(label: "com.arakice.visionocr", qos: .userInitiated)

    @objc func recognize(_ call: CAPPluginCall) {
        guard let b64 = call.getString("image"),
              let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
              let uiImage = UIImage(data: data),
              let cgImage = uiImage.cgImage else {
            call.reject("invalid image", "not_image")
            return
        }
        let orientation = CGImagePropertyOrientation(uiImage.imageOrientation)
        // Size of the image as displayed (after EXIF rotation): that is the space
        // Vision's normalized boxes refer to.
        let rotated = [.left, .leftMirrored, .right, .rightMirrored].contains(orientation)
        let width = Double(rotated ? cgImage.height : cgImage.width)
        let height = Double(rotated ? cgImage.width : cgImage.height)

        queue.async {
            let start = Date()
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            // Off: language correction "fixes" odds and lines (-110, o5.5, 1+).
            request.usesLanguageCorrection = false
            request.recognitionLanguages = Self.languages(for: request)

            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
            do {
                try handler.perform([request])
            } catch {
                call.reject("vision failed: \(error.localizedDescription)", "failed")
                return
            }

            var lines: [[String: Any]] = []
            for obs in request.results ?? [] {
                guard let best = obs.topCandidates(1).first else { continue }
                let text = best.string.trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty { continue }
                // Normalized, origin bottom-left → pixels, origin top-left.
                let bb = obs.boundingBox
                lines.append([
                    "text": text,
                    "confidence": (Double(best.confidence) * 1000).rounded() / 1000,
                    "box": [
                        "x": (bb.minX * width).rounded(),
                        "y": ((1 - bb.maxY) * height).rounded(),
                        "w": (bb.width * width).rounded(),
                        "h": (bb.height * height).rounded(),
                    ],
                ])
            }
            call.resolve([
                "lines": lines,
                "width": width,
                "height": height,
                "ms": (Date().timeIntervalSince(start) * 1000).rounded(),
            ])
        }
    }

    /// English first (bookmaker vocabulary), French for Québec tickets — only the
    /// ones this iOS version supports, or Vision throws.
    private static func languages(for request: VNRecognizeTextRequest) -> [String] {
        let wanted = ["en-US", "fr-FR"]
        let supported = (try? request.supportedRecognitionLanguages()) ?? []
        let usable = wanted.filter { supported.contains($0) }
        return usable.isEmpty ? ["en-US"] : usable
    }
}

private extension CGImagePropertyOrientation {
    init(_ o: UIImage.Orientation) {
        switch o {
        case .up: self = .up
        case .down: self = .down
        case .left: self = .left
        case .right: self = .right
        case .upMirrored: self = .upMirrored
        case .downMirrored: self = .downMirrored
        case .leftMirrored: self = .leftMirrored
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}
