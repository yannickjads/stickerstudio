import ExpoModulesCore
import UIKit

// Sends a third-party sticker pack to WhatsApp via its documented pasteboard
// interop (github.com/WhatsApp/stickers, iOS): JSON payload on the general
// pasteboard under WhatsApp's custom type, then open whatsapp://stickerPack.
public class WhatsAppStickersModule: Module {
  private static let pasteboardType = "net.whatsapp.third-party.sticker-pack"
  private static let whatsAppURL = URL(string: "whatsapp://stickerPack")!

  public func definition() -> ModuleDefinition {
    Name("WhatsAppStickers")

    AsyncFunction("isWhatsAppInstalled") { () -> Bool in
      var can = false
      DispatchQueue.main.sync {
        can = UIApplication.shared.canOpenURL(WhatsAppStickersModule.whatsAppURL)
      }
      return can
    }

    AsyncFunction("send") { (json: String) -> Bool in
      guard let data = json.data(using: .utf8) else {
        throw Exception(name: "EncodeError", description: "Could not encode pack JSON")
      }
      var opened = false
      DispatchQueue.main.sync {
        let pasteboard = UIPasteboard.general
        pasteboard.setItems(
          [[WhatsAppStickersModule.pasteboardType: data]],
          options: [
            UIPasteboard.OptionsKey.localOnly: true,
            UIPasteboard.OptionsKey.expirationDate: Date(timeIntervalSinceNow: 60),
          ]
        )
        let url = WhatsAppStickersModule.whatsAppURL
        if UIApplication.shared.canOpenURL(url) {
          UIApplication.shared.open(url, options: [:], completionHandler: nil)
          opened = true
        }
      }
      return opened
    }
  }
}
