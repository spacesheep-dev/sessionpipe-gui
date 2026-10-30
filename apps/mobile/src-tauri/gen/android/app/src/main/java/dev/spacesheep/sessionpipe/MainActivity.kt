// SPDX-License-Identifier: Apache-2.0
package dev.spacesheep.sessionpipe

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.provider.Settings
import android.os.Build
import android.os.Bundle
import android.view.HapticFeedbackConstants
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.annotation.Keep
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

// The page draws edge to edge, as on iOS. Android's WebView doesn't give it the system bars
// as env(safe-area-inset-*), so the shell hands them over: `spInsets.get()` is
// "top right bottom left" in CSS px, and an `sp-insets` event says they changed; the page
// puts them in --safe-* (web/src/native/shell.ts). The keyboard shrinks the view instead.
// The page also has the phone's engine (`spHaptic`) and the system bars (`spAppearance`);
// each is a JavascriptInterface, called from the page's thread, done on the UI thread.
class MainActivity : TauriActivity() {
  @Volatile private var insets = "0 0 0 0"
  /** The page's scheme, "light" | "dark" | "auto" (web/src/native/appearance.ts). */
  @Volatile private var scheme = "auto"
  private var webView: WebView? = null

  @Keep
  inner class Insets {
    @JavascriptInterface fun get(): String = insets
  }

  // Haptics (web/src/native/haptics.ts): the page's kinds on View.performHapticFeedback,
  // which honours the phone's touch-feedback setting. Confirm and reject exist from
  // Android 11; an older phone gets the nearest. False for a kind the page never sends.
  @Keep
  inner class Haptic {
    @JavascriptInterface
    fun perform(kind: String): Boolean {
      val modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
      val constant = when (kind) {
        "selection" -> HapticFeedbackConstants.CLOCK_TICK
        "light" -> HapticFeedbackConstants.KEYBOARD_TAP
        "medium" -> HapticFeedbackConstants.CONTEXT_CLICK
        "success" -> if (modern) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.CONTEXT_CLICK
        "warning" -> HapticFeedbackConstants.LONG_PRESS
        "error" -> if (modern) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
        else -> return false
      }
      runOnUiThread { (webView ?: findViewById<View>(android.R.id.content)).performHapticFeedback(constant) }
      return true
    }
  }

  // The system bars follow the page's scheme (web/src/native/appearance.ts): dark icons
  // over a page forced light, light icons over one forced dark, whatever the phone's own
  // setting; "auto" hands them back to it.
  @Keep
  inner class Appearance {
    @JavascriptInterface
    fun set(scheme: String) {
      if (scheme != "light" && scheme != "dark" && scheme != "auto") return
      this@MainActivity.scheme = scheme
      runOnUiThread { applyAppearance() }
    }
  }

  // "Open Settings" when notifications are off (web/src/components/NotifyToggle.tsx): the
  // app's notification settings, where the person turns them back on.
  @Keep
  inner class Notify {
    @JavascriptInterface
    fun openSettings() {
      val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runOnUiThread {
        try {
          startActivity(intent)
        } catch (e: ActivityNotFoundException) {
          startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
        }
      }
    }
  }

  private fun applyAppearance() {
    val light = when (scheme) {
      "light" -> true
      "dark" -> false
      else -> (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_YES
    }
    val bars = WindowCompat.getInsetsController(window, window.decorView)
    bars.isAppearanceLightStatusBars = light
    bars.isAppearanceLightNavigationBars = light
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, w ->
      val bars = w.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = w.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val d = resources.displayMetrics.density
      // With the keyboard up, the keyboard covers the gesture bar: no bottom inset.
      insets = listOf(bars.top, bars.right, if (ime > 0) 0 else bars.bottom, bars.left)
        .joinToString(" ") { (it / d).toString() }
      v.setPadding(0, 0, 0, ime)
      webView?.evaluateJavascript("dispatchEvent(new Event('sp-insets'))", null)
      WindowInsetsCompat.CONSUMED
    }
  }

  // The activity handles uiMode itself (no restart), so the bars' icons follow a switch to
  // or from dark here; the page follows the same system setting. enableEdgeToEdge puts
  // the bars back on the system's scheme, so the page's goes on again after it.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    enableEdgeToEdge()
    applyAppearance()
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Insets(), "spInsets")
    webView.addJavascriptInterface(Haptic(), "spHaptic")
    webView.addJavascriptInterface(Appearance(), "spAppearance")
    webView.addJavascriptInterface(Notify(), "spNotify")
    // Tauri's activity turns wry's back handling off (TauriActivity: handleBackNavigation
    // = false) and adds none of its own, so the system back closed the app. The page is a
    // pushState app, and its history is the WebView's: back pops a page, and from the
    // first one it leaves the app to the launcher, the task kept for a return.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
      }
    })
    ViewCompat.requestApplyInsets(findViewById(android.R.id.content))
  }
}
