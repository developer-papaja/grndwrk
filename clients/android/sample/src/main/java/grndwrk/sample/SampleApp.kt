package grndwrk.sample

import android.app.Application

class SampleApp : Application() {
  override fun onCreate() {
    super.onCreate()
    // Only in debug builds: GrndwrkFeedback is added with debugImplementation, so it is in src/debug only.
    if (BuildConfig.DEBUG) DebugTools.start(this)
  }
}
