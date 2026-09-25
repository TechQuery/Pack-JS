# npm2exe
Pack a JavaScript local project to a portable executable bundle.

## Usage

```bash
# pack current project
npm2exe .
# pack other project
npm2exe path/to/project
```

Options:
- `--platform <linux|darwin|win|win32>` target platform (default current platform)
- `--arch <x64|arm64|arm|x86|ia32>` target runtime architecture (`arm` maps to `armv7l`, `ia32` maps to `x86`)
- `--node-version <version>` specific runtime version (for example `v22.18.0`)
- `--output <name>` output bundle file name (default package name; Windows appends `.exe`)
