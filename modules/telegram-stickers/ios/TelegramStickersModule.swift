import ExpoModulesCore
import UIKit

// Sends a sticker set to Telegram using its documented third-party import:
// the JSON payload goes on the general pasteboard under Telegram's own type,
// then tg://importStickers is opened.
// Constants mirror github.com/TelegramMessenger/TelegramStickersImport.
public class TelegramStickersModule: Module {
  private static let dataType = "org.telegram.third-party.stickerset"
  private static let importURL = URL(string: "tg://importStickers")!
  private static let schemeURL = URL(string: "tg://")!
  private static let expiration = TimeInterval(60)

  public func definition() -> ModuleDefinition {
    Name("TelegramStickers")

    AsyncFunction("isTelegramInstalled") { () -> Bool in
      var can = false
      DispatchQueue.main.sync {
        can = UIApplication.shared.canOpenURL(TelegramStickersModule.schemeURL)
      }
      return can
    }

    AsyncFunction("send") { (json: String) -> Bool in
      guard let data = json.data(using: .utf8) else {
        throw Exception(name: "EncodeError", description: "Could not encode the sticker set")
      }
      var opened = false
      DispatchQueue.main.sync {
        UIPasteboard.general.setItems(
          [[TelegramStickersModule.dataType: data]],
          options: [
            .localOnly: true,
            .expirationDate: NSDate(timeIntervalSinceNow: TelegramStickersModule.expiration),
          ]
        )
        let url = TelegramStickersModule.importURL
        if UIApplication.shared.canOpenURL(url) {
          UIApplication.shared.open(url, options: [:], completionHandler: nil)
          opened = true
        }
      }
      return opened
    }
  }
}
