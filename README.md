# opencode-sync

**Синхронизация сессий [OpenCode](https://opencode.ai) между вашими устройствами через приватный git-репозиторий.**

Экспортирует **все** сессии OpenCode (все проекты, включая global) в JSON-файлы, хранит их в вашем приватном git-репозитории. Каждое устройство push'ит свои сессии и pull'ит с других. Автосинхронизация встроена в shell — работает автоматически при каждом запуске OpenCode.

> [!IMPORTANT]
> Репозиторий рекомендую **обязательно** сделать приватным. Файлы ваших сессий в OpenCode могут содержать промпты, фрагменты кода и результаты работы.

## Возможности

- **Push/pull** — экспорт и импорт сессий через приватный git-репозиторий
- **Автосинхронизация** — shell-функция `opencode()` автоматически синхронизирует перед/после работы
- **Manifest-based удаление** — сессия удаляется когда все устройства её удалили
- **Preflight-проверки** — перед каждой операцией проверяется интернет, доступ к GitHub, наличие OpenCode
- **TUI-setup** — интерактивный мастер настройки с валидацией доступа к репозиторию
- **Нативные команды OpenCode** — все операции производятся через CLI OpenСode (`session list`, `export`, `import`, `session delete`)

## Требования

| Зависимость | Минимальная версия |
|---|---|
| Node.js | >= 20 |
| git | любой |
| opencode | >= 1.14 |
| SSH-ключ или PAT | для доступа к GitHub |

> **Почему opencode ≥ 1.14?** Начиная с версии 1.14, OpenCode хранит сессии в SQLite и поддерживает команду `opencode db`, которая необходима для экспорта всех сессий (а не только текущего проекта). При `opencode-sync setup` версия проверяется автоматически.

## Установка

Из npm:

```bash
npm install -g @chumikov/opencode-sync
```

Из исходников:

```bash
git clone https://github.com/Chumikov/opencode-sync.git
cd opencode-sync
npm install && npm run build
npm link
```

## Настройка

### Шаг 1: Создать приватный репозиторий на GitHub

1. Откройте [github.com/new](https://github.com/new)
2. Repository name — любое, например `opencode-sessions`
3. Visibility — **Private**
4. Не добавляйте README, .gitignore или license (пустой репозиторий)
5. Нажмите **Create repository**

Запомните URL репозитория — он понадобится на шаге 3. Формат:
- SSH (рекомендуется): `git@github.com:YOUR_USERNAME/opencode-sessions.git`
- HTTPS: `https://github.com/YOUR_USERNAME/opencode-sessions.git`

### Шаг 2: Настроить доступ к GitHub

#### Вариант A: SSH-ключ (рекомендуется)

Проверьте, настроен ли ключ:

```bash
ssh -T git@github.com
# Hi username! You've successfully authenticated — ключ работает
```

Если `Permission denied` — сгенерируйте и добавьте ключ:

```bash
# Генерация ключа
ssh-keygen -t ed25519 -C "your-email@example.com"

# Копирование публичного ключа
cat ~/.ssh/id_ed25519.pub

# Добавьте ключ на GitHub: Settings → SSH and GPG keys → New SSH key
# Вставьте содержимое ~/.ssh/id_ed25519.pub
```

#### Вариант B: HTTPS с Personal Access Token

Если предпочитаете HTTPS:

1. GitHub → Settings → Developer settings → Personal access tokens → **Generate new token (classic)**
2. Выберите scope `repo` (полный доступ к приватным репозиториям)
3. Скопируйте токен
4. URL с токеном: `https://<TOKEN>@github.com/YOUR_USERNAME/opencode-sessions.git`

### Шаг 3: Запустить opencode-sync setup

```bash
opencode-sync setup
```

Интерактивный мастер:
1. **Проверяет OpenCode** — если не установлен, подскажет как установить
2. **Запрашивает URL репозитория** — SSH или HTTPS
3. **Проверяет доступ** — если доступа нет, покажет конкретную ошибку и подсказку:
   - Нет интернета → проверьте подключение
   - Нет SSH-доступа → инструкция по генерации ключа
   - Репозиторий не найден → проверьте URL
   - Ошибка аутентификации → инструкция по токену/SSH
4. Предлагает **повторить** или **изменить URL** при ошибке
5. Запрашивает **имя устройства** — будет видно в коммитах (по умолчанию — hostname)
6. **Клонирует** репозиторий, определяет ветку
7. **Настраивает автосинхронизацию** — добавляет shell-функцию (bash, zsh, fish или PowerShell)

Конфигурация сохраняется в `~/.config/opencode/sync.json`.

### Шаг 4: Перезапустить shell

**Linux / macOS:**

```bash
source ~/.zshrc   # или source ~/.bashrc
```

**Windows (PowerShell):**

```powershell
. $PROFILE
```

**fish:**

```bash
# Функция загрузится автоматически при следующем запуске fish
```

## Автосинхронизация

При setup автоматически определяется ваш shell и добавляется функция-обёртка для `opencode`.

### Поддерживаемые shell

| Shell | Файл | ОС |
|---|---|---|
| bash | `~/.bashrc` или `~/.bash_profile` | Linux, macOS |
| zsh | `~/.zshrc` | macOS (default), Linux |
| fish | `~/.config/fish/functions/opencode.fish` | Linux, macOS |
| PowerShell | `Documents/PowerShell/Microsoft.PowerShell_profile.ps1` | Windows, Linux, macOS |

### Как это работает

**bash / zsh:**

```bash
opencode() {
  local _sync_log="$HOME/.local/share/opencode-sync/sync.log"
  mkdir -p "$(dirname "$_sync_log")" 2>/dev/null
  command opencode-sync pull 2>>"$_sync_log" || echo "opencode-sync: ошибка pull (подробности: $_sync_log)" >&2
  command opencode "$@"
  local exit_code=$?
  command opencode-sync push 2>>"$_sync_log" || echo "opencode-sync: ошибка push (подробности: $_sync_log)" >&2
  return $exit_code
}
```

При каждом запуске `opencode`:
1. **Pull** — подтягивает сессии с других устройств
2. **opencode** — запускается как обычно
3. **Push** — отправляет ваши сессии в репозиторий

Ошибки записываются в `~/.local/share/opencode-sync/sync.log`. При ошибке показывается краткое сообщение со ссылкой на лог-файл.

## Команды

```bash
opencode-sync setup              # Первичная настройка (TUI)
opencode-sync push               # Экспортировать сессии в git
opencode-sync pull               # Импортировать сессии из git
opencode-sync sync               # Полный цикл: pull + push
opencode-sync status             # Конфигурация + проверка доступа к remote
opencode-sync push --dry-run     # Показать что будет отправлено, без изменений
opencode-sync pull --dry-run     # Показать что будет импортировано, без изменений
```

## Как работает синхронизация

Все сессии экспортируются и импортируются с `project_id = "global"`, что делает их доступными из любой директории на любом устройстве. Оригинальная привязка к проекту сохраняется в поле `directory` внутри JSON.

Каждое устройство записывает в git **манифест** — список своих текущих сессий (`manifests/{device}.json`).

### Push

1. Проверяет интернет и доступ к репозиторию (preflight)
2. Получает **все** сессии через `opencode db` (все проекты, включая global)
3. Экспортирует новые/изменённые сессии через `opencode export`
4. Переопределяет `project_id` → `"global"` для кросс-платформенной совместимости
5. Сохраняет JSON-файлы в `sessions/global/{session_id}.json`
6. Обновляет манифест устройства
7. Удаляет orphan-файлы (сессии, которых нет ни в одном манифесте)
8. Push в git

### Pull

1. Проверяет интернет и доступ к репозиторию (preflight)
2. Pull из git
3. Читает глобальное множество сессий из всех манифестов
4. Импортирует новые/обновлённые сессии через `opencode import` (запускается из `$HOME`, чтобы сессии получали `project_id = "global"`)
5. Удаляет локальные сессии, которые были удалены на всех устройствах (через `opencode session delete`)

### Удаление сессий

Сессия удаляется с устройства только когда **все устройства** синхронизировались без неё. Пока хотя бы одно устройство не обновило манифест — сессия считается живой.

## Переменные окружения

Приоритет выше файла конфигурации.

| Переменная | Описание |
|---|---|
| `OPENCODE_SYNC_REPO` | URL git-репозитория |
| `OPENCODE_SYNC_DEVICE` | Имя устройства |
| `OPENCODE_SYNC_PATH` | Локальный путь к клону |
| `OPENCODE_BIN` | Путь к бинарнику opencode |

## Добавление нового устройства

1. Установите opencode и opencode-sync
2. Настройте SSH-ключ для доступа к тому же репозиторию
3. `opencode-sync setup` — укажите тот же URL репозитория
4. Готово — все сессии с других устройств автоматически импортируются

## Безопасность

- Репозиторий **обязательно** приватный — файлы содержат промпты и фрагменты кода
- Все операции через нативные команды opencode CLI — нет прямого доступа к базе данных
- На Windows используется `cmd /c` для совместимости с `.cmd`/`.exe` shim'ами (npm, Chocolatey, Scoop и др.)
- URL маскируется в логах и сообщениях об ошибках
- Preflight-проверки перед каждой операцией — понятные ошибки вместо сырого git stderr
- Ошибки синхронизации записываются в `~/.local/share/opencode-sync/sync.log`, при ошибке показывается краткое сообщение в терминале

## Структура данных

```
sync-repo/
├── sessions/
│   └── global/
│       └── {session_id}.json    # одна сессия = один файл (все с project_id = "global")
├── manifests/
│   ├── laptop.json              # манифест устройства "laptop"
│   └── desktop.json             # манифест устройства "desktop"
└── .gitignore
```

---

<p align="center">
  <a href="https://t.me/chumikovsec">Chumikov Sec</a>
</p>
