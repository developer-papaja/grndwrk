// A small app to try GrndwrkFeedback in the emulator: a Compose screen and a Views screen.
plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "grndwrk.sample"
  compileSdk = 36
  defaultConfig {
    applicationId = "grndwrk.sample"
    minSdk = 26
    targetSdk = 36
    versionCode = 1
    versionName = "1.0"
    // Where the sample finds grndwrk, for trying it against a test map: -PgrndwrkServer=http://10.0.2.2:7790. Empty: it finds grndwrk itself.
    buildConfigField("String", "GRNDWRK_SERVER", "\"${providers.gradleProperty("grndwrkServer").getOrElse("")}\"")
  }
  buildFeatures {
    compose = true
    buildConfig = true
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin { jvmToolchain(17) }

dependencies {
  debugImplementation(project(":feedback"))
  implementation(platform("androidx.compose:compose-bom:2026.01.01"))
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.activity:activity-compose:1.10.1")
}
