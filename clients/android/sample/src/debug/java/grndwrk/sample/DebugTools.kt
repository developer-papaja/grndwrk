package grndwrk.sample

import android.app.Application
import grndwrk.feedback.GrndwrkFeedback

/** Debug builds only. A release build has its own DebugTools in src/release that does nothing. */
object DebugTools {
  fun start(app: Application) {
    GrndwrkFeedback.start(app, server = BuildConfig.GRNDWRK_SERVER.ifEmpty { null })
    GrndwrkFeedback.openScreen = { name -> Screens.open(name) }
  }
}
