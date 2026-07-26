import ExpoModulesCore
import Vision
import UIKit
import CoreImage
import CoreVideo

// Lifts the subject off its background using the same on-device model as
// "lift subject from photo" in Photos. Nothing is uploaded and no model ships
// with the app — iOS already has it.
public class SubjectCutoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SubjectCutout")

    AsyncFunction("isSupported") { () -> Bool in
      if #available(iOS 17.0, *) { return true }
      return false // iOS 16 and older can only segment people, which is not enough
    }

    // Returns a file:// PNG with a transparent background, at the SAME pixel size
    // as the input so any crop rect measured against the original still applies.
    // nil when nothing recognisable stands out.
    AsyncFunction("cutout") { (uri: String) -> String? in
      guard #available(iOS 17.0, *) else { return nil }
      guard let url = URL(string: uri),
            let data = try? Data(contentsOf: url),
            let image = UIImage(data: data) else { return nil }

      // Bake in the orientation first: a portrait photo is stored landscape, and
      // every coordinate the app uses is in display space.
      let upright = SubjectCutoutModule.upright(image)
      guard let cg = upright.cgImage else { return nil }

      let handler = VNImageRequestHandler(cgImage: cg, options: [:])
      let request = VNGenerateForegroundInstanceMaskRequest()
      do {
        try handler.perform([request])
      } catch {
        return nil
      }
      guard let result = request.results?.first, !result.allInstances.isEmpty else { return nil }

      // Vision returns every foreground thing it found, which on a normal photo
      // means the person AND the cushion behind them. Keep the biggest instance
      // and anything comparable to it (two people in frame), drop the specks.
      let instances = SubjectCutoutModule.mainInstances(result)

      guard let masked = try? result.generateMaskedImage(
        ofInstances: instances,
        from: handler,
        croppedToInstancesExtent: false   // keep the original framing
      ) else { return nil }

      let ci = CIImage(cvPixelBuffer: masked)
      let context = CIContext()
      guard let png = context.pngRepresentation(
        of: ci, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB()
      ) else { return nil }

      let out = FileManager.default.temporaryDirectory
        .appendingPathComponent("cutout-\(UUID().uuidString).png")
      do { try png.write(to: out) } catch { return nil }
      return out.absoluteString
    }
  }

  /// The instances worth keeping: the largest, plus any at least a quarter of its
  /// size (two people in frame). Anything smaller is a stray object the model
  /// happened to notice — a cushion, a doorframe — which on a sticker reads as a
  /// blob floating next to the subject.
  ///
  /// Measured on `instanceMask`, the small label map where each pixel holds the
  /// index of the instance covering it, so all the areas come from one cheap pass
  /// rather than from generating a full-size mask per instance. Any surprise in
  /// its format falls back to keeping everything, i.e. the old behaviour.
  @available(iOS 17.0, *)
  private static func mainInstances(_ result: VNInstanceMaskObservation) -> IndexSet {
    let all = result.allInstances
    if all.count <= 1 { return all }

    let buffer = result.instanceMask
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_OneComponent8,
          let base = CVPixelBufferGetBaseAddress(buffer) else { return all }

    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    var areas = [Int](repeating: 0, count: 256)   // instance index -> pixels
    for y in 0..<height {
      let row = base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self)
      for x in 0..<width { areas[Int(row[x])] += 1 }
    }

    var largest = 0
    for i in all where i < 256 { largest = max(largest, areas[i]) }
    guard largest > 0 else { return all }

    var kept = IndexSet()
    for i in all where i < 256 && areas[i] * 4 >= largest { kept.insert(i) }
    return kept.isEmpty ? all : kept
  }

  private static func upright(_ image: UIImage) -> UIImage {
    if image.imageOrientation == .up { return image }
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = false
    return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: image.size))
    }
  }
}
