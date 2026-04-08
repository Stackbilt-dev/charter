# WSL2 + Windows Filesystem

Charter works well under WSL2, but projects that live on the Windows filesystem (`/mnt/c/...`) require awareness of a few cross-filesystem differences. This guide covers installation, path considerations, and common gotchas.

## Install

### Linux-native path (recommended)

For best performance and fewest surprises, keep your project on a Linux-native path:

```bash
mkdir -p ~/projects && cd ~/projects
git clone <your-repo>
cd <your-repo>
pnpm add -Dw @stackbilt/cli   # works without extra flags
```

Linux-native paths avoid the NTFS translation layer entirely. File watches (`wrangler dev`, `vitest --watch`) are faster, and atomic renames work correctly.

### Windows filesystem path (`/mnt/c/...`)

If your project must stay on the Windows filesystem (shared with Windows-native editors, corporate policies, etc.), pnpm installs may fail with:

```
ERR_PNPM_EACCES  EACCES: permission denied, rename
  '...node_modules/.pnpm/..._tmp_...' -> '...'
```

This is a known WSL2/NTFS limitation with atomic renames. Use `--force` to work around it:

```bash
cd /mnt/c/Users/<you>/projects/<repo>
pnpm add -Dw @stackbilt/cli --force
```

npm and yarn are not affected by this issue:

```bash
npm install --save-dev @stackbilt/cli
```

## Path considerations

WSL2 exposes the Windows filesystem under `/mnt/c/`, `/mnt/d/`, etc. Charter resolves paths relative to the working directory, so everything works transparently as long as you stay consistent.

| Context | Example path |
|---------|-------------|
| Linux-native | `~/projects/my-app/.ai/core.adf` |
| Windows mount | `/mnt/c/Users/you/projects/my-app/.ai/core.adf` |
| Windows (from Explorer) | `C:\Users\you\projects\my-app\.ai\core.adf` |

A few things to keep in mind:

- **Stay on one side.** Do not mix `/mnt/c/` paths and `C:\` paths in the same workflow. Charter and git both expect POSIX paths inside WSL2.
- **Symlinks across filesystems.** Symlinks from a Linux-native path into `/mnt/c/` (or vice versa) can behave unexpectedly. Keep `.ai/`, `.charter/`, and `node_modules/` on the same filesystem as the project root.
- **VS Code Remote - WSL.** When using VS Code with the WSL extension, the integrated terminal runs inside WSL2 and sees POSIX paths. This is the expected setup for Charter.

## Common gotchas

### Line endings

Windows uses `\r\n`; Linux uses `\n`. Git's `core.autocrlf` setting controls conversion at checkout. ADF files should use `\n` (LF) to avoid parse issues.

Recommended `.gitattributes` entry:

```gitattributes
*.adf text eol=lf
```

If ADF files already have `\r\n` endings, fix them once:

```bash
# Inside WSL2
find .ai -name '*.adf' -exec dos2unix {} +
git add .ai/
git commit -m "fix: normalize ADF line endings to LF"
```

### File permissions

NTFS does not support Unix permission bits. Files on `/mnt/c/` may appear with `0777` permissions, and `chmod` has no effect. This is cosmetic -- Charter does not check file permissions -- but it can produce noisy `git diff` output.

To suppress permission noise in git:

```bash
git config core.fileMode false
```

### Performance

File I/O on `/mnt/c/` is significantly slower than on the Linux-native filesystem due to the 9P protocol translation layer. Operations that touch many files (`pnpm install`, `charter drift`, `vitest`) will be noticeably faster on a Linux-native path.

If you need the project on the Windows side for other tools, consider keeping a Linux-native working copy and syncing with git:

```bash
# Clone to Linux-native path for development
git clone /mnt/c/Users/you/projects/my-app ~/projects/my-app
cd ~/projects/my-app
pnpm install
npx charter doctor
```

## Verify the setup

After installing, confirm Charter is working:

```bash
npx charter doctor
npx charter --version
```

If `doctor` reports all checks passing, you are good to go. See [Getting Started](./getting-started.md) for next steps.
