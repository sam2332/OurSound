import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.oursound.app',
  appName: 'OurSound',
  webDir: 'dist',
  android: {
    // Keep the WebView inspectable (used for on-device testing over adb).
    webContentsDebuggingEnabled: true,
  },
  plugins: {
    SystemBars: {
      // DARK = light icons/text, for our dark UI.
      style: 'DARK',
    },
  },
};

export default config;
