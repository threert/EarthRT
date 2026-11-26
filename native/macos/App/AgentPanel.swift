// The agent panel: the user's own Claude Code or Codex working in the open place's folder, over the sidecar's ACP
// bridge. From threert/native-app-template's chat (MIT, Meshy LLC), in the system's colours.
import AppKit
import SwiftUI

struct AgentPanel: View {
    @EnvironmentObject var model: Model
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(model.project.map { "Working in \($0.name)" } ?? "No place open").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                AgentPicker()
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            Divider()
            if model.project == nil {
                ContentUnavailableView {
                    Label("Open a Place First", systemImage: "sparkles")
                } description: {
                    Text("The agent works in a place's folder. Create a place at a spot on the globe, or remix one.")
                } actions: { Button("Create Here") { model.createHere() } }
            } else {
                ChatView()
            }
        }
    }
}

struct AgentPicker: View {
    @EnvironmentObject var model: Model
    var body: some View {
        Menu {
            ForEach(model.agents) { agent in
                Button { model.sidecarSend("agent.select", ["agent": agent.id]) } label: {
                    Text(agent.installed ? "\(agent.name)  \(agent.version)" : "\(agent.name) (not installed)")
                    if agent.id == model.agent { Image(systemName: "checkmark") }
                }.disabled(!agent.installed)
            }
            Divider()
            Button("New conversation") { model.sidecarSend("agent.new"); model.chat = [] }
        } label: {
            HStack(spacing: 4) {
                Circle().fill(model.agentStatus == "error" ? Theme.bad : model.agentStatus == "idle" ? Color.secondary : Theme.good).frame(width: 6, height: 6)
                Text(model.agents.first(where: { $0.id == model.agent })?.name ?? (model.agent == "codex" ? "Codex" : "Claude Code")).font(.system(size: 11, weight: .semibold))
                Image(systemName: "chevron.down").font(.system(size: 7, weight: .bold))
            }.foregroundStyle(Color.secondary)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
    }
}

struct ChatView: View {
    @EnvironmentObject var model: Model
    @State private var draft = ""
    @FocusState private var focused: Bool
    private var selectedInfo: AgentInfo? { model.agents.first(where: { $0.id == model.agent }) }
    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 9) {
                        if model.chat.isEmpty { Welcome(text: model.panel, info: selectedInfo) { model.prompt($0) } }
                        ForEach(model.chat) { item in ChatRow(item: item).id(item.id) }
                        if model.agentStatus == "working" || model.agentStatus == "starting" {
                            HStack(spacing: 6) { ProgressView().controlSize(.mini); Text(model.agentStatus == "starting" ? "Starting the agent…" : "Working…").font(.system(size: 11)).foregroundStyle(Color.secondary) }.id("busy")
                        }
                        if let error = model.agentError, model.agentStatus == "error" {
                            Text(error).font(.system(size: 11)).foregroundStyle(Theme.bad).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: model.chat.count) { _, _ in withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: model.chat.last?.text.count ?? 0) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            }
            if !model.buildOK, let first = model.problems.first {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warn).font(.system(size: 11))
                    Text("\(first.file):\(first.line) \(first.message)").font(.system(size: 11)).foregroundStyle(Color.primary).lineLimit(2)
                    Spacer()
                    Button("Fix It") { model.askToFix() }.controlSize(.small)
                }
                .padding(.horizontal, 12).padding(.vertical, 8).background(Theme.warn.opacity(0.08))
            }
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                TextField(model.panel.placeholder, text: $draft, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: 13)).lineLimit(1...6).focused($focused)
                    .onSubmit { submit() }
                if model.agentStatus == "working" || model.agentStatus == "waiting" || model.agentStatus == "starting" {
                    Button { model.sidecarSend("agent.cancel") } label: { Image(systemName: "stop.fill").font(.system(size: 11)).frame(width: 26, height: 26).background(Circle().fill(Theme.fill)) }
                        .buttonStyle(.plain).foregroundStyle(Color.primary).help("Stop")
                } else {
                    let empty = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    Button { submit() } label: { Image(systemName: "arrow.up").font(.system(size: 12, weight: .bold)).frame(width: 26, height: 26).background(Circle().fill(empty ? Theme.fill : Color.accentColor)) }
                        .buttonStyle(.plain).foregroundStyle(empty ? Theme.faint : .white).disabled(empty)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
    }
    private func submit() {
        model.prompt(draft)
        draft = ""
    }
}

struct Welcome: View {
    let text: PanelText
    let info: AgentInfo?
    let pick: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(text.title).font(.system(size: 14, weight: .bold)).foregroundStyle(Color.primary)
            Text(text.intro)
                .font(.system(size: 11.5)).foregroundStyle(Color.secondary).fixedSize(horizontal: false, vertical: true).lineSpacing(2)
            if let info, !info.installed {
                Text(info.note.isEmpty ? "\(info.name) is not installed." : info.note).font(.system(size: 11.5)).foregroundStyle(Theme.warn).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(text.suggestions, id: \.self) { text in
                Button { pick(text) } label: {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "sparkles").font(.system(size: 10)).padding(.top, 2)
                        Text(text).font(.system(size: 11.5)).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Color.primary).padding(.horizontal, 10).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.fill))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
                    .contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
        }
        .padding(.bottom, 4)
    }
}

struct ChatRow: View {
    @EnvironmentObject var model: Model
    let item: ChatItem
    var body: some View {
        switch item.kind {
        case "user":
            HStack { Spacer(minLength: 40); Text(item.text).font(.system(size: 12.5)).foregroundStyle(Color.primary).textSelection(.enabled)
                .padding(.horizontal, 11).padding(.vertical, 8).background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.accentColor.opacity(0.18))) }
        case "thought":
            Text(item.text.trimmingCharacters(in: .whitespacesAndNewlines)).font(.system(size: 11).italic()).foregroundStyle(Theme.faint).lineLimit(3)
        case "tool":
            Button { if !item.path.isEmpty, let p = model.project { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p.folder + "/" + item.path)]) } } label: {
                HStack(spacing: 7) {
                    Image(systemName: icon).font(.system(size: 10.5)).foregroundStyle(Color.secondary).frame(width: 14)
                    Text(item.title.isEmpty ? item.toolKind : item.title).font(.system(size: 11.5)).foregroundStyle(Color.primary.opacity(0.85)).lineLimit(1).truncationMode(.middle)
                    if item.added + item.removed > 0 {
                        Text("+\(item.added)").font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.good)
                        Text("−\(item.removed)").font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.bad)
                    }
                    Spacer(minLength: 0)
                    switch item.status {
                    case "done": Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.good)
                    case "failed": Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.bad)
                    default: ProgressView().controlSize(.mini).scaleEffect(0.7)
                    }
                }
                .padding(.horizontal, 9).padding(.vertical, 5.5)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.fill))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(item.path.isEmpty ? item.title : "Show \(item.path) in Finder")
        case "plan":
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(item.entries.enumerated()), id: \.offset) { _, entry in
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: entry.status == "completed" ? "checkmark.circle.fill" : entry.status == "in_progress" ? "circle.dotted" : "circle").font(.system(size: 10)).foregroundStyle(entry.status == "completed" ? Theme.good : Color.secondary).padding(.top, 1.5)
                        Text(entry.text).font(.system(size: 11.5)).foregroundStyle(entry.status == "completed" ? Color.secondary : Color.primary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(9).frame(maxWidth: .infinity, alignment: .leading).background(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.line))
        case "permission":
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) { Image(systemName: "hand.raised.fill").font(.system(size: 10)).foregroundStyle(Theme.warn); Text(item.title.isEmpty ? "Permission needed" : item.title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.primary) }
                if !item.text.isEmpty { Text(item.text).font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.secondary).lineLimit(4).textSelection(.enabled) }
                if !item.done {
                    HStack(spacing: 6) {
                        ForEach(item.options, id: \.id) { option in
                            Button(option.label) { model.sidecarSend("agent.permission", ["id": item.id, "optionId": option.id]) }
                                .buttonStyle(.bordered).tint(option.kind.hasPrefix("reject") ? .red : option.kind == "allow_once" ? .accentColor : nil).controlSize(.small)
                        }
                    }
                }
            }
            .padding(10).frame(maxWidth: .infinity, alignment: .leading).background(RoundedRectangle(cornerRadius: 10).fill(Theme.warn.opacity(0.08))).overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.warn.opacity(0.3)))
        case "error":
            Text(item.text).font(.system(size: 11.5)).foregroundStyle(Theme.bad).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        case "notice":
            Text(item.text).font(.system(size: 11)).foregroundStyle(Color.secondary).fixedSize(horizontal: false, vertical: true)
        default:
            Markdown(text: item.text)
        }
    }
    private var icon: String {
        switch item.toolKind {
        case "read": return "doc.text"
        case "edit": return "pencil"
        case "execute": return "terminal"
        case "search": return "magnifyingglass"
        case "fetch": return "globe"
        case "think": return "brain"
        default: return "wrench.and.screwdriver"
        }
    }
}

/// The agent's prose: paragraphs with inline Markdown, fenced code as highlighted blocks.
struct Markdown: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                if block.code {
                    ScrollView(.horizontal, showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(Highlighter.lines(block.text, language: "ts").enumerated()), id: \.offset) { _, line in
                                Text(line).font(.system(size: 11, design: .monospaced))
                            }
                        }
                        .textSelection(.enabled).padding(9)
                    }
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.fill))
                } else {
                    Text(inline(block.text)).font(.system(size: 12.5)).foregroundStyle(Color.primary).lineSpacing(2.5).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
    private var blocks: [(code: Bool, text: String)] {
        var out: [(Bool, String)] = []
        var code = false
        var current: [String] = []
        for line in text.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                let joined = current.joined(separator: "\n").trimmingCharacters(in: .newlines)
                if !joined.isEmpty { out.append((code, joined)) }
                current = []
                code.toggle()
            } else { current.append(line) }
        }
        let joined = current.joined(separator: "\n").trimmingCharacters(in: .newlines)
        if !joined.isEmpty { out.append((code, joined)) }
        return out.map { (code: $0.0, text: $0.1) }
    }
    private func inline(_ source: String) -> AttributedString {
        (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
    }
}
