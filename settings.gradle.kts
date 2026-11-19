// Versi plugin dibaca dari gradle.properties / -P agar workflow bisa mencoba kombinasi lain.
pluginManagement {
    val agpVersion: String by settings
    val kotlinVersion: String by settings
    val useMirrors: String by settings
    repositories {
        if (useMirrors == "true") {   // cadangan: mirror Maven bila Google/Maven Central bermasalah
            maven("https://maven.aliyun.com/repository/google")
            maven("https://maven.aliyun.com/repository/gradle-plugin")
            maven("https://maven.aliyun.com/repository/public")
        }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        id("com.android.application") version agpVersion
        id("org.jetbrains.kotlin.android") version kotlinVersion
    }
}

val useMirrors: String by settings

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        if (useMirrors == "true") {
            maven("https://maven.aliyun.com/repository/google")
            maven("https://maven.aliyun.com/repository/public")
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "GitPusher"
include(":app")
