# opencode-sync

**Синхронизация сессий [opencode](https://opencode.ai) между вашими устройствами через git-репозиторий.**

Экспортирует сессии в JSON-файлы, хранит их в приватном git-репозитории. Каждое устройство push'ит свои сессии и pull'ит с других. Автосинхронизация встроена в shell — работает автоматически при каждом запуске opencode.

> [!IMPORTANT]
> Репозиторий **обязательно** должен быть приватным. Файлы сессий содержат промпты, фрагменты кода и результаты работы.

## Возможности

- **Push/pull** — экспорт и импорт сессий через приватный git-репозиторий
- **Автосинхронизация** — shell-функция `opencode()` автоматически синхронизирует перед/после работы
- **Manifest-based удаление** — сессия удаляется когда все устройства её удалили
- **Preflight-проверки** — перед каждой операцией проверяется интернет, доступ к GitHub, наличие opencode
- **TUI-setup** — интерактивный мастер настройки с валидацией доступа к репозиторию
- **Нативные команды opencode** — все операции через CLI opencode (`session list`, `export`, `import`, `session delete`)

## Требования

| Зависимость | Минимальная версия |
|---|---|
| Node.js | >= 18 |
| git | любой |
| opencode | >= 1.14 |
| SSH-ключ или PAT | для доступа к GitHub |

## Установка

Из npm (после публикации):

```bash
npm install -g opencode-sync
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
1. **Проверяет opencode** — если не установлен, подскажет как установить
2. **Запрашивает URL репозитория** — SSH или HTTPS
3. **Проверяет доступ** — если доступа нет, покажет конкретную ошибку и подсказку:
   - Нет интернета → проверьте подключение
   - Нет SSH-доступа → инструкция по генерации ключа
   - Репозиторий не найден → проверьте URL
   - Ошибка аутентификации → инструкция по токену/SSH
4. Предлагает **повторить** или **изменить URL** при ошибке
5. Запрашивает **имя устройства** — будет видно в коммитах (по умолчанию — hostname)
6. **Клонирует** репозиторий, определяет ветку
7. **Настраивает автосинхронизацию** — добавляет shell-функцию в `~/.bashrc` или `~/.zshrc`

Конфигурация сохраняется в `~/.config/opencode/sync.json`.

### Шаг 4: Перезапустить shell

```bash
source ~/.zshrc   # или source ~/.bashrc
```

## Автосинхронизация

При setup в ваш `~/.bashrc` или `~/.zshrc` добавляется shell-функция:

```bash
opencode() {
  command opencode-sync pull 2>/dev/null   # подтянуть сессии
  command opencode "$@"                     # запустить opencode
  local exit_code=$?
  command opencode-sync push 2>/dev/null   # отправить сессии
  return $exit_code
}
```

Что происходит при каждом запуске `opencode`:
1. **Pull** — подтягивает сессии с других устройств
2. **opencode** — запускается как обычно
3. **Push** — отправляет ваши сессии в репозиторий

Ошибки синхронизации подавляются (`2>/dev/null`) — opencode запускается в любом случае.

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

Каждое устройство записывает в git **манифест** — список своих текущих сессий (`manifests/{device}.json`).

### Push

1. Проверяет интернет и доступ к репозиторию (preflight)
2. Экспортирует новые/изменённые сессии через `opencode export`
3. Сохраняет JSON-файлы в `sessions/{project_id}/{session_id}.json`
4. Обновляет манифест устройства
5. Удаляет orphan-файлы (сессии, которых нет ни в одном манифесте)
6. Push в git

### Pull

1. Проверяет интернет и доступ к репозиторию (preflight)
2. Pull из git
3. Читает глобальное множество сессий из всех манифестов
4. Импортирует новые/обновлённые сессии через `opencode import`
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
- `execFileSync` без shell — защита от command injection
- URL маскируется в логах и сообщениях об ошибках
- Preflight-проверки перед каждой операцией — понятные ошибки вместо сырого git stderr

## Структура данных

```
sync-repo/
├── sessions/
│   └── {project_id}/
│       └── {session_id}.json    # одна сессия = один файл
├── manifests/
│   ├── laptop.json              # манифест устройства "laptop"
│   └── desktop.json             # манифест устройства "desktop"
└── .gitignore
```

---

<p align="center">
  <a href="https://t.me/chumikovsec">Chumikov Sec — Telegram</a>
</p>
