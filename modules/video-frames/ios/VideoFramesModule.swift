import ExpoModulesCore
import AVFoundation
import UIKit

// Pulls evenly spaced frames out of a video so the GIF pipeline can treat a clip
// exactly like an animated image. Decoding is hardware-accelerated and frames are
// downscaled during extraction, which is far cheaper than decoding full-resolution
// frames and shrinking them afterwards.
public class VideoFramesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VideoFrames")

    AsyncFunction("info") { (uri: String) -> [String: Double] in
      guard let url = URL(string: uri) else {
        throw Exception(name: "BadURL", description: "Could not read that video")
      }
      let asset = AVURLAsset(url: url)
      let durationMs = CMTimeGetSeconds(asset.duration) * 1000.0
      var w = 0.0, h = 0.0
      if let track = asset.tracks(withMediaType: .video).first {
        // preferredTransform carries rotation: a portrait clip is stored landscape.
        let size = track.naturalSize.applying(track.preferredTransform)
        w = Double(abs(size.width))
        h = Double(abs(size.height))
      }
      return ["durationMs": durationMs.isFinite ? durationMs : 0, "width": w, "height": h]
    }

    // Writes `count` JPEG frames spanning [startMs, startMs+durationMs] into the
    // temp directory and returns their file:// urls, in order.
    AsyncFunction("extract") {
      (uri: String, startMs: Double, durationMs: Double, count: Int, maxSize: Int) -> [String] in
      guard let url = URL(string: uri), count > 0 else {
        throw Exception(name: "BadURL", description: "Could not read that video")
      }
      let asset = AVURLAsset(url: url)
      let gen = AVAssetImageGenerator(asset: asset)
      gen.appliesPreferredTrackTransform = true
      gen.maximumSize = CGSize(width: maxSize, height: maxSize)
      // Frame-accurate: without this AVFoundation snaps to the nearest keyframe and
      // several requested times collapse onto the same picture.
      gen.requestedTimeToleranceBefore = .zero
      gen.requestedTimeToleranceAfter = .zero

      let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("vframes-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

      var out: [String] = []
      let step = count > 1 ? durationMs / Double(count - 1) : 0
      for i in 0..<count {
        let ms = startMs + step * Double(i)
        let time = CMTime(seconds: ms / 1000.0, preferredTimescale: 600)
        guard let cg = try? gen.copyCGImage(at: time, actualTime: nil) else { continue }
        let data = UIImage(cgImage: cg).jpegData(compressionQuality: 0.92)
        guard let data else { continue }
        let file = dir.appendingPathComponent(String(format: "f%04d.jpg", i))
        try data.write(to: file)
        out.append(file.absoluteString)
      }
      if out.isEmpty {
        throw Exception(name: "NoFrames", description: "No frames could be read from that video")
      }
      return out
    }
  }
}
