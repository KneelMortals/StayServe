import com.android.build.api.dsl.LibraryExtension
import org.gradle.api.tasks.compile.JavaCompile

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

// ---------------------------------------------------------------------------
// Keep the third-party geolocator lint failure contained to that dependency.
// ---------------------------------------------------------------------------
//
// `geolocator_android` 5.2.1 calls NotificationManagerCompat.notify()
// without first checking the Android 13+ POST_NOTIFICATIONS permission.
// Its own Android lint task therefore fails the root `./gradlew lint`
// command even though StayServe only uses the plugin for a one-shot current
// location and never starts its background-location notification service.
//
// The upstream source lives in the pub cache and cannot be patched from this
// repository. This module-scoped lint configuration suppresses exactly the
// upstream permission detector in that dependency. It does not alter lint
// for the StayServe app or any other dependency, so app-local permission
// mistakes still fail the build.
// ---------------------------------------------------------------------------
subprojects {
    if (name == "geolocator_android") {
        plugins.withId("com.android.library") {
            extensions.configure<LibraryExtension> {
                lint {
                    disable += "MissingPermission"
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Silence the "obsolete source/target" warnings of the two plugins that still
// compile with Java 8.
//
// `geolocator_android` and `permission_handler_android` set
//
//     compileOptions {
//         sourceCompatibility JavaVersion.VERSION_1_8
//         targetCompatibility JavaVersion.VERSION_1_8
//     }
//
// in their own build files, which made javac print
//
//     warning: [options] source value 8 is obsolete and will be removed
//     warning: [options] target value 8 is obsolete and will be removed
//     warning: [options] To suppress warnings about obsolete options, use -Xlint:-options.
//
// twice per build.
//
// The plugin sources cannot be patched (they live in the pub cache) and the
// compile target cannot be raised from here: AGP puts `android.jar` on the
// *boot class path* when the target is Java 8, and javac silently ignores
// `-bootclasspath` as soon as the source/target level is 9 or higher — the
// Android framework classes would then be missing and the build would fail
// with "package android.os does not exist".
//
// So the obsolete-target warning is silenced the way javac itself suggests:
// `-Xlint:-options` turns off the `options` lint category. It is added only
// to the tasks that actually still target Java 8, so everything else keeps
// its normal diagnostics.
//
// `projectsEvaluated` is used because AGP assigns the compiler arguments
// while it creates the compile tasks (inside its own `afterEvaluate`), so
// this is the last point at which the list can still be extended.
// ---------------------------------------------------------------------------
gradle.projectsEvaluated {
    rootProject.allprojects.forEach { project ->
        project.tasks.withType<JavaCompile>().configureEach {
            if (sourceCompatibility == "1.8" || targetCompatibility == "1.8") {
                options.compilerArgs.add("-Xlint:-options")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Repair the "defined multiple times" build failure.
//
// When two Gradle builds run against the same project at the same time —
// for example `flutter build` while Android Studio syncs the same project,
// or two `flutter build` commands at once — two compilers write to the same
// output directory. The second one cannot overwrite the class files of the
// first, so it writes them under a different name ("Constant 2.class",
// "Constant 3.class", "MainActivity 2.dex", ...). The next build then
// packages both copies into the same archive and D8 refuses to dex it:
//
//   ERROR: .../classes.jar: D8: Type com.tekartik.sqflite.Constant is
//   defined multiple times: .../Constant 3.class, .../Constant.class
//
// A long-lived Kotlin compile daemon makes the same thing happen even
// without a second build: it keeps the class files of the previous
// compilation in its state and writes the new ones next to them.
//
// The duplicated files are never legitimate — a class file is always called
// exactly after its class — so they are simply deleted again.
//
// The same happens to *generated sources*, to *compressed assets* and to
// *generated resources*: AGP writes `BuildConfig.java` into
// `build/<module>/generated/source/buildConfig/...`, and a second build
// running against the same output directory leaves a numbered copy behind
// ("BuildConfig 3.java"). javac then refuses to compile it:
//
//   error: class BuildConfig is public, should be declared in a file
//   named BuildConfig.java
//
// The AGP task that compresses the assets behaves the same way and leaves
// "logo.png 3.jar" next to the current "logo.png.jar". The APK packaging
// then fails with
//
//   Zip file '.../app-debug.apk' already contains entry
//   'assets/flutter_assets/assets/images/logo.png', cannot overwrite
//
// because both copies end up in the archive.
//
// The generated resources do it as well — "flutter_image_picker_file_paths
// 2.xml" next to "flutter_image_picker_file_paths.xml" makes the AGP
// resource parser fail with
//
//   Failed file name validation for file .../flutter_image_picker_file_paths 2.xml
//
// A numbered file is only removed when the canonical file (the same name
// without the number) exists next to it — that way a file that is
// legitimately called "Foo 1.java" is never touched.
//
// The sweep runs once, before the first task of the build, so every task
// starts from a clean directory. It also runs again in front of the tasks
// that bundle the compiled classes, so a directory that was damaged
// outside of Gradle is repaired even when the compile task itself was up to
// date and did not run.
// ---------------------------------------------------------------------------
val staleClassFile = Regex(""".* \d+\.(class|dex)""")

/// The name of a numbered copy: "BuildConfig 3.java" -> "BuildConfig" +
/// ".java", "cache.dill.track 2.dill" -> "cache.dill.track" + ".dill".
val numberedCopy = Regex("""^(.*) (\d+)(.*)$""")

fun File.removeStaleClassFiles() {
    if (!isDirectory) return

    walkTopDown()
        .filter { it.isFile && staleClassFile.matches(it.name) }
        .forEach { it.delete() }

    // Every other numbered copy is only stale when the original is still
    // there next to it.
    walkTopDown()
        .filter { it.isFile }
        // Version-control metadata is never a build artefact — the iOS
        // Swift Package Manager checkouts inside `build/ios` carry a `.git`
        // directory whose refs may legitimately be numbered.
        .filterNot { file -> file.path.contains("${File.separator}.git${File.separator}") }
        .forEach { file ->
            val match = numberedCopy.matchEntire(file.name) ?: return@forEach
            val prefix = match.groupValues[1]
            val suffix = match.groupValues[3]

            // The original is either "prefix + suffix" ("BuildConfig.java")
            // or just "prefix" ("cache.dill.track").
            val original = file.parentFile.resolve(prefix + suffix)
            val originalWithoutSuffix =
                if (suffix.isEmpty()) null else file.parentFile.resolve(prefix)

            val exists = (original.exists() && original.isFile) ||
                (originalWithoutSuffix != null &&
                    originalWithoutSuffix.exists() &&
                    originalWithoutSuffix.isFile)

            if (exists) file.delete()
        }
}

gradle.taskGraph.whenReady {
    // Before the first task runs: remove everything that a previous build
    // left behind.
    rootProject.layout.buildDirectory.get().asFile.removeStaleClassFiles()
}

gradle.projectsEvaluated {
    rootProject.allprojects.forEach { project ->
        project.tasks.withType<JavaCompile>().configureEach {
            doFirst { project.layout.buildDirectory.get().asFile.removeStaleClassFiles() }
        }

        // The AGP tasks that turn the compiled classes into a jar or a
        // directory, and the tasks that dex them. They are matched by name
        // because their types live in the Android Gradle Plugin, which is
        // not on the class path of this script.
        project.tasks.matching {
            it.name.startsWith("bundleLib") ||
                it.name.startsWith("bundleAar") ||
                it.name.startsWith("dexBuilder") ||
                it.name.contains("Dex")
        }.configureEach {
            doFirst { project.layout.buildDirectory.get().asFile.removeStaleClassFiles() }
        }
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
