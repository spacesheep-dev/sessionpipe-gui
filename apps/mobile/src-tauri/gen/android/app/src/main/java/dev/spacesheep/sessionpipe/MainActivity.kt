// SPDX-License-Identifier: Apache-2.0
package dev.spacesheep.sessionpipe

import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.annotation.Keep
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

// The page draws edge to edge, as on iOS. Android's WebView doesn't give it the system bars
// as env(safe-area-inset-*), so the shell hands them over: `spInsets.get()` is
// "top right bottom left" in CSS px, and an `sp-insets` event says they changed; the page
// puts them in --safe-* (web/src/native/shell.ts). The keyboard shrinks the view instead.
class MainActivity : TauriActivity() {
  @Volatile private var insets = "0 0 0 0"
  private var webView: WebView? = null

  @Keep
  inner class Insets {
    @JavascriptInterface fun get(): String = insets
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
  // or from dark here; the page follows the same system setting.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    enableEdgeToEdge()
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Insets(), "spInsets")
    ViewCompat.requestApplyInsets(findViewById(android.R.id.content))
  }
}
