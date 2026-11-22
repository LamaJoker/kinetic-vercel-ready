package com.lamajoker.kinetic;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Icône de l'application (Profil > Apparence). Chaque icône est un alias de
 * lanceur déclaré dans AndroidManifest.xml ; un seul est activé à la fois.
 * Identifiants partagés avec src/lib/app-icon.ts et l'application iPhone.
 *
 * Certains lanceurs ferment l'application ou la retirent un instant de l'écran
 * d'accueil quand l'alias change : l'interface prévient l'utilisateur.
 */
@CapacitorPlugin(name = "KineticIcon")
public class KineticIconPlugin extends Plugin {

    private static final String[] IDS = { "corail", "nuit", "minimal" };
    private static final String[] ALIASES = { "IconCorail", "IconNuit", "IconMinimal" };

    @PluginMethod
    public void getIcon(PluginCall call) {
        JSObject result = new JSObject();
        result.put("icon", IDS[currentIndex()]);
        result.put("supported", true);
        call.resolve(result);
    }

    @PluginMethod
    public void setIcon(PluginCall call) {
        int target = indexOf(call.getString("icon", ""));
        if (target < 0) {
            call.reject("Icône inconnue");
            return;
        }
        JSObject result = new JSObject();
        result.put("icon", IDS[target]);
        if (target == currentIndex()) {
            call.resolve(result);
            return;
        }
        try {
            PackageManager pm = getContext().getPackageManager();
            // D'abord activer la nouvelle entrée, puis désactiver les autres :
            // l'application garde toujours une icône dans le lanceur.
            pm.setComponentEnabledSetting(
                component(target),
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                PackageManager.DONT_KILL_APP
            );
            for (int i = 0; i < ALIASES.length; i++) {
                if (i == target) continue;
                pm.setComponentEnabledSetting(
                    component(i),
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    PackageManager.DONT_KILL_APP
                );
            }
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Changement d'icône impossible", e);
        }
    }

    /** Alias activé (le manifeste active « Corail » par défaut). */
    private int currentIndex() {
        PackageManager pm = getContext().getPackageManager();
        for (int i = 0; i < ALIASES.length; i++) {
            int state = pm.getComponentEnabledSetting(component(i));
            boolean enabled = state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                || (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && i == 0);
            if (enabled) return i;
        }
        return 0;
    }

    private ComponentName component(int index) {
        Context context = getContext();
        return new ComponentName(context, MainActivity.class.getPackage().getName() + "." + ALIASES[index]);
    }

    private static int indexOf(String id) {
        for (int i = 0; i < IDS.length; i++) {
            if (IDS[i].equals(id)) return i;
        }
        return -1;
    }
}
