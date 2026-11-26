// The map: the web's map engine (web/, three.js) in a WKWebView with `host=app` (ARCHITECTURE § 1, SPEC § 6.1). It
// draws the globe and nothing else; the interface is the app's. Messages: map → app through the `earth` script message
// handler, app → map by `window.earthrt.receive(msg)`. Its files come through `ert://` (ErtScheme).
import AppKit
import SwiftUI
import WebKit

final class MapController: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    let scheme = ErtScheme()
    let web: WKWebView
    /// Every `earth.*` message of the map, on the main thread.
    var onMessage: (([String: Any]) -> Void)?
    /// The page's console (for the app's console and `earthrt logs`).
    var onConsole: ((String, String) -> Void)?
    private(set) var ready = false
    private var queued: [[String: Any]] = []

    override init() {
        let config = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        config.userContentController = ucc
        config.setURLSchemeHandler(scheme, forURLScheme: "ert")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.suppressesIncrementalRendering = false
        // The page's console lines come to the app: what the map says when something goes wrong.
        ucc.addUserScript(WKUserScript(source: """
            (() => {
              const post = (level, args) => { try { window.webkit.messageHandlers.console.postMessage({ level, text: args.map(a => typeof a === "string" ? a : (a && a.stack) || JSON.stringify(a)).join(" ") }); } catch {} };
              for (const level of ["log", "warn", "error"]) { const f = console[level].bind(console); console[level] = (...a) => { post(level, a); f(...a); }; }
              addEventListener("error", e => post("error", [e.message + " at " + e.filename + ":" + e.lineno]));
              addEventListener("unhandledrejection", e => post("error", ["unhandled rejection: " + (e.reason && e.reason.stack || e.reason)]));
            })();
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: config)
        super.init()
        ucc.add(self, name: "earth")
        ucc.add(self, name: "console")
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isInspectable = true
        web.setValue(false, forKey: "drawsBackground")
        web.underPageBackgroundColor = .black
        web.allowsMagnification = false
        web.allowsBackForwardNavigationGestures = false
    }

    /// Loads the map engine with its launch parameters (SPEC § 7) and `host=app`.
    func load(params: [String: String]) {
        var c = URLComponents(string: "ert://app/index.html")!
        c.queryItems = [URLQueryItem(name: "host", value: "app"), URLQueryItem(name: "api", value: Registry.api.replacingOccurrences(of: "https://", with: "ert://"))]
            + params.sorted(by: { $0.key < $1.key }).map { URLQueryItem(name: $0.key, value: $0.value) }
        ready = false
        web.load(URLRequest(url: c.url!))
    }

    /// A message for the map (`earth.goto`, …). Before the map said `earth.ready`, messages wait.
    func send(_ message: [String: Any]) {
        guard ready else { queued.append(message); return }
        guard JSONSerialization.isValidJSONObject(message), let data = try? JSONSerialization.data(withJSONObject: message),
              let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.earthrt && window.earthrt.receive(\(json))", completionHandler: nil)
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "console" {
            let m = message.body as? [String: Any] ?? [:]
            onConsole?(m["level"] as? String ?? "log", m["text"] as? String ?? "")
            return
        }
        guard let m = message.body as? [String: Any] else { return }
        if m["t"] as? String == "earth.ready" { markReady() }
        onMessage?(m)
    }

    private func markReady() {
        ready = true
        let waiting = queued
        queued = []
        for q in waiting { send(q) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // (A map without the bridge's `earth.ready`: take the page's load as ready after a moment.)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, !self.ready else { return }
            self.web.evaluateJavaScript("typeof window.earthrt?.receive === 'function'") { r, _ in
                if r as? Bool == true, !self.ready { self.markReady(); self.onMessage?(["t": "earth.ready"]) }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        onConsole?("error", "the map did not load: \(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        onConsole?("error", "the map's web process ended: loading it again")
        webView.reload()
    }

    /// Links the map opens (attribution, a place's repository) go to the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "ert" || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return decisionHandler(.allow) }
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    /// A picture of the map as it is drawn (for `earthrt shot` and the window picture).
    func snapshot(to path: String, done: @escaping (Int, Int) -> Void) {
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = true
        web.takeSnapshot(with: config) { image, _ in
            guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { return done(0, 0) }
            try? png.write(to: URL(fileURLWithPath: path))
            done(rep.pixelsWide, rep.pixelsHigh)
        }
    }
}

struct MapView: NSViewRepresentable {
    let controller: MapController
    func makeNSView(context: Context) -> WKWebView { controller.web }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
