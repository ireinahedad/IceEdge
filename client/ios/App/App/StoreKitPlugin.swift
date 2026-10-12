import Foundation
import Capacitor
import StoreKit
import UIKit

/// APPLE_PLAN Phase 5 — abonnement Pro via StoreKit 2 (iOS 15+).
///
/// Ce plugin ne décide RIEN : il achète, restaure, et passe les transactions
/// signées par Apple (JWS) au JavaScript, qui les envoie au serveur
/// (`POST /subscription/apple/verify`). C'est le serveur qui vérifie la
/// signature et accorde le Pro. Une transaction n'est « finie » (`finish`)
/// qu'après que le serveur l'a acceptée : si l'app est tuée entre les deux,
/// iOS la redonne au prochain lancement (`pendingTransactions`).
///
/// JS : client/src/app/services/appleIap.ts. Enregistré dans MainViewController.
@objc(StoreKitPlugin)
public class StoreKitPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StoreKitPlugin"
    public let jsName = "StoreKit"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentEntitlements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pendingTransactions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manageSubscriptions", returnType: CAPPluginReturnPromise),
    ]

    private var updatesTask: Task<Void, Never>?

    /// Renouvellements, achats faits sur un autre appareil, « Demander à
    /// acheter » approuvé plus tard, remboursements : tout arrive par ici
    /// pendant que l'app tourne. Écouté dès le chargement, comme Apple l'exige,
    /// sinon des transactions restent en suspens.
    override public func load() {
        updatesTask = Task.detached { [weak self] in
            for await result in Transaction.updates {
                guard let self = self, case .verified(let tx) = result else { continue }
                let data = await self.payload(result.jwsRepresentation, tx)
                // Gardé jusqu'à ce que le JS écoute : l'événement peut arriver
                // avant que la page ait fini de charger.
                self.notifyListeners("transaction", data: data, retainUntilConsumed: true)
            }
        }
    }

    deinit { updatesTask?.cancel() }

    // MARK: - Produits

    @objc func getProducts(_ call: CAPPluginCall) {
        let ids = (call.getArray("productIds") as? [String]) ?? []
        guard !ids.isEmpty else { call.reject("productIds is required"); return }
        Task {
            do {
                let products = try await Product.products(for: ids)
                var out: [JSObject] = []
                for p in products { out.append(await self.describe(p)) }
                call.resolve(["products": out])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    private func describe(_ p: Product) async -> JSObject {
        var o: JSObject = [
            "id": p.id,
            "displayName": p.displayName,
            "description": p.description,
            "displayPrice": p.displayPrice,
            "price": NSDecimalNumber(decimal: p.price).doubleValue,
            "currencyCode": p.priceFormatStyle.currencyCode,
        ]
        if let sub = p.subscription {
            o["periodUnit"] = Self.unit(sub.subscriptionPeriod.unit)
            o["periodValue"] = sub.subscriptionPeriod.value
            o["subscriptionGroupId"] = sub.subscriptionGroupID
            o["eligibleForIntroOffer"] = await sub.isEligibleForIntroOffer
            if let intro = sub.introductoryOffer {
                o["introOffer"] = [
                    "paymentMode": Self.mode(intro.paymentMode),
                    "periodUnit": Self.unit(intro.period.unit),
                    "periodValue": intro.period.value,
                    "periodCount": intro.periodCount,
                    "displayPrice": intro.displayPrice,
                ] as JSObject
            }
        }
        return o
    }

    private static func unit(_ u: Product.SubscriptionPeriod.Unit) -> String {
        switch u {
        case .day: return "day"
        case .week: return "week"
        case .month: return "month"
        case .year: return "year"
        @unknown default: return "unknown"
        }
    }

    private static func mode(_ m: Product.SubscriptionOffer.PaymentMode) -> String {
        if m == .freeTrial { return "freeTrial" }
        if m == .payAsYouGo { return "payAsYouGo" }
        if m == .payUpFront { return "payUpFront" }
        return "unknown"
    }

    // MARK: - Achat

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId"), !productId.isEmpty else {
            call.reject("productId is required"); return
        }
        // Notre user_id : relie l'achat au compte, côté serveur et dans les
        // notifications d'Apple. Sans lui, on refuse d'acheter.
        guard let raw = call.getString("appAccountToken"), let token = UUID(uuidString: raw) else {
            call.reject("appAccountToken must be a UUID"); return
        }
        Task {
            do {
                guard let product = try await Product.products(for: [productId]).first else {
                    call.reject("Product not found", "PRODUCT_NOT_FOUND"); return
                }
                let result = try await product.purchase(options: [.appAccountToken(token)])
                switch result {
                case .success(let verification):
                    guard case .verified(let tx) = verification else {
                        call.reject("Transaction could not be verified", "UNVERIFIED"); return
                    }
                    var data = await self.payload(verification.jwsRepresentation, tx)
                    data["status"] = "success"
                    call.resolve(data)
                case .userCancelled:
                    call.resolve(["status": "cancelled"])
                case .pending:
                    // « Demander à acheter » ou validation bancaire : la
                    // transaction arrivera plus tard par `Transaction.updates`.
                    call.resolve(["status": "pending"])
                @unknown default:
                    call.resolve(["status": "unknown"])
                }
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    // MARK: - Restauration et état

    /// Bouton « Restaurer les achats » (exigé par la review). `AppStore.sync()`
    /// peut demander le mot de passe Apple : à n'appeler que sur un geste.
    @objc func restore(_ call: CAPPluginCall) {
        Task {
            do {
                try await AppStore.sync()
                call.resolve(["transactions": await self.entitlements()])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    /// Abonnements en cours, sans rien demander à l'utilisateur.
    @objc func currentEntitlements(_ call: CAPPluginCall) {
        Task { call.resolve(["transactions": await self.entitlements()]) }
    }

    private func entitlements() async -> [JSObject] {
        var out: [JSObject] = []
        for await result in Transaction.currentEntitlements {
            guard case .verified(let tx) = result, tx.productType == .autoRenewable else { continue }
            out.append(await payload(result.jwsRepresentation, tx))
        }
        return out
    }

    /// Transactions qu'on n'a pas encore « finies » (app tuée avant la réponse du serveur).
    @objc func pendingTransactions(_ call: CAPPluginCall) {
        Task {
            var out: [JSObject] = []
            for await result in Transaction.unfinished {
                guard case .verified(let tx) = result else { continue }
                out.append(await self.payload(result.jwsRepresentation, tx))
            }
            call.resolve(["transactions": out])
        }
    }

    /// Appelé par le JS une fois que le serveur a accepté la transaction.
    @objc func finish(_ call: CAPPluginCall) {
        guard let id = call.getString("transactionId"), let wanted = UInt64(id) else {
            call.reject("transactionId is required"); return
        }
        Task {
            for await result in Transaction.unfinished {
                guard case .verified(let tx) = result, tx.id == wanted else { continue }
                await tx.finish()
                break
            }
            call.resolve()
        }
    }

    /// Feuille Apple « Gérer l'abonnement » (changer de formule, annuler).
    @objc func manageSubscriptions(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let scene = self.bridge?.viewController?.view.window?.windowScene else {
                call.reject("No window scene"); return
            }
            do {
                try await AppStore.showManageSubscriptions(in: scene)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    // MARK: - Transaction → JS

    private func payload(_ jws: String, _ tx: Transaction) async -> JSObject {
        var o: JSObject = [
            "transactionJws": jws,
            "transactionId": String(tx.id),
            "originalTransactionId": String(tx.originalID),
            "productId": tx.productID,
        ]
        if let exp = tx.expirationDate { o["expiresDate"] = exp.timeIntervalSince1970 * 1000 }
        if let renewal = await renewalJws(for: tx) { o["renewalJws"] = renewal }
        return o
    }

    /// État de renouvellement signé (renouvellement auto coupé ? relance de
    /// facturation ?) de l'abonnement auquel appartient cette transaction.
    private func renewalJws(for tx: Transaction) async -> String? {
        guard let group = tx.subscriptionGroupID,
              let statuses = try? await Product.SubscriptionInfo.status(for: group) else { return nil }
        for s in statuses {
            if case .verified(let t) = s.transaction, t.originalID == tx.originalID {
                return s.renewalInfo.jwsRepresentation
            }
        }
        return nil
    }
}
