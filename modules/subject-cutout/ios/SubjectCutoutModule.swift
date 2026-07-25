import ExpoModulesCore
import Vision
import UIKit
import CoreImage

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

      guard let masked = try? result.generateMaskedImage(
        ofInstances: result.allInstances,
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
