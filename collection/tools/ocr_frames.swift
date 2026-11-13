import Foundation
import AppKit
import Vision
let paths = CommandLine.arguments.dropFirst()
for path in paths {
 let url = URL(fileURLWithPath: path)
 guard let image = NSImage(contentsOf: url) else { continue }
 var rect = CGRect(origin: .zero, size: image.size)
 guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { continue }
 let req = VNRecognizeTextRequest()
 req.recognitionLevel = .accurate
 req.recognitionLanguages = ["zh-Hant", "zh-Hans", "en-US"]
 req.usesLanguageCorrection = true
 do {
  try VNImageRequestHandler(cgImage: cg).perform([req])
  let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
  print("--- \(url.lastPathComponent) ---")
  for line in lines { print(line) }
 } catch { print("--- \(url.lastPathComponent): OCR_ERROR \(error) ---") }
}
