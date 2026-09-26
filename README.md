# NPM to EXE

Pack a JavaScript local project to a **portable executable**.

[![NPM Dependency](https://img.shields.io/librariesio/github/idea2app/npm2exe.svg)][1]
[![CI & CD](https://github.com/idea2app/npm2exe/actions/workflows/main.yml/badge.svg)][2]

[![NPM](https://nodei.co/npm/npm2exe.png?downloads=true&downloadRank=true&stars=true)][3]

## Usage

```bash
# build your project first
npm run build
# pack current project
npm2exe .
# pack other project
npm2exe path/to/project
```

Options:

- `--arch <x86|ia32|x64|arm|arm64>` target runtime architecture (`ia32` maps to `x86`, `arm` maps to `armv7l`)
- `--platform <linux|darwin|win|win32>` target platform (default current platform)
- `--node-version <version>` specific runtime version (for example `v22.18.0`)
- `--output <name>` output bundle file name (default package name; Windows appends `.exe`)

`npm2exe` reads your `package.json#bin`, installs only production dependencies into a temporary app directory, downloads a matching stock Node.js runtime, then wraps both into a self-extracting package.[9][10]

## Compared with Node SEA / pkg / nexe / caxa

| Tool | CPU / OS compatibility | Node.js version support | Entry file format / count | Monorepo support | Installed app structure | Native binary module compatibility | Config complexity | Executable wrapping form |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **npm2exe** | `linux`, `darwin`, `win`; `x64`, `arm64`, `armv7l`, plus Windows `x86`.[9][10] | Build with Node `>=22`; bundled runtime comes from `engines.node`, `--node-version`, or latest official release.[9][10] | Reads `package.json#bin`; supports one or many launchers.[10] | Explicitly handles `workspace:` dependencies by staging the workspace root first.[11] | Installs launchers into the user home/profile, with app files under `npm2exe-apps/<name>/app` and runtime under `npm2exe-apps/<name>/runtime`.[10] | Runs extracted files with a stock Node runtime, so native addons follow normal on-disk loading.[10] | Low: usually just project path plus optional CLI flags.[3][12] | Windows uses 7z SFX; Linux/macOS use `makeself` self-extractors.[10] |
| **Node SEA**[4] | Uses a stock `node` binary; cross-platform SEA generation is documented, with caveats for code cache and snapshots.[4] | SEA landed in Node `18.16+`; direct `node --build-sea` is documented in newer Node releases.[4] | Exactly one `main` script in `commonjs` or `module` format.[4] | No workspace-specific flow is documented; you package one prepared entry bundle at a time.[4] | No install tree by default; optional assets can live in a read-only VFS inside the executable.[4] | `.node` addons must be extracted to the real filesystem before loading.[4] | Medium: JSON config plus optional assets, VFS, snapshot, and code-cache settings.[4] | A stock Node executable with an injected SEA blob.[4] |
| **pkg**[5][6][7][8] | Targets Linux, macOS, Windows, Alpine, and static Linux variants; docs describe cross-OS and cross-arch targets.[6] | Current docs target Node 22 / 24 / latest, and require Node `>=22` on the build host.[5][6] | Usually one entry from `pkg .` or `pkg <entry>`, following `package.json#bin`.[5] | No dedicated workspace staging is documented; config centers on one package root plus optional asset rules.[7] | Standard mode uses an embedded snapshot filesystem; native addons are extracted to cache on disk.[8] | Native addons are supported, but `linuxstatic` excludes native bindings.[6][8] | Medium to high: auto-detection plus `package.json`, `.pkgrc`, or JS config hooks.[7] | Standard mode uses a patched runtime; SEA mode uses stock Node SEA.[5][8] |
| **nexe**[13] | Targets Windows, macOS, Linux, and Alpine via `platform-arch-version` target strings.[13] | The packager runs on Node `>=10`; target runtime version is chosen per build and may require prebuilt assets or source builds.[13] | One input entry file or stdin bundle, plus optional resource globs.[13] | No reviewed workspace-specific packaging flow is documented.[13] | Produces one executable with a virtual filesystem by default.[13] | Native binaries must be shipped next to the output binary.[13] | Medium to high: many CLI/API options plus optional patch/build pipelines.[13] | A single compiled executable built from downloaded or source-built Node bases.[13] |
| **caxa**[14] | Supports Windows, macOS, and Linux, but its docs explicitly say it is not a general cross-compilation solution for bundling the right Node runtime from another OS/arch.[14] | Current packager requires Node `>=22.15.0`.[14] | Runs a command array against an extracted payload; one input tree can emit multiple targets.[14] | No workspace-specific staging is documented, but it can package any prepared directory tree.[14] | Extracts the payload to a temp/cache directory, then starts the bundled Node runtime from there.[14] | README states native modules are supported because the app tree is extracted to disk first.[14] | Low to medium: one CLI command for the common case, more flags for custom stubs/compression/targets.[14] | A Rust self-extracting stub plus compressed payload, footer, and trailer.[14] |

The main trade-off is that **SEA / pkg / nexe** optimize harder for a single executable image, while **caxa / npm2exe** are more transparent about shipping and executing a real extracted app tree. That makes `npm2exe` especially practical for packages that already depend on regular Node.js filesystem behavior, production installs, and now `workspace:` mono repos.[4][8][10][11][13][14]

## Copyable GitHub Actions release workflow

Copy `/examples/release-on-tag.yml` into your own repository, then replace the package install/build steps and `asset_name` values to match your app.[15]

This example assumes your project already has a working `package.json#bin`, and that `npm run build` prepares the app before packaging:

```yaml
name: Release portable binaries

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  build:
    name: Build ${{ matrix.label }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            label: linux-x64
            asset_name: my-app-linux-x64
            asset_path: out/my-app-linux-x64
          - os: macos-latest
            label: macos
            asset_name: my-app-macos
            asset_path: out/my-app-macos
          - os: windows-latest
            label: windows-x64
            asset_name: my-app-windows-x64
            asset_path: out/my-app-windows-x64.exe

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build project
        run: npm run build

      - name: Package with npm2exe
        if: runner.os != 'Windows'
        run: npx npm2exe@latest . --output "${{ matrix.asset_name }}"

      - name: Package with npm2exe on Windows
        if: runner.os == 'Windows'
        shell: pwsh
        run: npx npm2exe@latest . --output "${{ matrix.asset_name }}"

      - uses: softprops/action-gh-release@v2
        with:
          files: ${{ matrix.asset_path }}
          generate_release_notes: true
```

Notes:

- Build on each native runner instead of cross-packaging from one host, because `npm2exe` currently uses different wrapping backends for Windows and POSIX targets.[10]
- Linux/macOS outputs are self-extracting shell archives; Windows output is a self-extracting `.exe`.[10]
- The release asset is the installer wrapper. The final launcher gets installed into the user home/profile when the asset is executed.[10]
- Code signing, notarization, and checksum publishing are intentionally left to the application repository.[4][10][14]

[1]: https://libraries.io/npm/npm2exe
[2]: https://github.com/idea2app/npm2exe/actions/workflows/main.yml
[3]: https://npm.im/npm2exe
[4]: https://nodejs.org/api/single-executable-applications.html
[5]: https://yao-pkg.github.io/pkg/guide/getting-started
[6]: https://yao-pkg.github.io/pkg/guide/targets
[7]: https://yao-pkg.github.io/pkg/guide/configuration
[8]: https://yao-pkg.github.io/pkg/guide/native-addons
[9]: https://github.com/idea2app/npm2exe/blob/master/package.json
[10]: https://github.com/idea2app/npm2exe/blob/master/src/workflow.ts
[11]: https://github.com/idea2app/npm2exe/blob/master/src/workspace.ts
[12]: https://github.com/idea2app/npm2exe/blob/master/src/index.tsx
[13]: https://github.com/nexe/nexe/blob/master/README.md
[14]: https://github.com/cdxgen/caxa/blob/main/README.md
[15]: https://github.com/idea2app/npm2exe/blob/master/examples/release-on-tag.yml
