import UIKit
import Capacitor

/// The app's root view controller. Exists only to register the plugins that
/// live in this target (npm plugins are found automatically, local ones are not).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(WidgetBridgePlugin())
    }
}
