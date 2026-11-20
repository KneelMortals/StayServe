plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

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
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
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
