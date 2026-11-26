// Where the app's parts are. A development build runs from the repository (Info.plist `EarthRTRoot`, set by
// project.yml, or EARTHRT_ROOT): the sidecar's sources, the map engine's build (web/dist), the traced view's script
// (traced/dist), the engine's presets. A packaged app carries them in Contents/Resources/earthrt (tools/release.ts).
//
// The traced view's asset root (what its readAsset reads) is ~/Library/Application Support/EarthRT/root, with
//   cache -> ~/Library/Caches/EarthRT      the disk cache: assets.fetch writes into it, the map's ert:// scheme
//                                          reads and fills it (SPEC § 6): the offline store
//   dev/<name>-<n> -> <a place's folder>   places in dev mode (one link a build: a reload never reads a stale file)
import Foundation

enum Paths {
    static let root: String = {
        if let env = ProcessInfo.processInfo.environment["EARTHRT_ROOT"], !env.isEmpty { return env }
        if let plist = Bundle.main.object(forInfoDictionaryKey: "EarthRTRoot") as? String, !plist.isEmpty,
           FileManager.default.fileExists(atPath: plist + "/native/sidecar/src/main.ts") {
            return URL(fileURLWithPath: plist).standardizedFileURL.path
        }
        return (Bundle.main.resourcePath ?? ".") + "/earthrt"
    }()
    static var sidecar: String { root + "/native/sidecar/src/main.ts" }
    /// The traced view's script (traced/, built by its own build).
    static var bundle: String {
        if let env = ProcessInfo.processInfo.environment["EARTHRT_BUNDLE"], !env.isEmpty { return env }
        // (A developer's override: `defaults write dev.threert.earthrt EarthRTTraced <file>`.)
        if let d = UserDefaults.standard.string(forKey: "EarthRTTraced"), !d.isEmpty { return d }
        let carried = (Bundle.main.resourcePath ?? "") + "/traced/traced.js"
        if !FileManager.default.fileExists(atPath: root + "/traced/dist/traced.js"), FileManager.default.fileExists(atPath: carried) { return carried }
        return root + "/traced/dist/traced.js"
    }
    /// The map engine's build (web/dist), loaded by the WKWebView as ert://app/.
    static var web: String {
        if let env = ProcessInfo.processInfo.environment["EARTHRT_WEB"], !env.isEmpty { return env }
        // (A developer's override: `defaults write dev.threert.earthrt EarthRTWeb <dist folder>`.)
        if let d = UserDefaults.standard.string(forKey: "EarthRTWeb"), !d.isEmpty { return d }
        // (A build that carries its own copy: native/tools/macos.ts --out.)
        let carried = (Bundle.main.resourcePath ?? "") + "/web"
        if !FileManager.default.fileExists(atPath: root + "/web/dist/index.html"), FileManager.default.fileExists(atPath: carried + "/index.html") { return carried }
        return root + "/web/dist"
    }
    static var presets: String { root + "/engine/presets" }
    /// The sidecar's build folder (its server file, the agents' adapters, the `earthrt` launcher). A packaged app's
    /// Resources are read-only: it keeps them in Application Support.
    static var build: String {
        if !root.hasPrefix(Bundle.main.bundlePath) { return root + "/native/.build" }
        return support + "/sidecar"
    }

    static let support: String = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!.path + "/EarthRT"
        try? FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
        return base
    }()
    static let cache: String = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!.path + "/EarthRT"
        try? FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
        return base
    }()
    static let places = NSHomeDirectory() + "/EarthRT/places"

    /// The asset root, made (and its links put right) on first use.
    static let assets: String = {
        let fm = FileManager.default
        let dir = support + "/root"
        try? fm.createDirectory(atPath: dir + "/dev", withIntermediateDirectories: true)
        let link = dir + "/cache"
        if (try? fm.destinationOfSymbolicLink(atPath: link)) != cache {
            try? fm.removeItem(atPath: link)
            try? fm.createSymbolicLink(atPath: link, withDestinationPath: cache)
        }
        // (Links of an earlier run's places: made again when a place opens.)
        for name in (try? fm.contentsOfDirectory(atPath: dir + "/dev")) ?? [] { try? fm.removeItem(atPath: dir + "/dev/" + name) }
        return dir
    }()

    /// Links a place's folder into the asset root as dev/<name>-<n>/ and returns that path ("dev/<name>-<n>/"); older
    /// links of the same name go.
    static func linkDev(name: String, folder: String, serial: Int) -> String {
        let fm = FileManager.default
        let dev = assets + "/dev"
        for old in (try? fm.contentsOfDirectory(atPath: dev)) ?? [] where old.hasPrefix(name + "-") { try? fm.removeItem(atPath: dev + "/" + old) }
        let path = "\(name)-\(serial)"
        try? fm.createSymbolicLink(atPath: dev + "/" + path, withDestinationPath: folder)
        return "dev/\(path)/"
    }

    /// Bun, which runs the sidecar: EARTHRT_BUN, the app's own (a packaged app), else where installers put it.
    static func bun(searchPath: String) -> String? {
        if let env = ProcessInfo.processInfo.environment["EARTHRT_BUN"], FileManager.default.isExecutableFile(atPath: env) { return env }
        let packaged = root + "/bin/bun"
        if FileManager.default.isExecutableFile(atPath: packaged) { return packaged }
        let home = NSHomeDirectory()
        let dirs = searchPath.split(separator: ":").map(String.init) + [home + "/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        return dirs.map { $0 + "/bun" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Bytes under a folder (the cache's size), following no links.
    static func size(of path: String) -> Int64 {
        let url = URL(fileURLWithPath: path)
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey]) else { return 0 }
        var total: Int64 = 0
        for case let f as URL in e {
            let v = try? f.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey])
            if v?.isRegularFile == true { total += Int64(v?.totalFileAllocatedSize ?? 0) }
        }
        return total
    }
}
