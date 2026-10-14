// vision-ocr.swift — SCAN_TICKET_PLAN § 7 / S1. Apple Vision on the fixtures, on a Mac.
//
//   swift client/scripts/ocr-bench/vision-ocr.swift            all images/ of the fixtures
//   swift client/scripts/ocr-bench/vision-ocr.swift NAME...    some of them
//
// Writes server/src/services/__fixtures__/slipScan/ocr/vision/<name>.json (OcrResult),
// then `npm run ocr:bench -- --score-only` scores Vision against Tesseract.
//
// SAME request as the app: keep in sync with client/ios/App/App/VisionOcrPlugin.swift
// (.accurate, no language correction, en-US + fr-FR). Run from the repo root.
import AppKit
import Foundation
import Vision

let fixtures = URL(fileURLWithPath: "server/src/services/__fixtures__/slipScan", isDirectory: true)
let imagesDir = fixtures.appendingPathComponent("images")
let outDir = fixtures.appendingPathComponent("ocr/vision")
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let wanted = Set(CommandLine.arguments.dropFirst())
let exts: Set<String> = ["png", "jpg", "jpeg", "webp", "heic"]
let files = ((try? FileManager.default.contentsOfDirectory(at: imagesDir, includingPropertiesForKeys: nil)) ?? [])
    .filter { exts.contains($0.pathExtension.lowercased()) }
    .filter { wanted.isEmpty || wanted.contains($0.deletingPathExtension().lastPathComponent) }
    .sorted { $0.lastPathComponent < $1.lastPathComponent }

if files.isEmpty {
    print("vision-ocr: no image in \(imagesDir.path)")
    exit(0)
}

func json(_ s: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [s], options: [])
    let arr = String(data: data, encoding: .utf8)!
    return String(arr.dropFirst().dropLast())
}

for file in files {
    let name = file.deletingPathExtension().lastPathComponent
    guard let image = NSImage(contentsOf: file),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("✗ \(name): unreadable")
        continue
    }
    let width = Double(cg.width), height = Double(cg.height)
    let start = Date()
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    let supported = (try? request.supportedRecognitionLanguages()) ?? []
    let langs = ["en-US", "fr-FR"].filter { supported.contains($0) }
    request.recognitionLanguages = langs.isEmpty ? ["en-US"] : langs
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
    let ms = Int((Date().timeIntervalSince(start) * 1000).rounded())

    var rows: [(y: Double, x: Double, line: String)] = []
    for obs in request.results ?? [] {
        guard let best = obs.topCandidates(1).first else { continue }
        let text = best.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { continue }
        let bb = obs.boundingBox
        let x = (bb.minX * width).rounded(), y = ((1 - bb.maxY) * height).rounded()
        let w = (bb.width * width).rounded(), h = (bb.height * height).rounded()
        let conf = (Double(best.confidence) * 1000).rounded() / 1000
        rows.append((y + h / 2, x, "  {\"text\":\(json(text)),\"confidence\":\(conf),\"box\":{\"x\":\(Int(x)),\"y\":\(Int(y)),\"w\":\(Int(w)),\"h\":\(Int(h))}}"))
    }
    // Top to bottom; the JS side re-sorts by rows (ocrCore.sortOcrLines) anyway.
    rows.sort { $0.y == $1.y ? $0.x < $1.x : $0.y < $1.y }
    let body = "{\n \"engine\": \"vision\", \"width\": \(Int(width)), \"height\": \(Int(height)), \"ms\": \(ms),\n \"lines\": [\n"
        + rows.map { $0.line }.joined(separator: ",\n") + "\n ]\n}\n"
    try body.write(to: outDir.appendingPathComponent("\(name).json"), atomically: true, encoding: .utf8)
    print("✓ \(name): \(rows.count) lines, \(ms) ms")
}
