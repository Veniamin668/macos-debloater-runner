# 🧹 macOS Runner Debloater

**A powerful disk cleanup GitHub Action for GitHub-hosted macOS runners.**

Reclaim disk space by removing unnecessary preinstalled software, development toolchains, SDKs, simulators, caches and other runner image components.

- Automatic macOS and CPU architecture detection
- Configurable Xcode cleanup and platform stripping
- Homebrew package and dependency cleanup (White list)
- Android, Java, .NET, PowerShell and Rust cleanup
- Browser, simulator and tool cache removal
- Protected paths and software
- Before/after disk space measurements
- Detailed GitHub Actions job summary

Tailscale and Sunshine/Apollo are explicitly protected.

---

## 🚀 Real-world results

Tested on a GitHub-hosted **macOS 27.0.1 ARM64 (Apple Silicon)** runner.

| Metric | Result |
|---|---:|
| Free space before | 36.56 GiB |
| Free space after | 147.37 GiB |
| **Space reclaimed** | **110.81 GiB** |
| Execution time | 3m 35s |

### Before / After

| Before cleanup | After cleanup |
|:---:|:---:|
| ![Before cleanup](docs/before.png) | ![After cleanup](docs/after.png) |
| **36.56 GiB free** | **147.37 GiB free** |

---

## ⚡ Quick Integration

Add this action as the first step in your workflow, before checking out your repository or installing additional dependencies.

```yaml
name: macOS Build

on:
  workflow_dispatch:
  push:

jobs:
  build:
    runs-on: xcode-27

    steps:
      - name: 🧹 Debloat macOS Runner
        id: debloat
        uses: Veniamin668/macos-debloater-runner@v2
        with:
          xcode: none

      - name: Checkout
        uses: actions/checkout@v4

      - name: Display disk space results
        run: |
          echo "Before: ${{ steps.debloat.outputs.free-before-gb }} GiB"
          echo "After:  ${{ steps.debloat.outputs.free-after-gb }} GiB"
          echo "Freed:  ${{ steps.debloat.outputs.freed-gb }} GiB"

      # Your build steps here
```

**No checkout is required before running the debloater.** GitHub Actions downloads the action directly from its repository.

### Maximum cleanup

For workflows that do not need Xcode, Android, Java, browsers or other development environments:

```yaml
- name: 💀 Fully Debloat macOS Runner
  uses: Veniamin668/macos-debloater-runner@v2
  with:
    xcode: none
    simulators: true
    android: true
    java-keep: none
    dotnet: true
    powershell: true
    rust: true
    browsers: true
    homebrew: true
    toolcache-keep-latest: ''
    toolcache-remove: 'Python,node,Ruby,go,PyPy,CodeQL'
    caches: true
    misc: true
    disable-spotlight: true
    report-sizes: true
```

This is an aggressive configuration. Make sure your workflow does not depend on the software being removed.

---

## 🧪 Safe Testing

Preview cleanup operations before actually deleting anything:

```yaml
- name: Preview macOS cleanup
  uses: Veniamin668/macos-debloater-runner@v2
  with:
    dry-run: true
```

Dry-run mode:

- Does not delete files.
- Displays planned cleanup operations.
- Automatically analyzes large directories.
- Automatically measures cleanup target sizes.
- Helps estimate potential disk space recovery.

---

## ⚙️ Configuration

All inputs are optional. The following tables list their default values.

### Xcode

| Input | Default | Description |
|---|---|---|
| `xcode` | `default` | Select which Xcode installation to keep |
| `xcode-strip-platforms` | Empty | Remove selected platforms from the retained Xcode |

Supported `xcode` values:

| Value | Behavior |
|---|---|
| `default` | Keep the Xcode currently referenced by `/Applications/Xcode.app` |
| `latest` | Keep the newest installed Xcode |
| `27.2`, `16.4`, etc. | Keep a specific version |
| `none` | Remove all Xcode installations |
| `all` | Leave all Xcode installations untouched |

If a requested version is unavailable, the action fails before performing cleanup.

After selecting Xcode, the action updates `/Applications/Xcode.app` and `xcode-select` accordingly.

Supported platform stripping values:

- `ios`
- `tvos`
- `watchos`
- `visionos`
- `driverkit`
- `all`

Example:

```yaml
- uses: Veniamin668/macos-debloater-runner@v2
  with:
    xcode: '27.2'
    xcode-strip-platforms: 'tvos,watchos,visionos'
```

`all` removes the supported additional platforms while retaining the macOS platform.

### Cleanup categories

| Input | Default | Description |
|---|---|---|
| `simulators` | `true` | Remove simulator runtimes, CoreSimulator and developer directories |
| `android` | `true` | Remove Android SDK directories and related user data |
| `dotnet` | `true` | Remove .NET SDKs and related files |
| `powershell` | `true` | Remove PowerShell installations |
| `rust` | `true` | Remove Rust, rustup and Cargo |
| `browsers` | `true` | Remove Chrome, Edge, browser drivers and Selenium |
| `homebrew` | `true` | Clean Homebrew packages, dependencies and caches |
| `caches` | `true` | Clean development and package-manager caches |
| `misc` | `true` | Remove miscellaneous runner image leftovers |

Set a category to `false` to preserve it.

### Java

| Input | Default | Description |
|---|---|---|
| `java-keep` | `21` | JDK major version to retain |

Supported values:

- `21`, `17`, etc. — preserve the selected JDK version.
- `none` — remove all detected JDK installations.
- `all` — leave Java installations untouched.

### Homebrew

| Input | Default | Description |
|---|---|---|
| `homebrew` | `true` | Enable or disable Homebrew cleanup |
| `homebrew-remove` | Empty | Additional formulae or casks to uninstall |
| `homebrew-keep` | Empty | Formulae or casks that must never be uninstalled |

Additional package names and glob patterns are comma-separated.

The cleanup includes selected heavyweight packages, outdated Node.js/Python versions, browser packages and unnecessary dependencies.

Tailscale and Sunshine/Apollo packages and their protected dependencies are excluded.

### Tool Cache

| Input | Default | Description |
|---|---|---|
| `toolcache-keep-latest` | `Python,node` | Keep only the newest version of selected packages |
| `toolcache-remove` | `Ruby,go,PyPy,CodeQL` | Remove selected tool cache packages completely |

The action detects the tool cache through `RUNNER_TOOL_CACHE`, falling back to `~/hostedtoolcache`.

### Additional protection

| Input | Default | Description |
|---|---|---|
| `keep-paths` | Empty | Additional filesystem paths that must never be deleted |

Multiple paths can be specified using commas.

### Diagnostics and system settings

| Input | Default | Description |
|---|---|---|
| `dry-run` | `false` | Preview cleanup without deleting anything |
| `report-sizes` | `false` | Measure individual cleanup targets |
| `analyze` | `false` | Display the largest directories before cleanup |
| `disable-spotlight` | `true` | Disable Spotlight indexing |

Disk analysis and size reporting are automatically enabled in dry-run mode.

**Spotlight note:** When enabled, Spotlight indexing is disabled using `mdutil`. The action does not currently automatically re-enable it.

---

## 💡 Usage Examples

### iOS / macOS development

Keep Xcode and remove unnecessary platforms.

```yaml
- uses: Veniamin668/macos-debloater-runner@v2
  with:
    xcode: '27.2'
    xcode-strip-platforms: 'tvos,watchos,visionos'
    android: true
```

### Android development

Preserve Android tooling and JDK 17.

```yaml
- uses: Veniamin668/macos-debloater-runner@v2
  with:
    xcode: none
    android: false
    java-keep: '17'
```

### Streaming / Sunshine

Remove unnecessary development environments while retaining streaming software.

```yaml
- uses: Veniamin668/macos-debloater-runner@v2
  with:
    xcode: none
    simulators: true
    android: true
    homebrew: true
```

### Preview only

```yaml
- uses: Veniamin668/macos-debloater-runner@v2
  with:
    dry-run: true
```

---

## 🛡️ Protected Components

The action explicitly protects:

- Tailscale.
- Sunshine and Apollo.
- Protected Homebrew dependencies required by these applications.
- Safari and Firefox.
- GitHub Actions runner directories:
  - `~/actions-runner`
  - `~/work`
  - `~/bootstrap`
  - `RUNNER_TEMP`
  - `GITHUB_WORKSPACE`
- Currently active Node.js and Python executables.
- Additional paths configured through `keep-paths`.
- Homebrew packages configured through `homebrew-keep`.

Protected paths are checked during cleanup operations, including directory-content cleanup.

---

## 📊 Outputs

The action exposes three outputs.

| Output | Description |
|---|---|
| `freed-gb` | GiB freed, measured using `df` on the Data volume |
| `free-before-gb` | Available disk space before cleanup |
| `free-after-gb` | Available disk space after cleanup |

Example:

```yaml
- name: Display cleanup results
  run: |
    echo "Before: ${{ steps.debloat.outputs.free-before-gb }} GiB"
    echo "After:  ${{ steps.debloat.outputs.free-after-gb }} GiB"
    echo "Freed:  ${{ steps.debloat.outputs.freed-gb }} GiB"
```

The action also generates a GitHub Actions job summary containing:

- Before/after disk space measurements.
- Cleanup results.
- Cleanup category information.
- Individual operation timings.
- Total execution time.

---

## 🔍 Automatic Detection

No manual architecture or Homebrew configuration is required.

The action automatically detects:

- macOS version.
- CPU architecture (Apple Silicon or Intel).
- Homebrew installation prefix (`/opt/homebrew` or `/usr/local`).
- Installed Xcode versions.
- Active Node.js and Python executables.

The detected environment is displayed in the action logs.

### Supported runners

| Runner label | Architecture | Environment |
|---|---|---|
| `macos-15` | ARM64 | macOS Sequoia |
| `macos-26` | ARM64 | macOS 26 |
| `macos-26-intel` | x86_64 | Intel |
| `xcode-27` | ARM64 | macOS 27 |

Other macOS environments may also work if they provide passwordless `sudo` and Node.js.

---

## 🧹 How It Works

1. **Environment detection** — detects macOS, CPU architecture, Homebrew and installed Xcode versions.
2. **Cleanup planning** — resolves the requested Xcode configuration before destructive operations.
3. **Disk analysis** — optionally identifies large directories and cleanup targets.
4. **Fast removal** — attempts to move selected targets into a temporary directory before deletion.
5. **Background deletion** — processes deletion jobs using up to three parallel workers.
6. **Protected Homebrew cleanup** — calculates protected dependencies before uninstalling packages and orphaned dependencies.
7. **Final measurements** — waits for deletion workers and measures available disk space again.

---

## 📋 Requirements

- macOS.
- Passwordless `sudo`.
- Node.js available in `PATH`.

GitHub-hosted macOS runners normally provide these requirements.

---

## ❓ FAQ

### Does this action require checkout?

No. GitHub Actions downloads the referenced action directly from its repository.

### Can it break my workflow?

Yes, if your workflow requires software that has been removed.

The default configuration is intentionally aggressive. Use `dry-run: true` before destructive cleanup and disable individual categories when necessary.

### Does it remove Tailscale or Sunshine?

No. These applications and their protected Homebrew dependencies are explicitly excluded.

### Can I use it on Intel runners?

Yes. The action detects the architecture and adjusts its Homebrew prefix and relevant paths.

### Why are final disk measurements displayed at the end?

Deletion operations can run in the background. Final measurements are collected after all deletion workers have completed.

---

## 📄 License

This project is licensed under the **BSD 3-Clause License**.

See [LICENSE](LICENSE) for the full license text.

---

**Maintained by [Veniamin668](https://github.com/Veniamin668).**
