# opencode-sync

**Git-based session synchronization for [opencode](https://opencode.ai) across devices.**

OpenCode stores all sessions in a local SQLite database (`~/.local/share/opencode/opencode.db`). If you work on multiple computers, sessions don't transfer between them. **opencode-sync** solves this by exporting sessions to JSON files and syncing them through a private git repository.

## How it works

```
Computer A                          GitHub (private)                  Computer B
──────────                          ─────────────────                 ──────────
opencode session                    (JSON files)                      opencode session
       │                                                                   │
       ▼                                                                   ▼
opencode-sync push                                               opencode-sync pull
       │                                                                   │
       ├─ Read sessions from SQLite                                      ├─ git pull
       ├─ opencode export → JSON                                         ├─ Find new JSON files
       ├─ git commit + push                                              └─ opencode import
       └─────────────────────►  ─────────────────►  ──────────────────────┘
```

Each session is stored as a separate JSON file: `sessions/{project_id}/{session_id}.json`. This provides:
- Granular git commits (one file = one session)
- Minimal merge conflicts (different sessions = different files)
- Readable change history in git log

## Installation

### Requirements

- [Node.js](https://nodejs.org) >= 18
- [git](https://git-scm.com)
- [opencode](https://opencode.ai) >= 1.14

### Install from source

```bash
git clone https://github.com/your-username/opencode-sync.git
cd opencode-sync
npm install
npm run build

# Add to PATH (one option)
ln -s $(pwd)/dist/index.js ~/.local/bin/opencode-sync
```

### Install via npm (global)

```bash
npm install -g https://github.com/your-username/opencode-sync.git
```

## Configuration

### 1. Create a private repository on GitHub

Create a **private** repository, e.g. `opencode-sessions`. Session files may contain fragments of your code, so the repository **must** be private.

### 2. Initialize

```bash
opencode-sync init \
  --repo git@github.com:your-username/opencode-sessions.git \
  --device macbook-pro
```

Options:
- `--repo` — Repository URL (SSH or HTTPS)
- `--device` — Device name for commit messages (default: hostname)
- `--path` — Local path for the clone (default: `~/.local/share/opencode-sync`)
- `--branch` — Branch name (default: `main`)

Configuration is saved to `~/.config/opencode/sync.json`.

## Usage

### Commands

```bash
opencode-sync push             # Export local sessions to git
opencode-sync pull             # Import sessions from other devices
opencode-sync sync             # Full cycle: pull + push
opencode-sync status           # Show current configuration
```

Use `--dry-run` to preview changes without applying them:

```bash
opencode-sync push --dry-run
opencode-sync pull --dry-run
```

### Typical workflow

**Before starting work:**
```bash
opencode-sync pull
```

**After finishing work:**
```bash
opencode-sync push
```

**Or full sync:**
```bash
opencode-sync sync
```

### Automation via alias

Add to `~/.bashrc` or `~/.zshrc`:

```bash
opencode() {
  opencode-sync pull 2>/dev/null
  command opencode "$@"
  opencode-sync push 2>/dev/null
}
```

Now sessions are automatically pulled before opencode starts and pushed after it exits.

**Windows (PowerShell):**
```powershell
function opencode {
  opencode-sync pull 2>$null
  opencode.exe @args
  opencode-sync push 2>$null
}
```

### Environment variables

All settings can be overridden via environment variables (higher priority than config file):

| Variable | Description |
|----------|-------------|
| `OPENCODE_SYNC_REPO` | Git repository URL |
| `OPENCODE_SYNC_DEVICE` | Device name |
| `OPENCODE_SYNC_PATH` | Local path for the clone |
| `OPENCODE_BIN` | Path to opencode binary |
| `OPENCODE_DB` | Path to opencode SQLite database |

## Setting up a new device

1. Install opencode-sync (see [Installation](#installation))
2. Make sure your SSH key is added to GitHub
3. Run initialization:
   ```bash
   opencode-sync init \
     --repo git@github.com:your-username/opencode-sessions.git \
     --device new-laptop
   ```
4. Import sessions:
   ```bash
   opencode-sync pull
   ```
5. Done — all sessions from other devices are now available locally

## Conflict resolution

When the same session is modified on different devices simultaneously:

- **Different sessions** — no conflicts (each session is a separate file)
- **Same session** — last-write-wins strategy: the version with the later `time_updated` wins

## Security

- The repository **must** be private — session files contain your prompt text, code fragments, and tool results
- Uses `execFileSync` (no shell) to prevent injection attacks
- SQLite is opened in READ-ONLY mode
- Repository URLs are masked in logs
- Git credentials use system mechanisms (ssh-agent, credential helper)

## Known limitations

- `opencode export` sometimes returns broken JSON for very large sessions. These sessions are skipped with a warning. This is an opencode bug, not an opencode-sync issue
- Sessions that are currently active (you're working in them) may not export correctly
- When working on multiple devices simultaneously, the last session update overwrites previous ones (last-write-wins)

## Architecture

```
opencode-sync/
├── src/
│   ├── config.ts     # Configuration (XDG paths, env variables)
│   ├── session.ts    # Session handling (SQLite + opencode CLI)
│   ├── git.ts        # Git operations (clone/pull/push/commit)
│   ├── push.ts       # Export sessions → git
│   ├── pull.ts       # Git → import sessions
│   └── index.ts      # CLI (commander)
├── package.json
└── tsconfig.json
```

## License

MIT
