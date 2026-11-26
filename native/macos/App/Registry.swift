// The places registry (SPEC § 8: https://earth.threert.dev/api/v1), the app's own requests: search, a place's record,
// likes. The globe's script asks the registry for what it draws (net.fetch); the interface asks for what it lists.
// And the Keychain, where the GitHub token and the Meshy key are kept.
import Foundation
import Security

struct PlaceRecord: Identifiable, Hashable {
    /// owner/repo/id
    let id: String
    let repo: String
    let title: String
    let summary: String
    let kind: String
    let topic: String
    let author: String
    let likes: Int
    let stars: Int
    let rank: Int
    let lat: Double
    let lon: Double
    let era: String?
    let license: String
    let credits: [String]
    let updated: String

    init?(_ j: [String: Any]) {
        guard let id = j["id"] as? String, let m = j["manifest"] as? [String: Any], let a = m["anchor"] as? [String: Any] else { return nil }
        self.id = id
        repo = j["repo"] as? String ?? id.split(separator: "/").prefix(2).joined(separator: "/")
        title = m["title"] as? String ?? id
        summary = m["summary"] as? String ?? ""
        kind = m["kind"] as? String ?? "site"
        topic = j["topic"] as? String ?? m["topic"] as? String ?? ""
        author = j["author"] as? String ?? ""
        likes = j["likes"] as? Int ?? 0
        stars = j["stars"] as? Int ?? 0
        rank = j["rank"] as? Int ?? 0
        lat = (a["lat"] as? NSNumber)?.doubleValue ?? 0
        lon = (a["lon"] as? NSNumber)?.doubleValue ?? 0
        era = (m["era"] as? [String: Any])?["label"] as? String
        license = m["license"] as? String ?? ""
        credits = m["credits"] as? [String] ?? []
        updated = j["updated"] as? String ?? ""
    }
}

enum Registry {
    static var api: String {
        let custom = UserDefaults.standard.string(forKey: "api") ?? ""
        return (custom.isEmpty ? "https://earth.threert.dev" : custom).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    static var base: String { api + "/api/v1" }

    private static func request(_ path: String, method: String = "GET", token: String? = nil) -> URLRequest {
        var r = URLRequest(url: URL(string: base + path)!)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.setValue("EarthRT/\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0")", forHTTPHeaderField: "User-Agent")
        if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        r.timeoutInterval = 20
        return r
    }

    private static func json(_ r: URLRequest) async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(for: r)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if !(200..<300).contains(status) { throw RegistryError.status(status, j["error"] as? String ?? HTTPURLResponse.localizedString(forStatusCode: status)) }
        return j
    }

    static func search(_ q: String, limit: Int = 30) async throws -> [PlaceRecord] {
        let query = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let j = try await json(request("/places?q=\(query)&limit=\(limit)"))
        return (j["places"] as? [[String: Any]] ?? []).compactMap(PlaceRecord.init)
    }

    static func place(_ id: String) async throws -> PlaceRecord? {
        PlaceRecord(try await json(request("/places/\(id)")))
    }

    static func like(_ id: String, _ on: Bool, token: String) async throws {
        _ = try await json(request("/places/\(id)/like", method: on ? "PUT" : "DELETE", token: token))
    }
}

enum RegistryError: LocalizedError {
    case status(Int, String)
    var errorDescription: String? {
        switch self { case .status(let s, let m): return s == 401 ? "Sign in to GitHub to like places (Settings → Accounts)" : "\(m) (\(s))" }
    }
}

/// Secrets of the user's, in their login Keychain under the app's service.
enum Keychain {
    static let service = "dev.threert.earthrt"
    static func get(_ account: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func set(_ account: String, _ value: String?) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
        guard let value, !value.isEmpty else { return }
        var add = q
        add[kSecValueData as String] = value.data(using: .utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}

/// Places the app knows without asking anyone: the search field's first answers, the flight picker's ends, the Go menu.
struct City: Identifiable, Hashable {
    let id: String
    let name: String
    let country: String
    let lat: Double
    let lon: Double
    /// A good height to look from, m.
    let alt: Double

    static let all: [City] = [
        City(id: "kyoto", name: "Kyoto", country: "Japan", lat: 34.9955, lon: 135.7595, alt: 4000),
        City(id: "tokyo", name: "Tokyo", country: "Japan", lat: 35.6812, lon: 139.7671, alt: 6000),
        City(id: "osaka", name: "Osaka", country: "Japan", lat: 34.6937, lon: 135.5023, alt: 6000),
        City(id: "san-francisco", name: "San Francisco", country: "United States", lat: 37.7793, lon: -122.4193, alt: 6000),
        City(id: "new-york", name: "New York", country: "United States", lat: 40.7128, lon: -74.0060, alt: 6000),
        City(id: "shanghai", name: "Shanghai", country: "China", lat: 31.2304, lon: 121.4737, alt: 7000),
        City(id: "paris", name: "Paris", country: "France", lat: 48.8566, lon: 2.3522, alt: 6000),
        City(id: "london", name: "London", country: "United Kingdom", lat: 51.5072, lon: -0.1276, alt: 6000),
        City(id: "rome", name: "Rome", country: "Italy", lat: 41.9028, lon: 12.4964, alt: 6000),
        City(id: "barcelona", name: "Barcelona", country: "Spain", lat: 41.3874, lon: 2.1686, alt: 6000),
        City(id: "amsterdam", name: "Amsterdam", country: "Netherlands", lat: 52.3676, lon: 4.9041, alt: 6000),
        City(id: "mount-fuji", name: "Mount Fuji", country: "Japan", lat: 35.3606, lon: 138.7274, alt: 9000),
        City(id: "alps", name: "Matterhorn", country: "Switzerland", lat: 45.9763, lon: 7.6586, alt: 7000),
        City(id: "grand-canyon", name: "Grand Canyon", country: "United States", lat: 36.1069, lon: -112.1129, alt: 9000),
    ]

    /// The cities the globe's script knows by name (its flights' ends).
    static let named: Set<String> = ["kyoto", "tokyo", "san-francisco", "new-york", "shanghai", "paris", "london"]

    static func find(_ text: String) -> [City] {
        let t = text.trimmingCharacters(in: .whitespaces).lowercased()
        guard !t.isEmpty else { return all }
        return all.filter { $0.name.lowercased().contains(t) || $0.country.lowercased().hasPrefix(t) || $0.id.contains(t) }
    }
}

/// Coordinates as people write them: "35.0036, 135.7751" (or with N/E/S/W).
func parseCoordinates(_ text: String) -> (lat: Double, lon: Double)? {
    let cleaned = text.uppercased().replacingOccurrences(of: "°", with: " ")
    let parts = cleaned.split(whereSeparator: { $0 == "," || $0 == " " || $0 == ";" }).map(String.init).filter { !$0.isEmpty }
    var numbers: [Double] = []
    var i = 0
    while i < parts.count {
        var p = parts[i]
        var sign = 1.0
        if let last = p.last, "NSEW".contains(last) { if last == "S" || last == "W" { sign = -1 }; p.removeLast() }
        else if i + 1 < parts.count, ["N", "S", "E", "W"].contains(parts[i + 1]) { if parts[i + 1] == "S" || parts[i + 1] == "W" { sign = -1 }; i += 1 }
        guard let v = Double(p) else { return nil }
        numbers.append(v * sign)
        i += 1
    }
    guard numbers.count == 2, abs(numbers[0]) <= 90, abs(numbers[1]) <= 180 else { return nil }
    return (numbers[0], numbers[1])
}
