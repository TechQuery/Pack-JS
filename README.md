# NPM to EXE

Pack a JavaScript local project to a **portable executable**.

[![NPM Dependency](https://img.shields.io/librariesio/github/idea2app/npm2exe.svg)][2]
[![CI & CD](https://github.com/idea2app/npm2exe/actions/workflows/main.yml/badge.svg)][3]

[![NPM](https://nodei.co/npm/npm2exe.png?downloads=true&downloadRank=true&stars=true)][4]

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

[2]: https://libraries.io/npm/npm2exe
[3]: https://github.com/idea2app/npm2exe/actions/workflows/main.yml
[4]: https://npm.im/npm2exe
