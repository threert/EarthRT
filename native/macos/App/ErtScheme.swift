// The `ert://` URL scheme the map engine loads everything through (SPEC § 6.1 "Files in the app"):
//   ert://app/<path>            the map engine's build (web/dist), carried in the app
//   ert://dev/<name>/<path>     a place in dev mode: its folder
//   ert://<host>/<path>         a file of the service: from the disk cache, else https://<host>/<path>, kept
//
// The cache is the one the traced view's `assets.*` writes (SPEC § 6.2): the file for https://<host>/<path> is
// `<cache>/<host>/<path>`, with the engine's record `.<name>.fetched` ({url, sha256, size}) beside it, so either side
// finds what the other fetched. Files whose address names their version (tiles under a generation, a place's files at
// a commit) are kept for good; the rest (meta.json, the registry's answers) are asked for again and the kept copy
// serves when the network does not answer (offline).
import CryptoKit
import Foundation
import UniformTypeIdentifiers
import WebKit

final class ErtScheme: NSObject, WKURLSchemeHandler {
    /// Dev places by name (`ert://dev/<name>/`), set by the model.
    var devFolders: [String: String] = [:]
    private var stopped = Set<ObjectIdentifier>()
    private var tasks: [ObjectIdentifier: URLSessionDataTask] = [:]
    private let lock = NSLock()
    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.timeoutIntervalForRequest = 30
        c.httpMaximumConnectionsPerHost = 12
        c.httpAdditionalHeaders = ["User-Agent": "EarthRT/\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0") (macOS)"]
        return URLSession(configuration: c)
    }()
    /// Requests answered, from the cache, from the network, failed (for the status bar and tests).
    private(set) var counts = (cache: 0, network: 0, failed: 0)

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let host = url.host else { return fail(task, 400) }
        let path = url.path
        switch host {
        case "app":
            serveFile(task, url: url, file: Paths.web + (path == "/" || path.isEmpty ? "/index.html" : path))
        case "dev":
            let parts = path.split(separator: "/", maxSplits: 1).map(String.init).map { $0.removingPercentEncoding ?? $0 }
            guard let name = parts.first, let folder = devFolders[name] else { return fail(task, 404) }
            let rest = parts.count > 1 ? parts[1] : "earthrt.json"
            guard !rest.split(separator: "/").contains("..") else { return fail(task, 403) }
            serveFile(task, url: url, file: folder + "/" + rest, noStore: true)
        default:
            service(task, url: url, host: host)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        lock.lock()
        stopped.insert(id)
        let t = tasks.removeValue(forKey: id)
        lock.unlock()
        t?.cancel()
    }

    // ----- answering -----

    private func live(_ task: WKURLSchemeTask) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !stopped.contains(ObjectIdentifier(task))
    }

    private func finish(_ task: WKURLSchemeTask, url: URL, status: Int, data: Data, type: String?, immutable: Bool = false) {
        DispatchQueue.main.async { [self] in
            guard live(task) else { return }
            var headers = ["Access-Control-Allow-Origin": "*", "Content-Length": "\(data.count)",
                           "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache"]
            if let type { headers["Content-Type"] = type }
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            task.didReceive(response)
            if !data.isEmpty { task.didReceive(data) }
            task.didFinish()
            lock.lock(); stopped.remove(ObjectIdentifier(task)); tasks.removeValue(forKey: ObjectIdentifier(task)); lock.unlock()
        }
    }

    private func fail(_ task: WKURLSchemeTask, _ status: Int) {
        guard let url = task.request.url else { return }
        finish(task, url: url, status: status, data: Data(), type: "text/plain")
    }

    private func serveFile(_ task: WKURLSchemeTask, url: URL, file: String, noStore: Bool = false) {
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            guard let data = FileManager.default.contents(atPath: file) else { return fail(task, 404) }
            finish(task, url: url, status: 200, data: data, type: ErtScheme.type(of: file), immutable: !noStore && file.contains("/static/"))
        }
    }

    static func type(of path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "js", "mjs": return "text/javascript"
        case "json": return "application/json"
        case "html": return "text/html; charset=utf-8"
        case "css": return "text/css"
        case "wasm": return "application/wasm"
        case "glb": return "model/gltf-binary"
        case "ert", "erp", "bin": return "application/octet-stream"
        default: return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
    }

    /// Where the cache keeps https://<host>/<path>[?query].
    static func cacheFile(host: String, path: String, query: String?) -> String {
        var p = Paths.cache + "/" + host + (path.isEmpty ? "/index" : path)
        if p.hasSuffix("/") { p += "index" }
        if let query, !query.isEmpty {
            let h = SHA256.hash(data: Data(query.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
            p += "@" + h
        }
        return p
    }

    /// The engine's record of a fetched file (renderer/src/assets.rs `record_of`).
    static func recordFile(_ file: String) -> String {
        let url = URL(fileURLWithPath: file)
        return url.deletingLastPathComponent().appendingPathComponent("." + url.lastPathComponent + ".fetched").path
    }

    /// A file whose address carries its version: kept for good.
    static func immutable(host: String, path: String) -> Bool {
        path.range(of: #"^/tiles/v\d+/g\d+/"#, options: .regularExpression) != nil || (path.hasPrefix("/p/") && path.split(separator: "/").count >= 5)
    }

    private func service(_ task: WKURLSchemeTask, url: URL, host: String) {
        let path = url.path, query = url.query
        let remote = URL(string: "https://\(host)\(url.path.isEmpty ? "/" : url.path)\(query.map { "?" + $0 } ?? "")")!
        let file = ErtScheme.cacheFile(host: host, path: path, query: query)
        let keep = ErtScheme.immutable(host: host, path: path)
        let fm = FileManager.default
        let method = task.request.httpMethod ?? "GET"
        if method == "GET", keep {
            if let data = fm.contents(atPath: file) {
                counts.cache += 1
                return finish(task, url: url, status: 200, data: data, type: ErtScheme.type(of: path), immutable: true)
            }
            if fm.fileExists(atPath: file + ".204") { return finish(task, url: url, status: 204, data: Data(), type: nil, immutable: true) }
        }
        var request = URLRequest(url: remote)
        request.httpMethod = method
        request.httpBody = task.request.httpBody
        for (k, v) in task.request.allHTTPHeaderFields ?? [:] where !["origin", "referer", "host"].contains(k.lowercased()) { request.setValue(v, forHTTPHeaderField: k) }
        let dataTask = session.dataTask(with: request) { [self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let type = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? ErtScheme.type(of: path)
            if let data, status > 0, error == nil {
                counts.network += 1
                if method == "GET" && (status == 200 || (status == 204 && keep)) { store(data: data, status: status, file: file, url: remote.absoluteString) }
                return finish(task, url: url, status: status, data: data, type: type, immutable: keep)
            }
            // Offline (or the service did not answer): the kept copy.
            if method == "GET", let kept = fm.contents(atPath: file) {
                counts.cache += 1
                return finish(task, url: url, status: 200, data: kept, type: ErtScheme.type(of: path))
            }
            counts.failed += 1
            if (error as? URLError)?.code == .cancelled { return }
            finish(task, url: url, status: 502, data: Data((error?.localizedDescription ?? "no answer").utf8), type: "text/plain")
        }
        lock.lock(); tasks[ObjectIdentifier(task)] = dataTask; lock.unlock()
        dataTask.resume()
    }

    private func store(data: Data, status: Int, file: String, url: String) {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        if status == 204 { fm.createFile(atPath: file + ".204", contents: Data()); return }
        let part = file + ".part"
        guard fm.createFile(atPath: part, contents: data) else { return }
        _ = try? fm.replaceItemAt(URL(fileURLWithPath: file), withItemAt: URL(fileURLWithPath: part))
        if fm.fileExists(atPath: part) { try? fm.moveItem(atPath: part, toPath: file) }
        let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let record = ["url": url, "sha256": sha, "size": data.count] as [String: Any]
        if let json = try? JSONSerialization.data(withJSONObject: record) { fm.createFile(atPath: ErtScheme.recordFile(file), contents: json) }
    }
}
