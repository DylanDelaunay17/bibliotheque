import UIKit
import Capacitor

// Vue principale de l'appli : celle de Capacitor, plus le module de musique (MusicLibraryPlugin.swift).
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MusicLibraryPlugin())
    }
}
