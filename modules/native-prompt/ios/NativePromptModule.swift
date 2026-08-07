import ExpoModulesCore
import UIKit

public class NativePromptModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativePrompt")

    AsyncFunction("prompt") {
      (title: String, message: String?, placeholders: [String], values: [String],
       confirmText: String, cancelText: String, promise: Promise) in
      DispatchQueue.main.async {
        guard let presenter = NativePromptModule.topPresenter() else {
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
        NativePromptModule.safePresent(alert, on: presenter)
      }
    }

    AsyncFunction("actionSheet") {
      (title: String?, message: String?, labels: [String], destructive: [Int], promise: Promise) in
      DispatchQueue.main.async {
        guard let presenter = NativePromptModule.topPresenter() else {
          promise.resolve(nil)
          return
        }
        let alert = UIAlertController(
          title: (title?.isEmpty ?? true) ? nil : title,
          message: (message?.isEmpty ?? true) ? nil : message,
          preferredStyle: .actionSheet
        )
        for (i, label) in labels.enumerated() {
          let style: UIAlertAction.Style = destructive.contains(i) ? .destructive : .default
          alert.addAction(UIAlertAction(title: label, style: style) { [weak presenter] _ in
            guard let p = presenter else { promise.resolve(i); return }
            p.dismiss(animated: true) { promise.resolve(i) }
          })
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak presenter] _ in
          guard let p = presenter else { promise.resolve(nil); return }
          p.dismiss(animated: true) { promise.resolve(nil) }
        })
        if let pop = alert.popoverPresentationController {
          pop.sourceView = presenter.view
          pop.sourceRect = CGRect(
            x: presenter.view.bounds.midX,
            y: presenter.view.bounds.midY,
            width: 0, height: 0
          )
          pop.permittedArrowDirections = []
        }
        NativePromptModule.safePresent(alert, on: presenter)
      }
    }
  }

  private static func topPresenter() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow }
      ?? scenes.first?.windows.first
    var top = window?.rootViewController
    while let presented = top?.presentedViewController {
      if presented.isBeingDismissed { break }
      top = presented
    }
    return top
  }

  private static func safePresent(_ alert: UIAlertController, on presenter: UIViewController) {
    if presenter.presentedViewController != nil {
      presenter.dismiss(animated: false) {
        presenter.present(alert, animated: true)
      }
    } else {
      presenter.present(alert, animated: true)
    }
  }
}
