import Foundation
import Capacitor
import WidgetKit

/// APPLE_PLAN 4.2 — hands the widget what it needs to fetch « paris en cours »:
/// a read-only widget token, the API address and the app language. Written to
/// the App Group shared with the ArakIceWidget extension.
/// JS side: client/src/app/services/widgetBridge.ts. Registered in MainViewController.
@objc(WidgetBridgePlugin)
public class WidgetBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WidgetBridgePlugin"
    public let jsName = "WidgetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise),
    ]

    static let appGroup = "group.arakice.arakice.com"
    private var defaults: UserDefaults? { UserDefaults(suiteName: Self.appGroup) }

    @objc func setConfig(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), !token.isEmpty,
              let apiBase = call.getString("apiBase"), !apiBase.isEmpty else {
            call.reject("token and apiBase are required")
            return
        }
        let lang = call.getString("lang") == "en" ? "en" : "fr"
        guard let d = defaults else { call.reject("App Group unavailable"); return }
        let changed = d.string(forKey: "token") != token
            || d.string(forKey: "apiBase") != apiBase
            || d.string(forKey: "lang") != lang
        d.set(token, forKey: "token")
        d.set(apiBase, forKey: "apiBase")
        d.set(lang, forKey: "lang")
        // Redraw only when something changed: this runs on every launch.
        if changed { WidgetCenter.shared.reloadAllTimelines() }
        call.resolve()
    }

    @objc func clear(_ call: CAPPluginCall) {
        for key in ["token", "apiBase", "lang", "lastPayload"] { defaults?.removeObject(forKey: key) }
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func reload(_ call: CAPPluginCall) {
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }
}
