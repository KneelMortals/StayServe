plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    // Provides the native OAuth client resources used by Firebase Auth's
    // Google OpenID Connect provider flow.
    id("com.google.gms.google-services")
}

val baseVersionCode = flutter.versionCode

// Production signing material is supplied outside the repository. The same
// four values may be provided as Gradle properties or environment variables;
// environment variables are preferred for CI because they can be protected
// GitHub secrets.
val releaseSigningNames = listOf(
    "STAY_SERVE_RELEASE_STORE_FILE",
    "STAY_SERVE_RELEASE_STORE_PASSWORD",
    "STAY_SERVE_RELEASE_KEY_ALIAS",
    "STAY_SERVE_RELEASE_KEY_PASSWORD",
)
val releaseSigningValues = releaseSigningNames.associateWith { name ->
    providers.environmentVariable(name).orNull
        ?: providers.gradleProperty(name).orNull
}
val configuredReleaseSigningNames = releaseSigningNames.filter { name ->
    providers.environmentVariable(name).orNull != null ||
        providers.gradleProperty(name).orNull != null
}
val validReleaseSigningNames = releaseSigningValues
    .filterValues { !it.isNullOrBlank() }
    .keys
val hasReleaseSigning = validReleaseSigningNames.size == releaseSigningNames.size

// A partially configured release identity must never silently become a
// debug-signed release. The debug fallback is allowed only when none of the
// four values was supplied; one missing or blank value is a configuration
// error which must be fixed before an artifact can be produced.
if (configuredReleaseSigningNames.isNotEmpty() && !hasReleaseSigning) {
    val invalidReleaseSigningNames = releaseSigningNames.filterNot { name ->
        name in validReleaseSigningNames
    }
    throw GradleException(
        "Incomplete release signing configuration. Missing or blank: " +
            "${invalidReleaseSigningNames.joinToString()}. Set all four " +
            "STAY_SERVE_RELEASE_* values, or remove all of them to use the " +
            "debug signing fallback.",
    )
}

val releaseStoreFilePath = releaseSigningValues["STAY_SERVE_RELEASE_STORE_FILE"]
val releaseStorePassword =
    releaseSigningValues["STAY_SERVE_RELEASE_STORE_PASSWORD"]
val releaseKeyAlias = releaseSigningValues["STAY_SERVE_RELEASE_KEY_ALIAS"]
val releaseKeyPassword = releaseSigningValues["STAY_SERVE_RELEASE_KEY_PASSWORD"]

android {
    namespace = "com.stayserve.stayserve"
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.stayserve.stayserve"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = baseVersionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStoreFilePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            // A protected release key is required for distributable artifacts.
            // The debug fallback keeps local and CI size validation possible
            // when that external key is intentionally unavailable.
            signingConfig = signingConfigs.findByName("release")
                ?: signingConfigs.getByName("debug")
        }
    }
}

androidComponents {
    onVariants { variant ->
        variant.outputs.forEach { output ->
            // Flutter's `--split-per-abi` flow normally gives each ABI APK a
            // distinct version code. Direct distribution replaces one ABI
            // APK with another, so every output of this release must use the
            // same code. This app-level callback runs after Flutter's and
            // therefore takes precedence.
            output.versionCode.set(baseVersionCode)
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    // Firebase Components 18.0.1 explicitly keeps the no-argument
    // constructors used to discover ComponentRegistrar implementations.
    // AGP 9's strict R8 semantics require that constructor to be listed;
    // firebase-components 18.0.0 only keeps the registrar classes and
    // therefore breaks Firebase App Check in optimized release builds.
    implementation("com.google.firebase:firebase-components:18.0.1")
}

// Firebase Auth 23.2.1 introduced encrypted session persistence backed by
// the Android Keystore. On affected devices/firmware the key cannot be read
// after the app is closed, so Firebase silently restores no user and StayServe
// sends the user to the login screen on every cold start.
//
// Keep the last stable pre-encryption Auth artifact until the upstream
// Keystore regression is fixed for every supported Android device.
// https://github.com/firebase/firebase-android-sdk/issues/7651
configurations.configureEach {
    resolutionStrategy.force("com.google.firebase:firebase-auth:23.1.0")
}
