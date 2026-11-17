package grndwrk.feedback

import android.content.pm.ApplicationInfo
import android.os.Build

/**
 * Where this build came from, so the grndwrk button never reaches people who
 * downloaded the app. Debuggable builds run it. A build installed from Google
 * Play never does. Any other build (a release build for testers) only with
 * `allowOutsideDebug = true`.
 */
internal object Distribution {
  val isDebuggable: Boolean get() = (Env.app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  /** Installed by Google Play, as people who download the app get it. */
  val isFromPlay: Boolean
    get() = try {
      val pm = Env.app.packageManager
      val installer = if (Build.VERSION.SDK_INT >= 30) pm.getInstallSourceInfo(Env.app.packageName).installingPackageName
      else @Suppress("DEPRECATION") pm.getInstallerPackageName(Env.app.packageName)
      installer == "com.android.vending"
    } catch (_: Exception) {
      false
    }

  fun mayRun(allowOutsideDebug: Boolean): Boolean {
    if (isFromPlay && !isDebuggable) {
      gwLog.fault("GrndwrkFeedback.start() was called in a build installed from Google Play. It does nothing here. Add GrndwrkFeedback with debugImplementation only.")
      return false
    }
    if (isDebuggable) return true
    if (!allowOutsideDebug) {
      gwLog.fault("GrndwrkFeedback.start() was called in a build that is not debuggable. It does nothing. For a tester build, start(allowOutsideDebug = true), and never upload that build to Google Play.")
      return false
    }
    gwLog.error("GrndwrkFeedback runs in a build that is not debuggable. Never upload this build to Google Play.")
    return true
  }
}
