package com.lamajoker.kinetic;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Pont entre l'application web et le widget d'écran d'accueil. */
@CapacitorPlugin(name = "KineticWidget")
public class KineticWidgetPlugin extends Plugin {

    @PluginMethod
    public void update(PluginCall call) {
        Context context = getContext();
        context.getSharedPreferences(KineticWidgetProvider.PREFS, Context.MODE_PRIVATE)
            .edit()
            .putInt(KineticWidgetProvider.KEY_STREAK, intOf(call, "streak"))
            .putString(KineticWidgetProvider.KEY_LAST_ACTIVE, call.getString("lastActiveDate", ""))
            .putInt(KineticWidgetProvider.KEY_DONE, intOf(call, "done"))
            .putInt(KineticWidgetProvider.KEY_TOTAL, intOf(call, "total"))
            .putString(KineticWidgetProvider.KEY_DATE, call.getString("date", ""))
            .apply();
        KineticWidgetProvider.refreshAll(context);
        call.resolve();
    }

    @PluginMethod
    public void canPin(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", pinSupported());
        call.resolve(result);
    }

    /** Ouvre la fenêtre système « Ajouter à l'écran d'accueil ». */
    @PluginMethod
    public void requestPin(PluginCall call) {
        JSObject result = new JSObject();
        boolean requested = false;
        if (pinSupported()) {
            Context context = getContext();
            requested = AppWidgetManager.getInstance(context)
                .requestPinAppWidget(new ComponentName(context, KineticWidgetProvider.class), null, null);
        }
        result.put("requested", requested);
        call.resolve(result);
    }

    private boolean pinSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && AppWidgetManager.getInstance(getContext()).isRequestPinAppWidgetSupported();
    }

    private static int intOf(PluginCall call, String key) {
        Integer value = call.getInt(key, 0);
        return value == null ? 0 : Math.max(0, value);
    }
}
