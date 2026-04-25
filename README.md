# opencode-sync

**Git-based синхронизация сессий [opencode](https://opencode.ai) между устройствами.**

OpenCode хранит все сессии в локальной SQLite базе (`~/.local/share/opencode/opencode.db`). Если вы работаете на нескольких компьютерах — сессии не переносятся между ними. **opencode-sync** решает эту проблему: экспортирует сессии в JSON-файлы и синхронизирует их через приватный git-репозиторий.

## Как это работает

```
Компьютер A                         GitHub (private)                  Компьютер B
──────────                          ─────────────────                 ──────────
opencode session                    (JSON-файлы)                      opencode session
       │                                                                   │
       ▼                                                                   ▼
opencode-sync push                                               opencode-sync pull
       │                                                                   │
       ├─ Чтение сессий из SQLite                                        ├─ git pull
       ├─ opencode export → JSON                                         ├─ Поиск новых JSON
       ├─ git commit + push                                              └─ opencode import
       └─────────────────────►  ─────────────────►  ──────────────────────┘
```

Каждая сессия — отдельный JSON-файл: `sessions/{project_id}/{session_id}.json`. Это даёт:
- Гранулярные git-коммиты (один файл = одна сессия)
- Минимум merge-конфликтов (разные сессии = разные файлы)
- Читаемую историю изменений в git log

## Установка

### Требования

- [Node.js](https://nodejs.org) >= 18
- [git](https://git-scm.com)
- [opencode](https://opencode.ai) >= 1.14

### Установка из исходников

```bash
git clone https://github.com/your-username/opencode-sync.git
cd opencode-sync
npm install
npm run build

# Добавить в PATH (один из вариантов)
ln -s $(pwd)/dist/index.js ~/.local/bin/opencode-sync
```

### Установка через npm (глобально)

```bash
npm install -g https://github.com/your-username/opencode-sync.git
```

## Настройка

### 1. Создать приватный репозиторий на GitHub

Создайте **приватный** репозиторий, например `opencode-sessions`. Файлы сессий могут содержать фрагменты вашего кода, поэтому репозиторий **обязательно** должен быть приватным.

### 2. Инициализация

```bash
opencode-sync init \
  --repo git@github.com:your-username/opencode-sessions.git \
  --device macbook-pro
```

Параметры:
- `--repo` — URL репозитория (SSH или HTTPS)
- `--device` — имя устройства для коммит-сообщений (по умолчанию: hostname)
- `--path` — локальный путь к клону (по умолчанию: `~/.local/share/opencode-sync`)
- `--branch` — ветка (по умолчанию: `main`)

Конфигурация сохраняется в `~/.config/opencode/sync.json`.

## Использование

### Команды

```bash
opencode-sync push             # Экспортировать локальные сессии в git
opencode-sync pull             # Импортировать сессии с других устройств
opencode-sync sync             # Полный цикл: pull + push
opencode-sync status           # Показать текущую конфигурацию
```

Флаг `--dry-run` показывает что будет сделано без реальных изменений:

```bash
opencode-sync push --dry-run
opencode-sync pull --dry-run
```

### Типичный рабочий процесс

**Перед началом работы:**
```bash
opencode-sync pull
```

**После окончания работы:**
```bash
opencode-sync push
```

**Или полная синхронизация:**
```bash
opencode-sync sync
```

### Автоматизация через alias

Добавьте в `~/.bashrc` или `~/.zshrc`:

```bash
opencode() {
  opencode-sync pull 2>/dev/null
  command opencode "$@"
  opencode-sync push 2>/dev/null
}
```

Теперь при запуске `opencode` сессии автоматически подтягиваются перед работой и отправляются после выхода.

**Windows (PowerShell):**
```powershell
function opencode {
  opencode-sync pull 2>$null
  opencode.exe @args
  opencode-sync push 2>$null
}
```

### Переменные окружения

Все настройки можно задать через переменные окружения (приоритет выше файла конфигурации):

| Переменная | Описание |
|-----------|----------|
| `OPENCODE_SYNC_REPO` | URL git-репозитория |
| `OPENCODE_SYNC_DEVICE` | Имя устройства |
| `OPENCODE_SYNC_PATH` | Локальный путь к клону |
| `OPENCODE_BIN` | Путь к бинарнику opencode |
| `OPENCODE_DB` | Путь к SQLite базе opencode |

## Настройка на новом устройстве

1. Установите opencode-sync (см. [Установка](#установка))
2. Убедитесь что SSH-ключ добавлен в GitHub
3. Выполните инициализацию:
   ```bash
   opencode-sync init \
     --repo git@github.com:your-username/opencode-sessions.git \
     --device new-laptop
   ```
4. Импортируйте сессии:
   ```bash
   opencode-sync pull
   ```
5. Готово — все сессии с других устройств доступны локально

## Разрешение конфликтов

При одновременном изменении одной сессии на разных устройствах:

- **Разные сессии** — конфликтов нет (каждая сессия в отдельном файле)
- **Одна сессия** — стратегия last-write-wins: побеждает версия с более поздним `time_updated`

## Безопасность

- Репозиторий **обязательно** должен быть приватным — файлы сессий содержат текст ваших промптов, фрагменты кода и результаты работы инструментов
- Используется `execFileSync` (без shell) для предотвращения инъекций
- SQLite открывается в режиме READ-ONLY
- URL репозитория маскируется в логах
- Git-учётные данные используются через системные механизмы (ssh-agent, credential helper)

## Известные ограничения

- `opencode export` иногда возвращает битый JSON для очень больших сессий. Такие сессии пропускаются с предупреждением. Это баг opencode, не opencode-sync
- Сессии, которые в данный момент активны (вы в них работаете), могут не экспортироваться корректно
- При одновременной работе на нескольких устройствах изменения последней сессии перезатрут предыдущие (last-write-wins)

## Архитектура

```
opencode-sync/
├── src/
│   ├── config.ts     # Конфигурация (XDG-пути, env-переменные)
│   ├── session.ts    # Работа с сессиями (SQLite + opencode CLI)
│   ├── git.ts        # Git-операции (clone/pull/push/commit)
│   ├── push.ts       # Экспорт сессий → git
│   ├── pull.ts       # Git → импорт сессий
│   └── index.ts      # CLI (commander)
├── package.json
└── tsconfig.json
```

## Лицензия

MIT
