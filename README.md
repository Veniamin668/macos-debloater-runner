🧹 macOS Runner Debloater

A powerful disk cleanup action for GitHub-hosted macOS runners.

Free up disk space by removing unnecessary preinstalled software, development toolchains, simulators, SDKs, caches and other runner image components.

Choose which Xcode installation to keep, configure individual cleanup categories, protect important software and inspect disk usage before making changes.

Tailscale and Sunshine/Apollo are explicitly protected.

GitHub-hosted macOS images come with a substantial amount of preinstalled software. This action helps reclaim valuable disk space for builds, development environments, streaming sessions and large downloads.

Before / After

Before| After
"Disk space before cleanup" (docs/before.png)| "Disk space after cleanup" (docs/after.png)

Quick Start

Add the action as the first step in your GitHub Actions workflow:

name: Build

on:
  push:
  workflow_dispatch:

jobs:
  build:
    runs-on: macos-26

    steps:
      - name: Free up disk space
        id: debloat
        uses: Veniamin668/macos-debloater-runner@1
        with:
          xcode: none

      - uses: actions/checkout@v4

      # Your workflow steps

      - name: Display cleanup results
        run: |
          echo "Freed: ${{ steps.debloat.outputs.freed-gb }} GiB"
          echo "Before: ${{ steps.debloat.outputs.free-before-gb }} GiB"
          echo "After: ${{ steps.debloat.outputs.free-after-gb }} GiB"

No checkout is required before the debloater. GitHub Actions downloads the action directly from its repository.

Safe Testing

Before enabling destructive cleanup, you can inspect the cleanup plan:

- name: Preview cleanup
  uses: Veniamin668/macos-debloater-runner@1
  with:
    dry-run: true

Dry-run mode:

- Does not delete files.
- Displays planned cleanup operations.
- Analyzes large directories.
- Measures individual target sizes.
- Estimates reclaimable disk space.

Once satisfied with the plan, disable "dry-run".

Configuration

Xcode

The "xcode" input determines which Xcode installation is retained.

Value| Behavior
"default"| Keep the Xcode installation currently referenced by "Xcode.app"
"latest"| Keep the newest installed Xcode version
"27.2", "16.4", "26.1", etc.| Keep the specified version
"none"| Remove all Xcode installations and select Command Line Tools
"all"| Leave all Xcode installations untouched

If the requested version is unavailable, the action fails before performing cleanup and reports installed versions.

After cleanup, "/Applications/Xcode.app" and "xcode-select" are updated to reference the retained installation.

Xcode Platform Stripping

Use "xcode-strip-platforms" to remove unnecessary development platforms from the retained Xcode installation.

Supported values:

- "ios"
- "tvos"
- "watchos"
- "visionos"
- "driverkit"
- "all"

Example:

- uses: Veniamin668/macos-debloater-runner@1
  with:
    xcode: "27.2"
    xcode-strip-platforms: tvos,watchos,visionos

"all" removes all supported additional platforms, leaving the macOS platform intact.

Cleanup Categories

Each category can be independently enabled or disabled.

Input| Default| Description
"simulators"| "true"| Remove simulator runtimes, CoreSimulator and developer directories
"android"| "true"| Remove Android SDK and related user directories
"dotnet"| "true"| Remove .NET SDK installations and related files
"powershell"| "true"| Remove PowerShell installations
"rust"| "true"| Remove Rust toolchains, rustup and Cargo
"browsers"| "true"| Remove Chrome, Edge, browser drivers and Selenium
"homebrew"| "true"| Remove selected Homebrew packages and clean dependencies
"caches"| "true"| Clean development and package-manager caches
"misc"| "true"| Remove miscellaneous runner image leftovers

Set an input to "false" to preserve its corresponding cleanup category.

Homebrew Configuration

Homebrew cleanup uses explicit removal lists and protected dependency calculations.

Input| Default| Description
"homebrew"| "true"| Enable or disable Homebrew cleanup
"homebrew-remove"| "''"| Additional formulae or casks to uninstall, comma-separated
"homebrew-keep"| "''"| Formulae or casks that must never be uninstalled, comma-separated

The cleanup includes selected heavy development packages, outdated Node.js/Python versions, browser packages and unnecessary dependencies.

Tailscale and Sunshine/Apollo packages and their protected dependencies are excluded from removal.

Java

Input| Default| Description
"java-keep"| "21"| JDK major version to retain

Supported values:

- "21", "17", etc. — preserve the selected JDK major version.
- "none" — remove all detected JDK installations.
- "all" — leave Java installations untouched.

Tool Cache

Input| Default| Description
"toolcache-keep-latest"| "Python,node"| Keep only the newest version of selected tool cache packages
"toolcache-remove"| "Ruby,go,PyPy,CodeQL"| Remove selected tool cache packages completely

The action automatically detects the runner tool cache location using "RUNNER_TOOL_CACHE", falling back to "~/hostedtoolcache".

Additional Protection

Input| Default| Description
"keep-paths"| "''"| Additional filesystem paths that must never be deleted

Multiple paths can be specified using commas.

Protected paths are checked during cleanup operations, including when cleaning directory contents.

Diagnostics and System Settings

Input| Default| Description
"dry-run"| "false"| Preview cleanup without deleting anything
"report-sizes"| "false"| Measure individual cleanup targets
"analyze"| "false"| Display the largest directories before cleanup
"disable-spotlight"| "true"| Disable Spotlight indexing

Size reporting and disk analysis are automatically enabled in dry-run mode.

Note: Spotlight indexing is disabled through "mdutil". The action does not currently include an automatic re-enable operation.

Usage Examples

Maximum Cleanup

Suitable for streaming, general CI, scripting and environments that do not require Xcode or Android tooling.

- uses: Veniamin668/macos-debloater-runner@1
  with:
    xcode: none

iOS / macOS Development

Keep one Xcode installation and remove unnecessary platforms.

- uses: Veniamin668/macos-debloater-runner@1
  with:
    xcode: "27.2"
    xcode-strip-platforms: tvos,watchos,visionos
    android: true

Android Development on macOS

Preserve Android tooling and JDK 17.

- uses: Veniamin668/macos-debloater-runner@1
  with:
    xcode: none
    android: false
    java-keep: "17"

Streaming / Sunshine / Apollo

Remove unnecessary development environments while preserving the software required for streaming.

- uses: Veniamin668/macos-debloater-runner@1
  with:
    xcode: none
    simulators: true
    android: true
    homebrew: true

Preview Only

Inspect the cleanup plan without modifying the runner.

- uses: Veniamin668/macos-debloater-runner@1
  with:
    dry-run: true

Automatic Detection

No manual runner configuration is required.

The action automatically detects:

- macOS version.
- CPU architecture (Apple Silicon or Intel).
- Homebrew installation prefix ("/opt/homebrew" or "/usr/local").
- Installed Xcode versions.
- Active "node" and "python3" executables.

The detected environment is displayed in the action logs.

Supported Runners

Runner label| Architecture| Description
"macos-15"| ARM64| macOS Sequoia
"macos-26"| ARM64| macOS 26
"macos-26-intel"| x86_64| Intel runner
"xcode-27"| ARM64| macOS 27

Other macOS environments may work if they provide passwordless "sudo" and Node.js.

What Gets Removed

Component| Cleanup operations
Xcode| Unselected Xcode installations and optionally selected development platforms
Simulators| Simulator runtimes, CoreSimulator and "~/Library/Developer"
Android| "~/Library/Android" and "~/.android"
Homebrew| Selected formulae, casks, outdated runtimes and unnecessary dependencies
Tool cache| Selected outdated tool versions and unnecessary toolchains
Java| JDK installations except the configured version
.NET| SDK installations and related files
PowerShell| PowerShell installations
Rust| Rustup and Cargo directories
Browsers| Google Chrome, Microsoft Edge, browser drivers and Selenium
Caches| Package-manager and development caches
Miscellaneous| vcpkg, "~/image-generation" and "~/actionarchivecache"

Protected Components

The action explicitly protects:

- Tailscale and Sunshine / Apollo, including protected Homebrew dependencies.
- Safari and Firefox, including "geckodriver".
- GitHub Actions runner directories:
  - "~/actions-runner"
  - "~/work"
  - "~/bootstrap"
  - "RUNNER_TEMP"
  - "GITHUB_WORKSPACE"
- The currently active "node" and "python3" executables in "PATH".
- The newest Homebrew Node.js and Python packages.
- Essential utilities such as Git, GitHub CLI, curl, jq, CMake, Ninja and OpenSSL.
- Additional paths and Homebrew packages specified through "keep-paths" and "homebrew-keep".

Outputs

The action exposes the following outputs:

Output| Description
"freed-gb"| GiB freed, measured using "df" on the Data volume
"free-before-gb"| Available disk space before cleanup
"free-after-gb"| Available disk space after cleanup

Example:

- name: Display available space
  run: |
    echo "Before: ${{ steps.debloat.outputs.free-before-gb }} GiB"
    echo "After:  ${{ steps.debloat.outputs.free-after-gb }} GiB"
    echo "Freed:  ${{ steps.debloat.outputs.freed-gb }} GiB"

The action also generates a GitHub Actions job summary containing:

- Before/after disk space measurements.
- Estimated or actual cleanup results.
- Largest cleanup categories.
- Individual operation timings.
- Total execution time.

How It Works

1. Environment detection: Detects the macOS version, architecture, Homebrew prefix and installed Xcode versions.
2. Cleanup planning: Resolves the Xcode selection before destructive operations begin.
3. Disk analysis: Optionally identifies the largest directories and cleanup targets.
4. Fast removal: Attempts to move selected targets into a temporary directory before deletion.
5. Background deletion: Uses up to three parallel deletion workers.
6. Protected Homebrew cleanup: Calculates protected dependencies before uninstalling selected packages and orphaned dependencies.
7. Final measurements: Waits for deletion workers to finish and measures available disk space again.

Requirements

- macOS environment.
- Passwordless "sudo".
- Node.js available in "PATH".

GitHub-hosted macOS runners provide these requirements by default.

FAQ

Can this action break my workflow?

Yes, if your workflow requires software that has been removed.

The defaults are intentionally aggressive. Use "dry-run: true" first, then disable individual cleanup categories or protect required components using "keep-paths" and "homebrew-keep".

Does this action require checkout?

No. GitHub Actions downloads the referenced action directly from its repository.

Does it remove Tailscale or Sunshine?

The action explicitly protects both, along with their protected Homebrew dependencies.

Why are final disk-space measurements displayed at the end?

Deletion operations can run in the background. Final measurements are collected after all deletion workers have completed.

Can I use it on Intel runners?

Yes. The action detects the architecture and adjusts its Homebrew prefix and browser-driver paths accordingly.

License

Licensed under the BSD 3-Clause License.

See "LICENSE" (LICENSE) for the full license text.

---

Maintained by "ktoya?" (https://github.com/Veniamin668).