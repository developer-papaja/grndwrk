// GrndwrkFeedback for Android: comment on a running app, straight into the grndwrk map.
// Add it to debug builds only: debugImplementation("com.github.developer-papaja:grndwrk:<version>").
plugins {
  id("com.android.library")
  id("maven-publish")
}

android {
  namespace = "grndwrk.feedback"
  compileSdk = 36
  defaultConfig {
    minSdk = 26
    consumerProguardFiles("consumer-rules.pro")
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  publishing {
    singleVariant("release") { withSourcesJar() }
  }
}

kotlin { jvmToolchain(17) }

dependencies {
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
  // Scanning a team link's QR code, in a screen of its own: the app needs no camera permission.
  implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
  // Only for Modifier.grndwrkScreen, in apps that use Compose; never pulled into an app.
  compileOnly("androidx.compose.ui:ui:1.10.2")
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.json:json:20250517")
}

publishing {
  publications {
    register<MavenPublication>("release") {
      groupId = "com.github.developer-papaja"
      artifactId = "grndwrk"
      version = providers.gradleProperty("version").getOrElse("dev")
      afterEvaluate { from(components["release"]) }
    }
  }
}
