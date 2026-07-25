import ExpoModulesCore
import UIKit

// A real UIAlertController with text fields: the system's own centred dialog,
// blur, border and animation. React Native's Alert.prompt only supports a single
// plain field, and a JS modal can never match the native look.
public class NativePromptModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativePrompt")

    // Resolves with one string per field, or nil when cancelled.
    AsyncFunction("prompt") {
      (title: String, message: String?, placeholders: [String], values: [String],
       confirmText: String, cancelText: String, promise: Promise) in
      DispatchQueue.main.async {
        guard let presenter = NativePromptModule.topViewController() else {
          promise.resolve(nil)
          return
        }
        let alert = UIAlertController(
          title: title,
          message: (message?.isEmpty ?? true) ? nil : message,
          preferredStyle: .alert
        )
        for (i, placeholder) in placeholders.enumerated() {
          alert.addTextField { field in
            field.placeholder = placeholder
            field.text = i < values.count ? values[i] : ""
            field.autocapitalizationType = .words
            field.clearButtonMode = .whileEditing
            field.returnKeyType = (i == placeholders.count - 1) ? .done : .next
            if i == 0 { field.becomeFirstResponder() }
          }
        }
        alert.addAction(UIAlertAction(title: cancelText, style: .cancel) { _ in
          promise.resolve(nil)
        })
        alert.addAction(UIAlertAction(title: confirmText, style: .default) { _ in
          promise.resolve((alert.textFields ?? []).map { $0.text ?? "" })
        })
        presenter.present(alert, animated: true)
      }
    }
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow }
      ?? scenes.first?.windows.first
    var top = window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}
