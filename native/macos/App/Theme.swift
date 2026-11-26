// The app's look: the system's own (sidebar, inspector, toolbar, materials, dark and light), with one accent, and the
// globe's overlays on regular material so they read over oceans, clouds and night.
import SwiftUI

enum Theme {
    /// EarthRT's accent: the sky's blue at dusk.
    static let accent = Color(red: 0.25, green: 0.56, blue: 0.98)
    static let good = Color.green
    static let warn = Color.orange
    static let bad = Color.red
    static let ink = Color.primary
    static let dim = Color.secondary
    static let faint = Color(nsColor: .tertiaryLabelColor)
    static let line = Color(nsColor: .separatorColor)
    static let fill = Color(nsColor: .quaternarySystemFill)
    static func kindIcon(_ kind: String) -> String {
        switch kind {
        case "city": return "building.2"
        case "interior": return "sofa"
        default: return "mappin.and.ellipse"
        }
    }
}

/// An overlay over the globe: a rounded card on the window's material.
struct Card: ViewModifier {
    var radius: CGFloat = 12
    func body(content: Content) -> some View {
        content
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.line.opacity(0.6), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
    }
}

extension View {
    func card(_ radius: CGFloat = 12) -> some View { modifier(Card(radius: radius)) }
}

/// A small label in a capsule: a state, a number.
struct Chip: View {
    let text: String
    var tint: Color = .secondary
    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Capsule().fill(tint.opacity(0.14)))
    }
}

/// A section of the inspector: a caption-sized title over its content.
struct InspectorSection<Content: View>: View {
    let title: String
    var trailing: AnyView? = nil
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                if let trailing { trailing }
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
