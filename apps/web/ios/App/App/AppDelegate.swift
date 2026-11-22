import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // Raccourcis de l'icône (appui long, UIApplicationShortcutItems d'Info.plist) :
    // chaque action ouvre le lien interne com.lamajoker.kinetic://open/<action>,
    // comme un widget. Application déjà lancée : événement appUrlOpen ; lancement
    // à froid : iOS appelle aussi cette méthode (didFinishLaunching renvoie true)
    // et le lien est relu par App.getLaunchUrl() (src/lib/mobile.ts).
    func application(_ application: UIApplication, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        let prefix = "com.lamajoker.kinetic.shortcut."
        guard shortcutItem.type.hasPrefix(prefix) else {
            completionHandler(false)
            return
        }
        let action = String(shortcutItem.type.dropFirst(prefix.count))
        guard let url = URL(string: "com.lamajoker.kinetic://open/" + action) else {
            completionHandler(false)
            return
        }
        completionHandler(ApplicationDelegateProxy.shared.application(application, open: url, options: [:]))
    }

}

/// Contrôleur principal (Main.storyboard) : enregistre les plugins propres à l'app.
class KineticViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(KineticIconPlugin())
    }
}

/// Icône de l'application (Profil > Apparence). Identifiants partagés avec
/// src/lib/app-icon.ts ; les icônes alternatives sont les jeux AppIcon-Nuit et
/// AppIcon-Minimal d'Assets.xcassets (réglage ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES).
@objc(KineticIconPlugin)
public class KineticIconPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KineticIconPlugin"
    public let jsName = "KineticIcon"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getIcon", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setIcon", returnType: CAPPluginReturnPromise)
    ]

    /// Identifiant JS → nom du jeu d'icônes alternatif (nil : icône principale « corail »).
    private static let alternateNames: [String: String] = [
        "nuit": "AppIcon-Nuit",
        "minimal": "AppIcon-Minimal"
    ]

    @objc func getIcon(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let app = UIApplication.shared
            var icon = "corail"
            if let current = app.alternateIconName {
                for (id, name) in KineticIconPlugin.alternateNames where name == current {
                    icon = id
                }
            }
            call.resolve(["icon": icon, "supported": app.supportsAlternateIcons])
        }
    }

    @objc func setIcon(_ call: CAPPluginCall) {
        let icon = call.getString("icon") ?? ""
        let name: String? = KineticIconPlugin.alternateNames[icon]
        if icon != "corail" && name == nil {
            call.reject("Icône inconnue")
            return
        }
        DispatchQueue.main.async {
            let app = UIApplication.shared
            guard app.supportsAlternateIcons else {
                call.reject("Icônes alternatives indisponibles")
                return
            }
            if app.alternateIconName == name {
                call.resolve(["icon": icon])
                return
            }
            app.setAlternateIconName(name) { error in
                if let error = error {
                    call.reject(error.localizedDescription)
                } else {
                    call.resolve(["icon": icon])
                }
            }
        }
    }
}
