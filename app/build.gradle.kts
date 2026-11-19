plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Pengaturan dari workflow (-PappName=..., dst). Kosong = nilai bawaan.
fun prop(name: String, def: String): String =
    (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() } ?: def

val appName = prop("appName", "Git Pusher").replace(Regex("[\"'<>&\\\\@?]"), "")
val appPackage = prop("appPackage", "id.kev.gitpusher")
val iconColor = prop("iconColor", "24292F").removePrefix("#")

android {
    // namespace = package kode internal (JANGAN diubah). Package aplikasi = applicationId di bawah.
    namespace = "id.kev.gitpusher"
    compileSdk = 34

    defaultConfig {
        applicationId = appPackage
        minSdk = 26
        targetSdk = 34
        versionCode = prop("appCode", "1").toIntOrNull() ?: 1
        versionName = prop("appVersion", "1.0")
        resValue("string", "app_name", appName)
        resValue("color", "ic_launcher_background", "#$iconColor")
    }
    buildFeatures { resValues = true }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
