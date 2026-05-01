# opencode-sync

**Синхронизация сессий [OpenCode](https://opencode.ai) между вашими устройствами через приватный git-репозиторий.**

Начинайте сейссию работы с OpenCode с одного устройства, а продолжайте на другом. Даже еслиу вас одно устройство - просто синхронизируйте свои сессии, чтобы не потерять их. Opencode-sync экспортирует сессии OpenCode в JSON-файлы, хранит их в вашем приватном git-репозитории. Каждое устройство push'ит свои сессии и pull'ит с других.

## Возможности

- **Проектная область видимости** — push/pull синхронизируют только сессии текущего проекта (определяется по git-репозиторию)
- **Автосинхронизация** — shell-функция `opencode()` автоматически синхронизирует перед/после работы
- **Manifest-based удаление** — сессия удаляется когда все устройства её удалили
- **Deleted set** — удалённые локально сессии не возвращаются при pull
- **Защита первого запуска** — при первой синхронизации локальные сессии не удаляются
- **Preflight-проверки** — перед каждой операцией проверяется интернет, доступ к GitHub, наличие OpenCode
- **TUI-setup** — интерактивный мастер настройки с валидацией доступа к репозиторию
- **Нативные команды OpenCode** — все операции производятся через CLI OpenCode (`db`, `export`, `import`, `session delete`)

## Требования

| Зависимость | Минимальная версия |
|---|---|
| Node.js | >= 20 |
| git | любой |
| opencode | >= 1.14 |
| PAT-токен или SSH-ключ | для доступа к GitHub |

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

> [!IMPORTANT]
> Репозиторий рекомендую **обязательно** сделать приватным. Файлы ваших сессий в OpenCode могут содержать промпты, фрагменты кода и результаты работы.

1. Откройте [github.com/new](https://github.com/new)
2. Repository name — любое, например `opencode-sessions`
3. Visibility — **Private**
4. Не добавляйте README, .gitignore или license (пустой репозиторий)
5. Нажмите **Create repository**

### Шаг 2: Настроить доступ к GitHub

#### Вариант A: Personal Access Token (рекомендуется)

Токен достаточно создать один раз и использовать на всех устройствах — не нужно переносить SSH-ключи.

1. GitHub → Settings → Developer settings → Personal access tokens → **Generate new token (classic)**
2. Выберите scope `repo` (полный доступ к приватным репозиториям)
3. Скопируйте токен
4. URL для setup: `https://<TOKEN>@github.com/YOUR_USERNAME/<opencode-sessions>.git`

#### Вариант B: SSH-ключ

Потребуется настроить SSH-ключ на каждом устройстве.

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

URL для setup: `git@github.com:YOUR_USERNAME/<opencode-sessions>.git`

### Шаг 3: Запустить opencode-sync setup

```bash
opencode-sync setup
```

Интерактивный мастер:
1. **Проверяет OpenCode** — если не установлен, процесс дальше не пойдёт
2. **Запрашивает URL репозитория** — HTTPS с токеном или SSH
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

При setup автоматически определяется ваш shell и добавляется функция-обёртка для `OpenCode`.

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

При каждом запуске `OpenCode`:
1. **Pull** — подтягивает сессии с других устройств
2. **OpenCode** — запускается как обычно
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

### Область видимости (scope)

Push и pull фильтруют сессии по текущему проекту:

- **Из папки git-репозитория** → синхронизируются только сессии этого проекта. Project ID определяется как SHA-1 первого коммита git-репозитория.
- **Из папки без git** → синхронизируются только глобальные сессии (project_id = "global").
- **Первый push** (манифест устройства ещё не создан) → экспортируются **все** сессии без фильтрации.

Каждое устройство записывает в git **манифест** — список всех своих текущих сессий (`manifests/{device}.json`). Манифест всегда содержит полный список (не только scoped-сессии) — это нужно для корректного удаления.

### Push

1. Проверяет интернет и доступ к репозиторию (preflight)
2. Определяет scope по текущей директории (git root → первый коммит = project ID)
3. Получает все сессии через `opencode db`, фильтрует по scope
4. Экспортирует новые/изменённые сессии через `opencode export`
5. Сохраняет JSON-файлы в `sessions/{project_id}/{session_id}.json`
6. Сравнивает старый и новый манифест — удалённые id записываются в deleted set (`manifests/{device}-deleted.json`)
7. Записывает полный манифест устройства
8. Удаляет orphan-файлы в scoped-папке (сессии, которых нет ни в одном манифесте)
9. Push в git

### Pull

1. Проверяет интернет и доступ к репозиторию (preflight)
2. Pull из git
3. Сканирует только `sessions/{project_id}/` (или `sessions/global/`)
4. Пропускает сессии из deleted set — они не возвращаются после локального удаления
5. Импортирует новые/обновлённые сессии через `opencode import`
6. Если манифест устройства существует в репо — удаляет локальные сессии, которые удалены на всех устройствах (через `opencode session delete`) и добавляет их в deleted set
7. Если манифест устройства **не существует** (первая синхронизация) — шаг удаления пропускается

### Удаление сессий

1. Пользователь удаляет сессию на устройстве А
2. Push на А: id сессии исчезает из манифеста А, добавляется в deleted set А
3. Если id нет ни в одном манифесте — JSON-файл удаляется из git
4. Pull на Б: если id нет в global alive set — сессия удаляется из локальной БД opencode, id добавляется в deleted set Б
5. Сессия из deleted set не вернётся при следующем pull

Сессия удаляется с устройства только когда **все устройства** синхронизировались без неё.

## Переменные окружения

Приоритет выше файла конфигурации.

| Переменная | Описание |
|---|---|
| `OPENCODE_SYNC_REPO` | URL git-репозитория |
| `OPENCODE_SYNC_DEVICE` | Имя устройства |
| `OPENCODE_SYNC_PATH` | Локальный путь к клону |
| `OPENCODE_SYNC_BRANCH` | Ветка в sync-репозитории |
| `OPENCODE_BIN` | Путь к бинарнику opencode |
| `OPENCODE_DB` | Путь к SQLite БД opencode |

## Добавление нового устройства

1. Установите OpenCode и opencode-sync
2. `opencode-sync setup` — укажите тот же URL репозитория (токен одинаковый для всех устройств)
3. Готово — сессии автоматически синхронизируются при запуске opencode

## Безопасность

- Репозиторий **обязательно** приватный — файлы содержат промпты и фрагменты кода
- Все операции через нативные команды OpenCode CLI
- На Windows используется `cmd /c` для совместимости с `.cmd`/`.exe` shim'ами
- URL маскируется в логах и сообщениях об ошибках
- Preflight-проверки перед каждой операцией — понятные ошибки вместо сырого git stderr
- Ошибки синхронизации записываются в `~/.local/share/opencode-sync/sync.log`

## Структура данных

```
sync-repo/
├── sessions/
│   ├── global/
│   │   └── {session_id}.json         # глобальные сессии
│   ├── e89b5fab.../
│   │   └── {session_id}.json         # сессии проекта (project_id = SHA первого коммита)
│   └── 3129bae8.../
│       └── {session_id}.json         # сессии другого проекта
├── manifests/
│   ├── laptop.json                   # манифест "laptop" (все живые id)
│   ├── laptop-deleted.json           # deleted set "laptop" (удалённые id)
│   ├── desktop.json                  # манифест "desktop"
│   └── desktop-deleted.json          # deleted set "desktop"
└── .gitignore
```

---

<p align="center">
  <a href="https://t.me/chumikovsec">Chumikov Sec</a>
</p>
