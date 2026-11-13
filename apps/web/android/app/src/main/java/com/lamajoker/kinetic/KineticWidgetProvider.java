package com.lamajoker.kinetic;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Resources;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * Widget « série + routine du jour ».
 * Les données sont poussées par l'application (KineticWidgetPlugin) ; le widget les
 * réinterprète à chaque rafraîchissement pour rester juste après minuit sans ouvrir l'app.
 */
public class KineticWidgetProvider extends AppWidgetProvider {

    static final String PREFS = "kinetic_widget";
    static final String KEY_STREAK = "streak";
    static final String KEY_LAST_ACTIVE = "lastActiveDate";
    static final String KEY_DONE = "done";
    static final String KEY_TOTAL = "total";
    static final String KEY_DATE = "date";

    private static final int WIDE_MIN_WIDTH_DP = 220;

    static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, KineticWidgetProvider.class));
        for (int id : ids) render(context, manager, id);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int id : appWidgetIds) render(context, manager, id);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id, Bundle options) {
        render(context, manager, id);
    }

    private static void render(Context context, AppWidgetManager manager, int id) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Resources res = context.getResources();

        String today = isoDate(0);
        String lastActive = prefs.getString(KEY_LAST_ACTIVE, "");
        boolean activeToday = today.equals(lastActive);
        boolean atRisk = isoDate(-1).equals(lastActive);
        int streak = activeToday || atRisk ? prefs.getInt(KEY_STREAK, 0) : 0;

        int total = prefs.getInt(KEY_TOTAL, 0);
        int done = today.equals(prefs.getString(KEY_DATE, "")) ? Math.min(prefs.getInt(KEY_DONE, 0), total) : 0;
        int remaining = total - done;

        String status;
        int statusColor;
        if (total == 0) {
            status = res.getString(R.string.widget_status_empty);
            statusColor = R.color.widget_text_secondary;
        } else if (remaining == 0) {
            status = res.getString(R.string.widget_status_done);
            statusColor = R.color.widget_success;
        } else if (atRisk && streak > 0) {
            status = res.getString(R.string.widget_status_at_risk);
            statusColor = R.color.widget_danger;
        } else {
            status = res.getQuantityString(R.plurals.widget_status_remaining, remaining, remaining);
            statusColor = R.color.widget_text_secondary;
        }

        int minWidth = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
        boolean wide = minWidth >= WIDE_MIN_WIDTH_DP;
        RemoteViews views = new RemoteViews(
            context.getPackageName(), wide ? R.layout.widget_kinetic_wide : R.layout.widget_kinetic);

        views.setTextViewText(R.id.widget_streak, String.valueOf(streak));
        views.setTextViewText(R.id.widget_streak_label, res.getQuantityString(R.plurals.widget_streak_label, streak));
        views.setTextViewText(R.id.widget_count, res.getString(R.string.widget_count, done, total));
        views.setProgressBar(R.id.widget_progress, Math.max(total, 1), done, false);
        views.setViewVisibility(R.id.widget_progress, total == 0 ? View.INVISIBLE : View.VISIBLE);
        views.setTextViewText(R.id.widget_status, status);
        views.setTextColor(R.id.widget_status, context.getColor(statusColor));
        views.setContentDescription(
            R.id.widget_root,
            res.getQuantityString(R.plurals.widget_a11y_streak, streak, streak)
                + ". " + res.getString(R.string.widget_a11y_routine, done, total));

        Intent open = new Intent(
            Intent.ACTION_VIEW,
            Uri.parse("com.lamajoker.kinetic://open/vitalite"),
            context,
            MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        views.setOnClickPendingIntent(
            R.id.widget_root,
            PendingIntent.getActivity(
                context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        manager.updateAppWidget(id, views);
    }

    /** Date locale AAAA-MM-JJ, même format que l'application. */
    private static String isoDate(int offsetDays) {
        Calendar calendar = Calendar.getInstance();
        calendar.add(Calendar.DAY_OF_YEAR, offsetDays);
        Date date = calendar.getTime();
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(date);
    }
}
