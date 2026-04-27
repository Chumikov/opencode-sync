# opencode-sync

**Git-based синхронизация сессий [opencode](https://opencode.ai) между вашими устройствами.**

## Требования

- Node.js >= 18
- git
- opencode >= 1.14

## Установка

```bash
npm install -g opencode-sync
```

Или из исходников:

```bash
git clone https://github.com/your-username/opencode-sync.git
cd opencode-sync
npm install && npm run build
npm link
```

## Настройка

### 1. Создать приватный репозиторий

Создайте **приватный** репозиторий на GitHub. Файлы сессий содержат промпты и фрагменты кода — репозиторий **обязательно** должен быть приватным.

### 2. Запустить setup

```bash
opencode-sync setup
```

Интерактивный мастер попросит:
- URL репозитория (SSH или HTTPS)
- Имя устройства (для коммит-сообщений)
- Ветку — спрашивается только если в репо больше одной
- Автоматически добавит функцию `opencode()` в `~/.bashrc` / `~/.zshrc`

Конфигурация сохраняется в `~/.config/opencode/sync.json`.

### 3. Перезапустить shell

```bash
source ~/.zshrc   # или ~/.bashrc
```

После этого `opencode` автоматически подтягивает сессии перед запуском и отправляет после завершения.

## Команды

```bash
opencode-sync setup              # Первичная настройка (TUI)
opencode-sync push               # Экспортировать сессии в git
opencode-sync pull               # Импортировать сессии из git
opencode-sync sync               # Полный цикл: pull + push
opencode-sync status             # Показать текущую конфигурацию
opencode-sync push --dry-run     # Показать что будет сделано, без изменений
```

## Переменные окружения

Приоритет выше файла конфигурации.

| Переменная | Описание |
|-----------|----------|
| `OPENCODE_SYNC_REPO` | URL git-репозитория |
| `OPENCODE_SYNC_DEVICE` | Имя устройства |
| `OPENCODE_SYNC_PATH` | Локальный путь к клону |
| `OPENCODE_BIN` | Путь к бинарнику opencode |
| `OPENCODE_DB` | Путь к SQLite базе opencode |

## Новое устройство

1. Установите opencode-sync
2. Добавьте SSH-ключ в GitHub
3. `opencode-sync setup`
4. Готово — все сессии с других устройств доступны

## Безопасность

- Репозиторий **обязательно** приватный
- `execFileSync` без shell — защита от инъекций
- SQLite открывается в режиме READ-ONLY
- URL маскируется в логах

## Лицензия

MIT
