package com.lamajoker.kinetic;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KineticWidgetPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
