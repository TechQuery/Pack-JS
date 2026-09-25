# Pack-JS
Pack a JavaScript local project to a Portable Execution.

## Usage

```bash
pack-js --project /absolute/path/to/project
```

Options:
- `--project <dir>` source project directory (default current directory)
- `--node-version <version>` specific runtime version (for example `v22.18.0`)
- `--arch <x64|arm64|x86>` target runtime architecture
- `--output <name>` output bundle file name (default package name)
