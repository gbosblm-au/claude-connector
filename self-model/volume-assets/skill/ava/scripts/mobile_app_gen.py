#!/usr/bin/env python3
"""
mobile_app_gen.py  (Phase 10, Workstream 1)

Generates production-ready Android application source from a structured JSON
specification. Invoked through the connector's script_execute tool, which passes
--input <spec.json> and --output <dir>; generated files are written under the
output directory and can be returned as attachments.

Input spec (see the Phase 10 specification):
  app_name     string  (required)  display name
  package_id   string  (required)  reverse-domain identifier, e.g. au.com.tenax.app
  app_version  string  (required)  semantic version, e.g. 1.0.0
  min_sdk      int     (optional)  default 24
  target_sdk   int     (optional)  default 34
  features     array   (required)  screen/capability objects
  theme        object  (optional)  colour palette and typography overrides

Feature object:
  screen_name    string   human-readable name
  activity_name  string   Android activity class name (e.g. HomeActivity)
  layout_type    string   one of: list, detail, form, dashboard, webview
  api_endpoint   string   backend endpoint the screen calls
  auth_required  bool     whether auth is required
  fields         array    form fields / list columns (strings or {name,label,type})

The script also writes a generation manifest (build/app_gen_manifest.json) that
records every generated file with a content hash and the resolved spec. The
mobile refresh cycle (mobile_refresh.py) diffs against this manifest to decide
what to rebuild.

Standard library only.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import xml.dom.minidom as minidom
from datetime import datetime, timezone

LAYOUT_TYPES = ("list", "detail", "form", "dashboard", "webview")
DEFAULT_MIN_SDK = 24
DEFAULT_TARGET_SDK = 34

DEFAULT_THEME = {
    "colors": {
        "primary": "#326E60",
        "primary_variant": "#24503F",
        "secondary": "#E8A33D",
        "background": "#FFFFFF",
        "on_primary": "#FFFFFF",
        "on_background": "#1A1A1A",
    },
    "typography": {
        "font_family": "sans-serif",
        "body_size_sp": 16,
        "title_size_sp": 20,
    },
}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def now_iso():
    return datetime.now(timezone.utc).isoformat()


def die(message, code=2):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(code)


def load_spec(input_path):
    if not input_path:
        die("no --input provided; a JSON app specification is required")
    try:
        with open(input_path, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError as err:
        die(f"could not read input: {err}")
    try:
        data = json.loads(raw)
    except ValueError as err:
        die(f"input is not valid JSON: {err}")
    if isinstance(data, dict) and "input_data" in data and isinstance(data["input_data"], dict):
        data = data["input_data"]  # tolerate wrapped payloads
    return data


PKG_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
VERSION_RE = re.compile(r"^\d+\.\d+(\.\d+)?([-+][0-9A-Za-z.-]+)?$")
CLASS_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


def validate_spec(spec):
    """Return (clean_spec, warnings) or raise ValueError with a clear message."""
    if not isinstance(spec, dict):
        raise ValueError("spec must be a JSON object")

    warnings = []
    for field in ("app_name", "package_id", "app_version", "features"):
        if field not in spec or spec[field] in (None, "", []):
            raise ValueError(f"required field missing or empty: {field}")

    app_name = str(spec["app_name"]).strip()
    package_id = str(spec["package_id"]).strip()
    app_version = str(spec["app_version"]).strip()

    if not PKG_RE.match(package_id):
        raise ValueError(
            f"package_id '{package_id}' is not a valid reverse-domain identifier "
            "(expected e.g. au.com.tenax.app)"
        )
    if not VERSION_RE.match(app_version):
        raise ValueError(f"app_version '{app_version}' is not a valid semantic version")

    min_sdk = int(spec.get("min_sdk", DEFAULT_MIN_SDK) or DEFAULT_MIN_SDK)
    target_sdk = int(spec.get("target_sdk", DEFAULT_TARGET_SDK) or DEFAULT_TARGET_SDK)
    if min_sdk < 21:
        warnings.append(f"min_sdk {min_sdk} is below 21; AndroidX requires 21+")
    if target_sdk < min_sdk:
        raise ValueError(f"target_sdk ({target_sdk}) cannot be below min_sdk ({min_sdk})")

    features = spec["features"]
    if not isinstance(features, list) or not features:
        raise ValueError("features must be a non-empty array")

    clean_features = []
    seen_activities = set()
    for idx, feat in enumerate(features):
        if not isinstance(feat, dict):
            raise ValueError(f"feature[{idx}] must be an object")
        screen_name = str(feat.get("screen_name") or f"Screen {idx + 1}").strip()
        activity_name = str(feat.get("activity_name") or "").strip()
        if not activity_name:
            activity_name = _derive_activity_name(screen_name, idx)
            warnings.append(f"feature[{idx}] had no activity_name; derived '{activity_name}'")
        if not CLASS_RE.match(activity_name):
            raise ValueError(f"feature[{idx}] activity_name '{activity_name}' is not a valid class name")
        if activity_name in seen_activities:
            raise ValueError(f"duplicate activity_name '{activity_name}'")
        seen_activities.add(activity_name)

        layout_type = str(feat.get("layout_type") or "detail").strip().lower()
        if layout_type not in LAYOUT_TYPES:
            raise ValueError(
                f"feature[{idx}] layout_type '{layout_type}' invalid; "
                f"expected one of {', '.join(LAYOUT_TYPES)}"
            )

        clean_features.append({
            "screen_name": screen_name,
            "activity_name": activity_name,
            "layout_type": layout_type,
            "api_endpoint": str(feat.get("api_endpoint") or "").strip(),
            "auth_required": bool(feat.get("auth_required", False)),
            "fields": _normalize_fields(feat.get("fields")),
        })

    theme = _merge_theme(spec.get("theme"))

    clean = {
        "app_name": app_name,
        "package_id": package_id,
        "app_version": app_version,
        "min_sdk": min_sdk,
        "target_sdk": target_sdk,
        "features": clean_features,
        "theme": theme,
        "launcher_activity": clean_features[0]["activity_name"],
    }
    return clean, warnings


def _derive_activity_name(screen_name, idx):
    parts = re.findall(r"[A-Za-z0-9]+", screen_name)
    base = "".join(p.capitalize() for p in parts) if parts else f"Screen{idx + 1}"
    if not base[0].isalpha():
        base = "Screen" + base
    return base + "Activity"


def _normalize_fields(raw):
    if not isinstance(raw, list):
        return []
    out = []
    for f in raw:
        if isinstance(f, str):
            name = f.strip()
            if not name:
                continue
            out.append({"name": _to_snake(name), "label": name, "type": "text"})
        elif isinstance(f, dict) and f.get("name"):
            name = str(f["name"]).strip()
            out.append({
                "name": _to_snake(name),
                "label": str(f.get("label") or name).strip(),
                "type": str(f.get("type") or "text").strip().lower(),
            })
    return out


def _to_snake(text):
    text = re.sub(r"[^A-Za-z0-9]+", "_", text.strip())
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", text)
    return text.lower().strip("_") or "field"


def _merge_theme(raw):
    theme = json.loads(json.dumps(DEFAULT_THEME))  # deep copy
    if isinstance(raw, dict):
        colors = raw.get("colors")
        if isinstance(colors, dict):
            for key, val in colors.items():
                if isinstance(val, str) and HEX_RE.match(val.strip()):
                    theme["colors"][_to_snake(key)] = val.strip().upper()
        typ = raw.get("typography")
        if isinstance(typ, dict):
            for key in ("font_family", "body_size_sp", "title_size_sp"):
                if key in typ and typ[key] not in (None, ""):
                    theme["typography"][key] = typ[key]
    return theme


def xml_escape(text):
    return (
        str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace('"', "&quot;").replace("'", "&apos;")
    )


def java_string(text):
    return str(text).replace("\\", "\\\\").replace('"', '\\"')


# --------------------------------------------------------------------------- #
# Code generation
# --------------------------------------------------------------------------- #

def gen_settings_gradle(spec):
    return (
        'pluginManagement {\n'
        '    repositories {\n'
        '        google()\n'
        '        mavenCentral()\n'
        '        gradlePluginPortal()\n'
        '    }\n'
        '}\n'
        'dependencyResolutionManagement {\n'
        '    repositories {\n'
        '        google()\n'
        '        mavenCentral()\n'
        '    }\n'
        '}\n'
        f'rootProject.name = "{java_string(spec["app_name"])}"\n'
        'include ":app"\n'
    )


def gen_root_build_gradle(spec):
    return (
        '// Top-level build file. Generated by mobile_app_gen.py.\n'
        'plugins {\n'
        '    id "com.android.application" version "8.2.2" apply false\n'
        '}\n'
    )


def gen_app_build_gradle(spec):
    return (
        '// Module build file. Generated by mobile_app_gen.py.\n'
        'plugins {\n'
        '    id "com.android.application"\n'
        '}\n\n'
        'android {\n'
        f'    namespace "{spec["package_id"]}"\n'
        f'    compileSdk {spec["target_sdk"]}\n\n'
        '    defaultConfig {\n'
        f'        applicationId "{spec["package_id"]}"\n'
        f'        minSdk {spec["min_sdk"]}\n'
        f'        targetSdk {spec["target_sdk"]}\n'
        '        versionCode 1\n'
        f'        versionName "{spec["app_version"]}"\n'
        '    }\n\n'
        '    buildTypes {\n'
        '        release {\n'
        '            minifyEnabled false\n'
        '            proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"\n'
        '        }\n'
        '    }\n'
        '    compileOptions {\n'
        '        sourceCompatibility JavaVersion.VERSION_17\n'
        '        targetCompatibility JavaVersion.VERSION_17\n'
        '    }\n'
        '}\n\n'
        'dependencies {\n'
        '    implementation "androidx.appcompat:appcompat:1.6.1"\n'
        '    implementation "com.google.android.material:material:1.11.0"\n'
        '    implementation "androidx.constraintlayout:constraintlayout:2.1.4"\n'
        '    implementation "androidx.recyclerview:recyclerview:1.3.2"\n'
        '}\n'
    )


def gen_gradle_properties():
    return (
        "android.useAndroidX=true\n"
        "android.nonTransitiveRClass=true\n"
        "org.gradle.jvmargs=-Xmx2048m\n"
    )


def gen_manifest_xml(spec):
    activities = []
    for i, feat in enumerate(spec["features"]):
        is_launcher = feat["activity_name"] == spec["launcher_activity"]
        intent = ""
        if is_launcher:
            intent = (
                "\n            <intent-filter>\n"
                '                <action android:name="android.intent.action.MAIN" />\n'
                '                <category android:name="android.intent.category.LAUNCHER" />\n'
                "            </intent-filter>\n        "
            )
        exported = "true" if is_launcher else "false"
        activities.append(
            f'        <activity\n'
            f'            android:name=".{feat["activity_name"]}"\n'
            f'            android:exported="{exported}"\n'
            f'            android:label="{xml_escape(feat["screen_name"])}">{intent}\n'
            f'        </activity>'
        )
    needs_internet = any(f["api_endpoint"] or f["layout_type"] == "webview" for f in spec["features"])
    internet = '    <uses-permission android:name="android.permission.INTERNET" />\n' if needs_internet else ""
    body = "\n".join(activities)
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n\n'
        f'{internet}'
        '    <application\n'
        '        android:allowBackup="true"\n'
        '        android:label="@string/app_name"\n'
        '        android:supportsRtl="true"\n'
        '        android:theme="@style/Theme.App">\n\n'
        f'{body}\n\n'
        '    </application>\n\n'
        '</manifest>\n'
    )


def gen_colors_xml(spec):
    colors = spec["theme"]["colors"]
    lines = ['<?xml version="1.0" encoding="utf-8"?>', "<resources>"]
    for key, val in colors.items():
        lines.append(f'    <color name="{key}">{val}</color>')
    lines.append("</resources>")
    return "\n".join(lines) + "\n"


def gen_strings_xml(spec):
    lines = ['<?xml version="1.0" encoding="utf-8"?>', "<resources>"]
    lines.append(f'    <string name="app_name">{xml_escape(spec["app_name"])}</string>')
    for feat in spec["features"]:
        key = "title_" + _to_snake(feat["activity_name"])
        lines.append(f'    <string name="{key}">{xml_escape(feat["screen_name"])}</string>')
    lines.append("</resources>")
    return "\n".join(lines) + "\n"


def gen_themes_xml(spec):
    t = spec["theme"]["typography"]
    title_sp = t.get("title_size_sp", 20)
    body_sp = t.get("body_size_sp", 16)
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<resources xmlns:tools="http://schemas.android.com/tools">\n'
        '    <style name="Theme.App" parent="Theme.Material3.DayNight.NoActionBar">\n'
        '        <item name="colorPrimary">@color/primary</item>\n'
        '        <item name="colorPrimaryVariant">@color/primary_variant</item>\n'
        '        <item name="colorSecondary">@color/secondary</item>\n'
        '        <item name="android:colorBackground">@color/background</item>\n'
        '        <item name="colorOnPrimary">@color/on_primary</item>\n'
        '    </style>\n'
        f'    <style name="AppText.Title">\n'
        f'        <item name="android:textSize">{title_sp}sp</item>\n'
        '        <item name="android:textStyle">bold</item>\n'
        '    </style>\n'
        f'    <style name="AppText.Body">\n'
        f'        <item name="android:textSize">{body_sp}sp</item>\n'
        '    </style>\n'
        '</resources>\n'
    )


def _layout_id(activity_name):
    return "activity_" + _to_snake(activity_name)


def gen_layout_xml(feat):
    lt = feat["layout_type"]
    if lt == "list":
        inner = (
            '    <androidx.recyclerview.widget.RecyclerView\n'
            f'        android:id="@+id/list_{_to_snake(feat["activity_name"])}"\n'
            '        android:layout_width="match_parent"\n'
            '        android:layout_height="match_parent"\n'
            '        android:clipToPadding="false"\n'
            '        android:padding="8dp" />\n'
        )
    elif lt == "form":
        rows = []
        for fld in feat["fields"]:
            input_type = {
                "email": "textEmailAddress", "password": "textPassword",
                "number": "number", "phone": "phone", "text": "text",
            }.get(fld["type"], "text")
            rows.append(
                '    <com.google.android.material.textfield.TextInputLayout\n'
                '        android:layout_width="match_parent"\n'
                '        android:layout_height="wrap_content"\n'
                f'        android:hint="{xml_escape(fld["label"])}">\n'
                '        <com.google.android.material.textfield.TextInputEditText\n'
                f'            android:id="@+id/input_{fld["name"]}"\n'
                '            android:layout_width="match_parent"\n'
                '            android:layout_height="wrap_content"\n'
                f'            android:inputType="{input_type}" />\n'
                '    </com.google.android.material.textfield.TextInputLayout>\n'
            )
        rows.append(
            '    <com.google.android.material.button.MaterialButton\n'
            '        android:id="@+id/btn_submit"\n'
            '        android:layout_width="match_parent"\n'
            '        android:layout_height="wrap_content"\n'
            '        android:layout_marginTop="16dp"\n'
            '        android:text="Submit" />\n'
        )
        inner = "".join(rows)
    elif lt == "dashboard":
        inner = (
            '    <androidx.gridlayout.widget.GridLayout\n'
            '        android:layout_width="match_parent"\n'
            '        android:layout_height="wrap_content"\n'
            '        app:columnCount="2"\n'
            '        android:padding="8dp">\n'
            '        <TextView\n'
            '            android:layout_width="wrap_content"\n'
            '            android:layout_height="wrap_content"\n'
            '            android:text="Dashboard cards render here"\n'
            '            style="@style/AppText.Body" />\n'
            '    </androidx.gridlayout.widget.GridLayout>\n'
        )
    elif lt == "webview":
        inner = (
            '    <WebView\n'
            f'        android:id="@+id/webview_{_to_snake(feat["activity_name"])}"\n'
            '        android:layout_width="match_parent"\n'
            '        android:layout_height="match_parent" />\n'
        )
    else:  # detail
        detail_rows = []
        for fld in feat["fields"] or [{"name": "content", "label": "Content", "type": "text"}]:
            detail_rows.append(
                '    <TextView\n'
                f'        android:id="@+id/value_{fld["name"]}"\n'
                '        android:layout_width="match_parent"\n'
                '        android:layout_height="wrap_content"\n'
                '        android:layout_marginBottom="12dp"\n'
                f'        android:text="{xml_escape(fld["label"])}"\n'
                '        style="@style/AppText.Body" />\n'
            )
        inner = "".join(detail_rows)

    scrollable = lt in ("detail", "form")
    open_tag = (
        '<ScrollView xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    xmlns:app="http://schemas.android.com/apk/res-auto"\n'
        '    android:layout_width="match_parent"\n'
        '    android:layout_height="match_parent">\n'
        '  <LinearLayout\n'
        '      android:layout_width="match_parent"\n'
        '      android:layout_height="wrap_content"\n'
        '      android:orientation="vertical"\n'
        '      android:padding="16dp">\n'
    )
    close_tag = "  </LinearLayout>\n</ScrollView>\n"
    if scrollable:
        return open_tag + inner + close_tag
    return (
        '<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    xmlns:app="http://schemas.android.com/apk/res-auto"\n'
        '    android:layout_width="match_parent"\n'
        '    android:layout_height="match_parent">\n'
        + inner +
        '</FrameLayout>\n'
    )


def gen_activity_java(spec, feat):
    pkg = spec["package_id"]
    cls = feat["activity_name"]
    layout_id = _layout_id(cls)
    lt = feat["layout_type"]
    imports = [
        "android.os.Bundle",
        "androidx.appcompat.app.AppCompatActivity",
    ]
    body_lines = [
        "        super.onCreate(savedInstanceState);",
        f"        setContentView(R.layout.{layout_id});",
    ]

    if feat["auth_required"]:
        body_lines.append("        // This screen requires authentication.")
        body_lines.append("        if (!AuthGuard.isAuthenticated(this)) {")
        body_lines.append("            AuthGuard.redirectToLogin(this);")
        body_lines.append("            return;")
        body_lines.append("        }")

    if lt == "webview":
        imports += ["android.webkit.WebView", "android.webkit.WebViewClient"]
        target = feat["api_endpoint"] or "https://example.com"
        body_lines += [
            f'        WebView webView = findViewById(R.id.webview_{_to_snake(cls)});',
            "        webView.setWebViewClient(new WebViewClient());",
            "        webView.getSettings().setJavaScriptEnabled(true);",
            f'        webView.loadUrl("{java_string(target)}");',
        ]
    elif lt == "list":
        imports += [
            "androidx.recyclerview.widget.RecyclerView",
            "androidx.recyclerview.widget.LinearLayoutManager",
        ]
        body_lines += [
            f'        RecyclerView list = findViewById(R.id.list_{_to_snake(cls)});',
            "        list.setLayoutManager(new LinearLayoutManager(this));",
            "        // TODO: attach an adapter backed by " + (feat["api_endpoint"] or "your data source") + ".",
        ]
    elif feat["api_endpoint"]:
        body_lines.append(f'        // TODO: load data from {feat["api_endpoint"]} and bind to the views.')

    import_block = "\n".join(f"import {imp};" for imp in sorted(set(imports)))
    body = "\n".join(body_lines)
    return (
        f"package {pkg};\n\n"
        f"{import_block}\n\n"
        f"/**\n"
        f" * {feat['screen_name']} ({lt} screen).\n"
        f" * Generated by mobile_app_gen.py. Endpoint: {feat['api_endpoint'] or 'none'}.\n"
        f" */\n"
        f"public class {cls} extends AppCompatActivity {{\n\n"
        f"    @Override\n"
        f"    protected void onCreate(Bundle savedInstanceState) {{\n"
        f"{body}\n"
        f"    }}\n"
        f"}}\n"
    )


def gen_auth_guard_java(spec):
    pkg = spec["package_id"]
    return (
        f"package {pkg};\n\n"
        "import android.content.Context;\n"
        "import android.content.Intent;\n"
        "import android.content.SharedPreferences;\n\n"
        "/**\n"
        " * Minimal authentication guard. Generated by mobile_app_gen.py.\n"
        " * Replace the token check with your real auth mechanism.\n"
        " */\n"
        "public final class AuthGuard {\n\n"
        "    private static final String PREFS = \"tenax_auth\";\n"
        "    private static final String KEY_TOKEN = \"access_token\";\n\n"
        "    private AuthGuard() { }\n\n"
        "    public static boolean isAuthenticated(Context context) {\n"
        "        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);\n"
        "        String token = prefs.getString(KEY_TOKEN, null);\n"
        "        return token != null && !token.isEmpty();\n"
        "    }\n\n"
        "    public static void redirectToLogin(Context context) {\n"
        "        // TODO: point this at your real login activity.\n"
        "        Intent intent = new Intent();\n"
        "        intent.setClassName(context, \"" + pkg + ".LoginActivity\");\n"
        "        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);\n"
        "        // Guarded so generated projects without a LoginActivity still run.\n"
        "        try { context.startActivity(intent); } catch (Exception ignored) { }\n"
        "    }\n"
        "}\n"
    )


# --------------------------------------------------------------------------- #
# Project assembly
# --------------------------------------------------------------------------- #

def build_project(spec, output_dir):
    """Write all files. Returns a list of {path, sha256, bytes}."""
    pkg_path = os.path.join(*spec["package_id"].split("."))
    java_base = os.path.join("app", "src", "main", "java", pkg_path)
    res_base = os.path.join("app", "src", "main", "res")

    files = {
        "settings.gradle": gen_settings_gradle(spec),
        "build.gradle": gen_root_build_gradle(spec),
        "gradle.properties": gen_gradle_properties(),
        os.path.join("app", "build.gradle"): gen_app_build_gradle(spec),
        os.path.join("app", "src", "main", "AndroidManifest.xml"): gen_manifest_xml(spec),
        os.path.join(res_base, "values", "colors.xml"): gen_colors_xml(spec),
        os.path.join(res_base, "values", "strings.xml"): gen_strings_xml(spec),
        os.path.join(res_base, "values", "themes.xml"): gen_themes_xml(spec),
        os.path.join(java_base, "AuthGuard.java"): gen_auth_guard_java(spec),
    }

    for feat in spec["features"]:
        files[os.path.join(res_base, "layout", _layout_id(feat["activity_name"]) + ".xml")] = gen_layout_xml(feat)
        files[os.path.join(java_base, feat["activity_name"] + ".java")] = gen_activity_java(spec, feat)

    written = []
    for rel_path, content in files.items():
        full = os.path.join(output_dir, rel_path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        data = content.encode("utf-8")
        with open(full, "w", encoding="utf-8") as fh:
            fh.write(content)
        written.append({
            "path": rel_path.replace(os.sep, "/"),
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
        })
    return written


# --------------------------------------------------------------------------- #
# Smoke test (structural validation; full compile needs the Android SDK)
# --------------------------------------------------------------------------- #

def smoke_test(output_dir, written):
    """Validate generated files structurally. Returns a report dict."""
    checks = {"xml_wellformed": 0, "xml_failed": [], "java_balanced": 0, "java_failed": []}
    for entry in written:
        full = os.path.join(output_dir, entry["path"])
        if entry["path"].endswith(".xml"):
            try:
                minidom.parse(full)
                checks["xml_wellformed"] += 1
            except Exception as err:  # noqa: BLE001
                checks["xml_failed"].append({"path": entry["path"], "error": str(err)})
        elif entry["path"].endswith(".java"):
            with open(full, "r", encoding="utf-8") as fh:
                src = fh.read()
            if _java_braces_balanced(src) and "class " in src:
                checks["java_balanced"] += 1
            else:
                checks["java_failed"].append({"path": entry["path"], "error": "unbalanced braces or no class"})

    javac = _which("javac")
    checks["javac_available"] = bool(javac)
    checks["compilation_note"] = (
        "Structural validation only. A full javac/d8 compile requires the Android SDK "
        "(android.jar on the classpath); install it via the Phase 10 Dockerfile before "
        "running a real compile smoke test."
    )
    checks["passed"] = not checks["xml_failed"] and not checks["java_failed"]
    return checks


def _java_braces_balanced(src):
    depth = 0
    in_str = in_char = in_line = in_block = False
    prev = ""
    for ch in src:
        if in_line:
            if ch == "\n":
                in_line = False
        elif in_block:
            if prev == "*" and ch == "/":
                in_block = False
        elif in_str:
            if ch == '"' and prev != "\\":
                in_str = False
        elif in_char:
            if ch == "'" and prev != "\\":
                in_char = False
        else:
            if prev == "/" and ch == "/":
                in_line = True
            elif prev == "/" and ch == "*":
                in_block = True
            elif ch == '"':
                in_str = True
            elif ch == "'":
                in_char = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth < 0:
                    return False
        prev = ch
    return depth == 0


def _which(binary):
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        candidate = os.path.join(directory, binary)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main(argv=None):
    parser = argparse.ArgumentParser(description="Generate Android app source from a JSON spec.")
    parser.add_argument("--input", required=False, help="Path to the JSON app specification.")
    parser.add_argument("--output", required=False, default=".", help="Output directory for generated files.")
    parser.add_argument("--dry-run", action="store_true", help="Validate and report without writing files.")
    parser.add_argument("--no-smoke-test", action="store_true", help="Skip structural validation.")
    args = parser.parse_args(argv)

    spec_raw = load_spec(args.input)
    try:
        spec, warnings = validate_spec(spec_raw)
    except ValueError as err:
        die(str(err))

    result = {
        "ok": True,
        "app_name": spec["app_name"],
        "package_id": spec["package_id"],
        "app_version": spec["app_version"],
        "min_sdk": spec["min_sdk"],
        "target_sdk": spec["target_sdk"],
        "feature_count": len(spec["features"]),
        "layouts": sorted({f["layout_type"] for f in spec["features"]}),
        "warnings": warnings,
        "dry_run": bool(args.dry_run),
        "generated_at": now_iso(),
    }

    if args.dry_run:
        result["files_planned"] = 3 + 2 + 2 * len(spec["features"]) + 2  # gradle + res values + per-feature + auth
        print(json.dumps(result, ensure_ascii=False))
        return 0

    output_dir = args.output or "."
    os.makedirs(output_dir, exist_ok=True)
    written = build_project(spec, output_dir)

    manifest = {
        "generator": "mobile_app_gen.py",
        "generated_at": now_iso(),
        "spec": spec,
        "files": written,
    }
    manifest_rel = os.path.join("build", "app_gen_manifest.json")
    manifest_full = os.path.join(output_dir, manifest_rel)
    os.makedirs(os.path.dirname(manifest_full), exist_ok=True)
    with open(manifest_full, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)

    result["files_generated"] = [w["path"] for w in written]
    result["file_count"] = len(written)
    result["manifest_path"] = manifest_rel.replace(os.sep, "/")

    if not args.no_smoke_test:
        result["smoke_test"] = smoke_test(output_dir, written)
        if not result["smoke_test"]["passed"]:
            result["ok"] = False

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
