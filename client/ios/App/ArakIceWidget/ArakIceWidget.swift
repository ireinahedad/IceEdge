// APPLE_PLAN 4.2 — widget d'écran d'accueil « Paris en cours ».
//
// Lit, dans l'App Group, le jeton que l'app y dépose (WidgetBridgePlugin.swift),
// puis demande au serveur GET /api/widget/live-bets (server/src/services/
// widget.service.ts). iOS ne réveille un widget que toutes les 15–30 min : le
// serveur conseille 15 min quand un match est en cours, 30 sinon.
//
// Tailles : petite (1 pari), moyenne (3), grande (6). Toucher → l'onglet
// « Mes paris » de l'app (arakice://app/bet?tab=slips).

import WidgetKit
import SwiftUI

private let appGroup = "group.com.arakice.arakice"
private let openURL = URL(string: "arakice://app/bet?tab=slips")!

// MARK: - Modèle (miroir de WidgetPayload côté serveur)

struct LiveBet: Codable, Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let state: String          // scheduled | live | final
    let legs: Int
    let placedPct: Double?
    let currentPct: Double?
    let live: Bool
    let startsAt: String?
}

struct Payload: Codable {
    let generatedAt: String
    let pendingCount: Int
    let bets: [LiveBet]
    let refreshAfterSec: Int
}

enum Content {
    case bets(Payload, stale: Bool)
    case signedOut
    case unavailable
}

struct BetsEntry: TimelineEntry {
    let date: Date
    let content: Content
    let lang: String
}

// MARK: - Textes

struct L10n {
    let fr: Bool
    var title: String { fr ? "Paris en cours" : "Bets in progress" }
    var empty: String { fr ? "Aucun pari en cours" : "No bets in progress" }
    var signedOut: String { fr ? "Connecte-toi dans l'app ArakIce" : "Sign in to the ArakIce app" }
    var unavailable: String { fr ? "Données indisponibles" : "Data unavailable" }
    var live: String { fr ? "EN DIRECT" : "LIVE" }
    var placed: String { fr ? "au pari" : "at bet" }
    func more(_ n: Int) -> String { fr ? "+\(n) autre\(n > 1 ? "s" : "")" : "+\(n) more" }
}

// MARK: - Chargement

private enum Loader {
    static func load() async -> (Content, String, TimeInterval) {
        let d = UserDefaults(suiteName: appGroup)
        let lang = d?.string(forKey: "lang") ?? "fr"
        guard let token = d?.string(forKey: "token"), !token.isEmpty,
              let apiBase = d?.string(forKey: "apiBase"),
              let url = URL(string: "\(apiBase)/widget/live-bets?lang=\(lang)") else {
            return (.signedOut, lang, 3600)
        }
        var req = URLRequest(url: url)
        req.setValue(token, forHTTPHeaderField: "X-Widget-Token")
        req.timeoutInterval = 15
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401 { return (.signedOut, lang, 3600) }
            guard status == 200 else { return (cached(d, lang: lang), lang, 15 * 60) }
            let payload = try JSONDecoder().decode(Payload.self, from: data)
            d?.set(data, forKey: "lastPayload")
            return (.bets(payload, stale: false), lang, TimeInterval(max(15 * 60, payload.refreshAfterSec)))
        } catch {
            // Pas de réseau : le dernier état connu, marqué comme ancien.
            return (cached(d, lang: lang), lang, 15 * 60)
        }
    }

    private static func cached(_ d: UserDefaults?, lang: String) -> Content {
        if let data = d?.data(forKey: "lastPayload"),
           let p = try? JSONDecoder().decode(Payload.self, from: data) {
            return .bets(p, stale: true)
        }
        return .unavailable
    }
}

// MARK: - Timeline

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> BetsEntry {
        BetsEntry(date: .now, content: .bets(.sample, stale: false), lang: "fr")
    }

    func getSnapshot(in context: Context, completion: @escaping (BetsEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        Task {
            let (content, lang, _) = await Loader.load()
            completion(BetsEntry(date: .now, content: content, lang: lang))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BetsEntry>) -> Void) {
        Task {
            let (content, lang, after) = await Loader.load()
            let entry = BetsEntry(date: .now, content: content, lang: lang)
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(after))))
        }
    }
}

extension Payload {
    static let sample = Payload(
        generatedAt: "",
        pendingCount: 2,
        bets: [
            LiveBet(id: "1", title: "MTL to win", subtitle: "MTL 2–1 TOR · P2 12:34", state: "live",
                    legs: 1, placedPct: 52, currentPct: 71, live: true, startsAt: nil),
            LiveBet(id: "2", title: "Combiné · 3 paris", subtitle: "3 matchs", state: "scheduled",
                    legs: 3, placedPct: 18, currentPct: 18, live: false, startsAt: nil),
        ],
        refreshAfterSec: 900
    )
}

// MARK: - Vues

private let ice = Color(red: 0x86 / 255, green: 0xD1 / 255, blue: 0xEA / 255)
private let bg = Color(red: 0x0A / 255, green: 0x0E / 255, blue: 0x0C / 255)
private let up = Color(red: 0.30, green: 0.85, blue: 0.50)
private let down = Color(red: 0.95, green: 0.40, blue: 0.40)

private func pct(_ p: Double?) -> String {
    guard let p else { return "—" }
    return "\(Int(p.rounded()))%"
}

private func startDate(_ iso: String?) -> Date? {
    guard let iso else { return nil }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: iso) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: iso)
}

struct LiveBadge: View {
    let text: String
    var body: some View {
        HStack(spacing: 3) {
            Circle().fill(Color.red).frame(width: 5, height: 5)
            Text(text).font(.system(size: 8, weight: .heavy)).foregroundStyle(.red)
        }
    }
}

struct Trend: View {
    let bet: LiveBet
    let big: Bool
    var body: some View {
        let cur = bet.currentPct ?? bet.placedPct
        let delta = (bet.currentPct ?? 0) - (bet.placedPct ?? 0)
        let showDelta = bet.currentPct != nil && bet.placedPct != nil && abs(delta) >= 1
        VStack(alignment: .trailing, spacing: 0) {
            Text(pct(cur))
                .font(.system(size: big ? 30 : 17, weight: .bold, design: .rounded))
                .foregroundStyle(bet.live ? .white : .white.opacity(0.75))
                .minimumScaleFactor(0.6)
            if showDelta {
                Text("\(delta > 0 ? "▲" : "▼") \(Int(abs(delta).rounded()))")
                    .font(.system(size: big ? 11 : 9, weight: .semibold))
                    .foregroundStyle(delta > 0 ? up : down)
            }
        }
    }
}

struct BetRow: View {
    let bet: LiveBet
    let t: L10n
    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(bet.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    if bet.state == "live" { LiveBadge(text: t.live) }
                    if bet.state == "scheduled", let d = startDate(bet.startsAt) {
                        Text(d, style: .time).font(.system(size: 10)).foregroundStyle(ice)
                    }
                    Text(bet.subtitle)
                        .font(.system(size: 10))
                        .foregroundStyle(.white.opacity(0.6))
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            Trend(bet: bet, big: false)
        }
    }
}

struct Header: View {
    let t: L10n
    let count: Int
    let stale: Bool
    var body: some View {
        HStack {
            Text(t.title.uppercased())
                .font(.system(size: 10, weight: .heavy))
                .foregroundStyle(ice)
            Spacer()
            if stale { Image(systemName: "wifi.slash").font(.system(size: 9)).foregroundStyle(.white.opacity(0.5)) }
            if count > 0 {
                Text("\(count)").font(.system(size: 10, weight: .bold)).foregroundStyle(.white.opacity(0.7))
            }
        }
    }
}

struct Message: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(.white.opacity(0.7))
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ArakIceWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: BetsEntry

    private var limit: Int {
        switch family {
        case .systemSmall: return 1
        case .systemLarge: return 6
        default: return 3
        }
    }

    var body: some View {
        let t = L10n(fr: entry.lang != "en")
        VStack(alignment: .leading, spacing: 6) {
            switch entry.content {
            case .signedOut:
                Header(t: t, count: 0, stale: false)
                Message(text: t.signedOut)
            case .unavailable:
                Header(t: t, count: 0, stale: true)
                Message(text: t.unavailable)
            case .bets(let p, let stale):
                Header(t: t, count: p.pendingCount, stale: stale)
                if p.bets.isEmpty {
                    Message(text: t.empty)
                } else if family == .systemSmall, let b = p.bets.first {
                    small(b, t: t)
                } else {
                    ForEach(p.bets.prefix(limit)) { b in
                        BetRow(bet: b, t: t)
                        if b.id != p.bets.prefix(limit).last?.id {
                            Divider().overlay(Color.white.opacity(0.08))
                        }
                    }
                    if p.pendingCount > limit {
                        Text(t.more(p.pendingCount - limit))
                            .font(.system(size: 10))
                            .foregroundStyle(.white.opacity(0.5))
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .widgetURL(openURL)
        .containerBackground(for: .widget) { bg }
    }

    @ViewBuilder
    private func small(_ b: LiveBet, t: L10n) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(b.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(2)
            Spacer(minLength: 0)
            HStack(alignment: .bottom) {
                if b.state == "live" { LiveBadge(text: t.live) }
                Spacer()
                Trend(bet: b, big: true)
            }
            Text(b.subtitle)
                .font(.system(size: 10))
                .foregroundStyle(.white.opacity(0.6))
                .lineLimit(1)
        }
    }
}

// MARK: - Widget

struct LiveBetsWidget: Widget {
    let kind = "ArakIceLiveBets"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            ArakIceWidgetView(entry: entry)
        }
        .configurationDisplayName("ArakIce")
        .description("Tes paris en cours et leur probabilité en direct. / Your bets in progress and their live probability.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

@main
struct ArakIceWidgetBundle: WidgetBundle {
    var body: some Widget {
        LiveBetsWidget()
    }
}
