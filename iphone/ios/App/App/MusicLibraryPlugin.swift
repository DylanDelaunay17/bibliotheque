// Musique d'iCloud Drive pour l'appli (côté JavaScript : js/music.js).
//   status()           dossier choisi, nombre de titres, date de la dernière analyse
//   pickFolder()       choix du dossier dans Fichiers ; l'accès est gardé (signet de sécurité)
//   scan()             analyse du dossier : étiquettes des fichiers, sinon dossiers Artiste/Album
//   library()          titres trouvés à la dernière analyse (gardés dans Application Support)
//   artwork({path})    pochette intégrée au fichier, ou cover.jpg / folder.jpg du dossier
//   play({paths, index}), pause(), resume(), next(), previous(), stop()
//   événement « state » : { index, playing, position, duration, loading }
// La lecture continue écran verrouillé (UIBackgroundModes audio), avec les commandes de l'écran
// de verrouillage. Un fichier resté dans iCloud est téléchargé au moment de le jouer.
import Foundation
import Capacitor
import AVFoundation
import MediaPlayer
import UIKit
import UniformTypeIdentifiers

@objc(MusicLibraryPlugin)
public class MusicLibraryPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "MusicLibraryPlugin"
    public let jsName = "MusicLibrary"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "library", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "artwork", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "next", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "previous", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private static let audioExtensions: Set<String> = ["mp3", "m4a", "m4b", "aac", "flac", "alac", "wav", "aif", "aiff", "caf", "mp4"]
    private static let coverNames = ["cover", "folder", "front", "album", "artwork"]
    private let bookmarkKey = "musicFolderBookmark"

    private var root: URL?
    private var tracks: [[String: Any]] = []
    private var pickCall: CAPPluginCall?

    // Lecture
    private let player = AVPlayer()
    private var queue: [String] = []
    private var index = 0
    private var loading = false
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var nowArtwork: MPMediaItemArtwork?

    override public func load() {
        restoreFolder()
        tracks = loadCache()
        setupRemoteCommands()
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 2), queue: .main) { [weak self] _ in
            self?.emitState()
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            guard let self = self, (note.object as? AVPlayerItem) === self.player.currentItem else { return }
            if self.index + 1 < self.queue.count { self.start(at: self.index + 1) } else { self.emitState() }
        }
    }

    // MARK: - Dossier

    private func restoreFolder() {
        guard let data = UserDefaults.standard.data(forKey: bookmarkKey) else { return }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return }
        _ = url.startAccessingSecurityScopedResource() // gardé ouvert tant que l'appli tourne
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            UserDefaults.standard.set(fresh, forKey: bookmarkKey)
        }
        root = url
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve([
            "folder": root?.lastPathComponent ?? NSNull(),
            "count": tracks.count,
            "scannedAt": UserDefaults.standard.double(forKey: "musicScannedAt"),
        ])
    }

    @objc func pickFolder(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.pickCall = call
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickCall, let url = urls.first else { return }
        pickCall = nil
        root?.stopAccessingSecurityScopedResource()
        guard url.startAccessingSecurityScopedResource(),
              let data = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) else {
            call.reject("Accès au dossier refusé")
            return
        }
        UserDefaults.standard.set(data, forKey: bookmarkKey)
        root = url
        call.resolve(["folder": url.lastPathComponent])
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickCall?.resolve(["folder": root?.lastPathComponent ?? NSNull(), "cancelled": true])
        pickCall = nil
    }

    // MARK: - Analyse

    @objc func library(_ call: CAPPluginCall) {
        call.resolve(["tracks": tracks])
    }

    @objc func scan(_ call: CAPPluginCall) {
        guard let root = root else { return call.reject("Aucun dossier choisi") }
        Task.detached(priority: .userInitiated) {
            var found: [[String: Any]] = []
            for url in Self.audioFiles(in: root) {
                found.append(await Self.describe(url, root: root))
            }
            await MainActor.run {
                self.tracks = found
                self.saveCache(found)
                UserDefaults.standard.set(Date().timeIntervalSince1970 * 1000, forKey: "musicScannedAt")
                call.resolve(["count": found.count])
            }
        }
    }

    /// Fichiers audio du dossier et de ses sous-dossiers. Sur les anciens iOS, un fichier resté
    /// dans iCloud apparaît comme « .Titre.mp3.icloud » : on le compte sous son vrai nom.
    private static func audioFiles(in root: URL) -> [URL] {
        let keys: [URLResourceKey] = [.isRegularFileKey]
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys) else { return [] }
        var files: [URL] = []
        for case let url as URL in walker {
            var name = url.lastPathComponent
            if name.hasPrefix("."), name.hasSuffix(".icloud") {
                name = String(name.dropFirst().dropLast(7))
            } else if name.hasPrefix(".") {
                continue
            }
            let real = url.deletingLastPathComponent().appendingPathComponent(name)
            if audioExtensions.contains(real.pathExtension.lowercased()) { files.append(real) }
        }
        return files.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }

    private static func isDownloaded(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey]),
              values.isUbiquitousItem == true else { return FileManager.default.fileExists(atPath: url.path) }
        return values.ubiquitousItemDownloadingStatus == .current
    }

    /// Étiquettes du fichier s'il est sur le téléphone ; sinon (ou s'il en manque) les dossiers :
    /// …/Artiste/Album/01 Titre.mp3.
    private static func describe(_ url: URL, root: URL) async -> [String: Any] {
        let rel = String(url.path.dropFirst(root.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let parts = rel.split(separator: "/").map(String.init)
        let base = url.deletingPathExtension().lastPathComponent
        let numbered = base.range(of: #"^(\d{1,2})[-. ]*\d{0,2}[ ._-]+"#, options: .regularExpression)
        var info: [String: Any] = [
            "path": rel,
            "title": numbered.map { String(base[$0.upperBound...]) } ?? base,
            "album": parts.count >= 2 ? parts[parts.count - 2] : "",
            "artist": parts.count >= 3 ? parts[parts.count - 3] : "",
            "track": Int(base.prefix(while: { $0.isNumber }).prefix(2)) ?? 0,
            "disc": 1,
            "duration": 0,
            "local": isDownloaded(url),
        ]
        guard info["local"] as? Bool == true else { return info }

        let asset = AVURLAsset(url: url)
        if let duration = try? await asset.load(.duration), duration.isNumeric {
            info["duration"] = Int(duration.seconds * 1000)
        }
        var items: [AVMetadataItem] = (try? await asset.load(.commonMetadata)) ?? []
        if let all = try? await asset.load(.metadata) { items += all }
        let number = { (s: String) -> Int? in Int(s.split(separator: "/").first.map(String.init) ?? "") }
        for item in items {
            let value = (try? await item.load(.stringValue))?.trimmingCharacters(in: .whitespaces) ?? ""
            let key = (item.key as? String ?? "").uppercased() // FLAC : commentaires Vorbis
            if item.identifier == .iTunesMetadataTrackNumber || item.identifier == .iTunesMetadataDiscNumber {
                // Données binaires : [0, 0, numéro (2 octets), total (2 octets), …]
                if let data = try? await item.load(.dataValue), data.count >= 4 {
                    let n = Int(data[data.startIndex + 2]) << 8 | Int(data[data.startIndex + 3])
                    if n > 0 { info[item.identifier == .iTunesMetadataTrackNumber ? "track" : "disc"] = n }
                }
                continue
            }
            if value.isEmpty { continue }
            if item.identifier == .iTunesMetadataAlbumArtist || item.identifier == .id3MetadataBand || key == "ALBUMARTIST" || key == "ALBUM ARTIST" {
                info["albumArtist"] = value
                info["artist"] = value
            } else if item.commonKey == .commonKeyTitle {
                info["title"] = value
            } else if item.commonKey == .commonKeyAlbumName {
                info["album"] = value
            } else if item.commonKey == .commonKeyArtist {
                if info["albumArtist"] == nil { info["artist"] = value }
            } else if item.identifier == .id3MetadataTrackNumber || key == "TRACKNUMBER" {
                if let n = number(value) { info["track"] = n }
            } else if item.identifier == .id3MetadataPartOfASet || key == "DISCNUMBER" {
                if let n = number(value) { info["disc"] = n }
            }
        }
        return info
    }

    private var cacheURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("music-library.json")
    }

    private func loadCache() -> [[String: Any]] {
        guard let data = try? Data(contentsOf: cacheURL),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return list
    }

    private func saveCache(_ list: [[String: Any]]) {
        if let data = try? JSONSerialization.data(withJSONObject: list) { try? data.write(to: cacheURL, options: .atomic) }
    }

    // MARK: - Pochettes

    @objc func artwork(_ call: CAPPluginCall) {
        guard let root = root, let path = call.getString("path") else { return call.reject("Chemin manquant") }
        let size = CGFloat(call.getInt("size") ?? 420)
        Task.detached(priority: .utility) {
            let url = root.appendingPathComponent(path)
            guard let image = await Self.coverImage(for: url) else { return call.resolve(["dataUrl": ""]) }
            let jpeg = Self.resized(image, max: size).jpegData(compressionQuality: 0.78) ?? Data()
            call.resolve(["dataUrl": "data:image/jpeg;base64," + jpeg.base64EncodedString()])
        }
    }

    private static func coverImage(for url: URL) async -> UIImage? {
        if isDownloaded(url) {
            let asset = AVURLAsset(url: url)
            let items = ((try? await asset.load(.commonMetadata)) ?? []) + ((try? await asset.load(.metadata)) ?? [])
            for item in items where item.commonKey == .commonKeyArtwork || (item.key as? String ?? "").uppercased() == "METADATA_BLOCK_PICTURE" {
                if let data = try? await item.load(.dataValue), let image = UIImage(data: data) { return image }
            }
        }
        // Image posée à côté des fichiers (téléchargée si elle est restée dans iCloud)
        let dir = url.deletingLastPathComponent()
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        for name in names {
            var real = name
            if real.hasPrefix("."), real.hasSuffix(".icloud") { real = String(real.dropFirst().dropLast(7)) }
            let stem = (real as NSString).deletingPathExtension.lowercased()
            let ext = (real as NSString).pathExtension.lowercased()
            guard coverNames.contains(stem), ["jpg", "jpeg", "png"].contains(ext) else { continue }
            let file = dir.appendingPathComponent(real)
            if await ensureDownloaded(file, timeout: 20), let image = UIImage(contentsOfFile: file.path) { return image }
        }
        return nil
    }

    private static func resized(_ image: UIImage, max: CGFloat) -> UIImage {
        let scale = min(1, max / Swift.max(image.size.width, image.size.height))
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }

    /// Demande à iCloud de télécharger le fichier et attend qu'il soit là.
    private static func ensureDownloaded(_ url: URL, timeout: TimeInterval) async -> Bool {
        if isDownloaded(url) { return true }
        try? FileManager.default.startDownloadingUbiquitousItem(at: url)
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            try? await Task.sleep(nanoseconds: 300_000_000)
            var fresh = url
            fresh.removeAllCachedResourceValues()
            if isDownloaded(fresh) { return true }
        }
        return false
    }

    // MARK: - Lecture

    @objc func play(_ call: CAPPluginCall) {
        guard root != nil else { return call.reject("Aucun dossier choisi") }
        let paths = call.getArray("paths", String.self) ?? []
        guard !paths.isEmpty else { return call.reject("Aucun titre") }
        DispatchQueue.main.async {
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try? AVAudioSession.sharedInstance().setActive(true)
            self.queue = paths
            self.start(at: min(max(call.getInt("index") ?? 0, 0), paths.count - 1))
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) { DispatchQueue.main.async { self.player.pause(); self.emitState(); call.resolve() } }
    @objc func resume(_ call: CAPPluginCall) { DispatchQueue.main.async { self.player.play(); self.emitState(); call.resolve() } }
    @objc func next(_ call: CAPPluginCall) { DispatchQueue.main.async { self.skip(1); call.resolve() } }
    @objc func previous(_ call: CAPPluginCall) { DispatchQueue.main.async { self.skip(-1); call.resolve() } }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player.pause()
            self.player.replaceCurrentItem(with: nil)
            self.queue = []
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            self.emitState()
            call.resolve()
        }
    }

    private func skip(_ dir: Int) {
        // « Précédent » après 3 secondes : retour au début du titre, comme partout ailleurs.
        if dir < 0, player.currentTime().seconds > 3 { player.seek(to: .zero); return }
        let i = index + dir
        if i >= 0 && i < queue.count { start(at: i) }
    }

    private func start(at i: Int) {
        guard let root = root else { return }
        index = i
        loading = true
        player.pause()
        emitState()
        let path = queue[i]
        let url = root.appendingPathComponent(path)
        Task { @MainActor in
            let ok = await Self.ensureDownloaded(url, timeout: 120)
            guard self.index == i, self.queue.indices.contains(i), self.queue[i] == path else { return } // autre titre demandé entre-temps
            self.loading = false
            guard ok else {
                self.notifyListeners("error", data: ["message": "Fichier indisponible dans iCloud", "path": path])
                if i + 1 < self.queue.count { self.start(at: i + 1) } else { self.emitState() }
                return
            }
            self.player.replaceCurrentItem(with: AVPlayerItem(url: url))
            self.player.play()
            self.updateNowPlaying(path: path, url: url)
            self.emitState()
            // Titre suivant téléchargé d'avance pour enchaîner sans attente.
            if i + 1 < self.queue.count {
                try? FileManager.default.startDownloadingUbiquitousItem(at: root.appendingPathComponent(self.queue[i + 1]))
            }
        }
    }

    private func emitState() {
        let duration = player.currentItem?.duration.seconds ?? 0
        notifyListeners("state", data: [
            "index": queue.isEmpty ? -1 : index,
            "playing": player.timeControlStatus != .paused || loading,
            "loading": loading,
            "position": player.currentTime().seconds.isFinite ? player.currentTime().seconds : 0,
            "duration": duration.isFinite ? duration : 0,
        ])
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        guard !info.isEmpty else { return }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = player.currentTime().seconds
        info[MPNowPlayingInfoPropertyPlaybackRate] = player.rate
        if duration.isFinite { info[MPMediaItemPropertyPlaybackDuration] = duration }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func updateNowPlaying(path: String, url: URL) {
        let meta = tracks.first { $0["path"] as? String == path } ?? [:]
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: meta["title"] as? String ?? url.deletingPathExtension().lastPathComponent,
            MPMediaItemPropertyArtist: meta["artist"] as? String ?? "",
            MPMediaItemPropertyAlbumTitle: meta["album"] as? String ?? "",
            MPNowPlayingInfoPropertyPlaybackQueueIndex: index,
            MPNowPlayingInfoPropertyPlaybackQueueCount: queue.count,
        ]
        Task { @MainActor in
            guard let image = await Self.coverImage(for: url) else { return }
            let art = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                info[MPMediaItemPropertyArtwork] = art
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
        }
    }

    private func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in self?.player.play(); self?.emitState(); return .success }
        center.pauseCommand.addTarget { [weak self] _ in self?.player.pause(); self?.emitState(); return .success }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.player.timeControlStatus == .paused { self.player.play() } else { self.player.pause() }
            self.emitState()
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in self?.skip(1); return .success }
        center.previousTrackCommand.addTarget { [weak self] _ in self?.skip(-1); return .success }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self = self, let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self.player.seek(to: CMTime(seconds: e.positionTime, preferredTimescale: 1000))
            return .success
        }
    }
}
