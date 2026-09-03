# Windows + Docker E2E для `omp-skill-kit`

## Честный ответ по текущему состоянию

Нет: сейчас нельзя утверждать, что нативный плагин установлен и проверен от начала до конца внутри OMP.

Факты:

- OMP зарегистрировал пакет `omp-skill-kit@0.1.0` в своём реестре плагинов и создал каталог `C:\Users\stigm\.omp\plugins\node_modules\omp-skill-kit`.
- В установленном каталоге отсутствует `dist/`, хотя `package.json` указывает точку входа `./dist/extension.js`. Поэтому обычный загрузчик OMP не может загрузить расширение; обработчики `session_start`, `before_agent_start` и команды не регистрируются.
- Отдельная попытка загрузить собранный `E:\repos\omp-skill-kit\dist\extension.js` через OMP завершилась ошибкой `Failed to load pi_natives native addon`. Сборка втянула внутрь файла код хостового пакета `@oh-my-pi/pi-coding-agent` вместо использования экземпляра, уже загруженного OMP.
- Даже при прямом вызове фабрики расширения фоновый установщик не стартует корректно. `C:\Users\stigm\.omp\skill-kit\logs\installer.log` содержит `Error: unknown flag: --home`: `process.execPath` внутри OMP указывает на `omp.exe`, а запуску JavaScript через этот исполняемый файл не передан `BUN_BE_BUN=1`.
- `src/dashboard.ts` сейчас выводит пять строк с фазой, hash runtime и состоянием bridge. Он не запускает `mega-tron dashboard`, не поднимает web-интерфейс, не открывает браузер и не показывает историю маршрутов.
- Текущие Cucumber-сценарии читают исходники и проверяют регулярные выражения; `tests/extension.test.ts` вызывает фабрику с поддельным API. Это полезные статические и модульные проверки, но не E2E внутри OMP.
- Release workflow сначала собирает `dist`, но затем создаёт архив через `git archive`. Поскольку `dist/` исключён через `.gitignore`, официальный архив `v0.1.0` не содержит запускаемых файлов.

Следствие: имеющиеся зелёные unit/BDD/CI результаты не доказывают работоспособность установленного плагина. Dashboard отображается не так, как было задумано в утверждённом плане.

## Цель и критерий истины

Исправить перечисленные блокеры и получить воспроизводимое доказательство на Windows и в чистом Docker-контейнере. E2E считается пройденным только если тест запускает настоящий `omp` через его штатный загрузчик, устанавливает точный кандидат релиза, поднимает настоящий runtime mega-tron, проводит пользовательский запрос через `before_agent_start`, открывает настоящий upstream dashboard и проверяет очистку/повторную установку.

Прямой импорт `extension.js`, поддельный объект `{ on, registerCommand }`, вызов bridge отдельно от OMP или поиск текста в исходниках не засчитываются как E2E.

Docker используется как чистая Linux-среда без зависимостей. Он не заменяет нативную Windows-проверку путей, ACL, `.exe`, ConPTY и управления процессами.

## Базовые решения

1. **Точный кандидат релиза.** Все проверки получают один архив-кандидат и его SHA-256. Тот же набор байтов устанавливается на Windows, в Windows Sandbox и в Docker. Нельзя тестировать рабочую копию, а публиковать другой архив.
2. **Два поддерживаемых OMP.** Windows-матрица запускается на минимальном `17.3.7` и на последнем стабильном OMP, разрешённом на момент кандидата. Последняя версия и SHA-256 фиксируются в отчёте прогона; каждая версия лежит в отдельном каталоге и использует отдельный `OMP_PROFILE`.
3. **Изоляция.** Каждый сценарий получает новый профиль `OMP_PROFILE=skill-kit-e2e-<run-id>` и новый `OMP_SKILL_KIT_HOME`. Пользовательские `~/.omp`, `~/.omp/skill-kit`, ключи и работающие процессы не изменяются.
4. **Без внешнего провайдера.** Для полного пути OMP используется локальный OpenAI-compatible test server на `127.0.0.1`. Он не подменяет OMP: настоящий `omp` загружает плагин, формирует запрос модели, исполняет реальный `read skill://...` и завершает ход. Сервер лишь даёт детерминированный ответ без ключа и платного вызова.
5. **Чистый пользователь.** В целевой среде есть только официальный standalone `omp`, системные средства ОС и кандидат плагина. До bootstrap должны отсутствовать `python`, `python3`, `uv`, `mega-tron`, `node`, `npm`, `pnpm`, `bun` и `git` как отдельные команды.
6. **Доказательства без секретов.** Отчёты содержат версии, hashes, PID, порты, статусы и сокращённый hash запроса. Токен bridge, API key и сырой prompt туда не попадают.
7. **Релизная честность.** `v0.1.0` не объявляется исправленным задним числом. После зелёного полного прогона готовится новый кандидат, например `v0.1.1`; публикация блокируется любым обязательным красным сценарием.

## План работ

### 1. Сделать устанавливаемый артефакт действительно запускаемым

Изменить `package.json`, `.gitignore`, сборку и `.github/workflows/release.yml`:

- Внешне подключать `@oh-my-pi/pi-coding-agent` и его subpath-imports при сборке `dist/extension.js`, чтобы расширение использовало хостовый экземпляр OMP и не встраивало `pi_natives`.
- Собирать `dist/extension.js` и `dist/installer.js` до упаковки.
- Хранить готовый `dist` в Git, потому что штатная установка OMP из Git URL получает только tracked-файлы и не обязана запускать dev-сборку. CI повторно собирает файлы и отклоняет рассинхронизацию с tracked `dist`.
- Создавать release-архив из отдельного staging-каталога по явному allowlist из `package.json.files`, а не через `git archive HEAD`.
- Расширить `scripts/verify-release.mjs`: распаковать созданный архив в новый temp-каталог; проверить наличие, исполнимость/импортируемость точек входа, отсутствие `src`, `node_modules` и случайных файлов; проверить версию, runtime locks и SHA-256.
- Отдельно доказать два штатных пути: `omp plugin install` из публичного Git tag и `omp plugin link` из распакованного точного release-архива. В обоих случаях `omp plugin list --json` и `omp plugin doctor --json` должны показывать ровно одну включённую точку входа `dist/extension.js` без ошибок.

Блокирующая проверка: свежий OMP загружает установленный `dist/extension.js`; в логах нет `pi_natives`, `extension not found` и `Failed to load extension`.

### 2. Исправить нативный запуск и жизненный цикл процессов

Изменить `src/extension.ts`, `src/router-client.ts`, `src/shared/spawn.ts`, `src/installer.ts` и при необходимости `python/omp_skill_kit_bridge.py`:

- Запускать `dist/installer.js` через текущий standalone OMP/Bun с `BUN_BE_BUN=1`, сохраняя исходное окружение и добавляя только переменные плагина.
- Передавать одному и тому же runtime все изолированные `XDG_*`, model cache и `OMP_SKILL_KIT_HOME`; ни bootstrap, ни restart не должны писать в обычный домашний каталог пользователя.
- На отсутствующем, устаревшем или умершем `endpoint.json` запускать bridge под существующим install-lock, ждать публикации endpoint и успешного `ping` ограниченное время, затем делать не более одного повтора текущего route-вызова. Сейчас отсутствие endpoint немедленно даёт fail-open, а restart читает endpoint раньше, чем дочерний процесс успевает его записать.
- После 30-минутного idle shutdown следующий запрос должен разбудить bridge и маршрутизироваться, а не навсегда уходить в fail-open.
- Сохранять атомарные `state.json`, `active.json`, `endpoint.json` и отдельную запись владельца dashboard. PID принимается только вместе с runtime hash и успешной проверкой протокола/HTTP.
- Для `purge --confirm` сначала посылать штатный shutdown bridge и dashboard, ждать ограниченное время, затем завершать только процессы, чья запись владельца принадлежит этому `OMP_SKILL_KIT_HOME`. Лишь после этого удалять каталог. Это предотвращает `EBUSY/EPERM` на Windows и не затрагивает внешний mega-tron.
- Без `--confirm` purge ничего не меняет.

Команды регистрировать только под каноническими именами:

- `omp-skill-kit:status`
- `omp-skill-kit:setup`
- `omp-skill-kit:doctor`
- `omp-skill-kit:purge`
- `omp-skill-kit:dashboard`

Неназванные `status`, `setup`, `doctor`, `purge`, `dashboard` удалить: `setup` конфликтует со встроенной командой OMP, а утверждённый внешний контракт требует namespace пакета.

### 3. Реализовать настоящий mega-tron dashboard

Заменить текстовую заглушку в `src/dashboard.ts`; связать её с командами в `src/extension.ts` и обновить `skills/mega-tron-dashboard/SKILL.md`:

- Брать CLI из активного venv: `Scripts/mega-tron.exe` на Windows, `bin/mega-tron` на Unix.
- Запускать upstream `mega-tron dashboard --host 127.0.0.1 --port <port>`. Пользовательский host не принимать: upstream dashboard не имеет аутентификации.
- Сначала пробовать `7531`. Если `dashboard.json` принадлежит текущему runtime и `GET /api/overview` отвечает корректным JSON, переиспользовать процесс. Если порт занят чужим процессом, выбрать свободный loopback-порт и повторить запуск при гонке за порт.
- В TUI новый upstream-процесс запускается согласно утверждённому контракту с открытием браузера; при переиспользовании OMP открывает сохранённый URL. В print/CI режиме использовать `--no-open` и вернуть URL текстом.
- Записывать `dashboard.json` атомарно: schema version, runtime hash, PID, port, URL, startedAt. Не записывать токен bridge и сырой prompt.
- Проверять готовность не по факту наличия PID, а по `GET /api/overview`.
- Dashboard должен читать тот же `<OMP_SKILL_KIT_HOME>/xdg/data/mega-tron/store.db`, куда bridge пишет `routes` с `host="omp"`. После тестового запроса web-интерфейс и `/api/overview` должны отражать новый маршрут, выбранные имена, dynamic/manual K и расчёт экономии контекста.
- Проверить реальную страницу браузером: она загрузилась без ошибок, основные карточки и строка маршрута видимы, повторное открытие не создаёт второй сервер. Сохранить screenshot как доказательство ручного Windows-прогона.

### 4. Построить настоящий чёрный ящик для OMP

Добавить `tests/e2e/` и заменить смысл текущих Cucumber steps:

- `tests/e2e/support/openai-stub.ts` — loopback-only server для `openai-completions`, запускаемый самим standalone OMP с `BUN_BE_BUN=1`; отдельный Bun/Node пользователю не нужен.
- `tests/e2e/support/omp-process.ts` — запуск реального `omp.exe`/`omp`, ожидание фазы и команды, жёсткие таймауты, сбор stdout/stderr и гарантированное завершение дочерних процессов.
- `tests/e2e/support/evidence.ts` — единый JSON-отчёт без prompt и секретов.
- Изолированный `models.yml` с provider `omp-skill-kit-e2e`, `auth: none`, `api: openai-completions`, loopback `baseUrl` и одной тестовой моделью.
- Временный OMP-проект с тремя skill fixtures: уникальный допустимый навык, нерелевантный навык и запрещённый OMP-вызову навык. Описания подбираются так, чтобы настоящий mega-tron детерминированно ставил допустимый навык первым.

Локальный model server должен проверить входящий запрос в памяти и записать только receipt:

- в текущем system prompt есть names-only блок с ожидаемым именем;
- в блоке нет description, пути и тела `SKILL.md`;
- имя вставлено один раз;
- на нерелевантном следующем ходе старое имя отсутствует.

Первый ответ сервера вызывает реальный `read` по `skill://<fixture-name>`, второй завершает ход. Следующий запрос к server должен содержать результат `read`, что доказывает полный путь: пользовательский prompt → `before_agent_start` → mega-tron rank → names-only hint → решение модели → настоящий инструмент OMP → ответ.

Сохранить быстрый тест через `loadExtensions`/`ExtensionRunner` как промежуточную диагностику команд и событий, но не считать его заменой процесса `omp`.

### 5. Перевести BDD с проверки исходников на наблюдаемое поведение

BDD — сценарии поведения в формате Given/When/Then. Переписать `tests/bdd/steps/repository.steps.ts`, чтобы шаги запускали процессы, HTTP и проверяли файлы состояния/SQLite. Текстовые проверки исходников оставить только в unit/static suite.

Расширить существующие feature-файлы и добавить отдельные `dashboard.feature`, `windows-native.feature`, `docker-clean-user.feature`:

1. `release.feature`: точный архив, SHA-256, полный allowlist, fresh install, list/doctor, uninstall/reinstall.
2. `bootstrap.feature`: пустой home, отсутствие Python/uv/mega-tron, неблокирующий старт OMP, реальные фазы до `ready`, hash-locked download, warmup и первый rank.
3. `commands.feature`: только пять namespaced-команд; status/setup/doctor; purge-confirmation; отсутствие конфликтующих коротких имён.
4. `catalog.feature`: реальное обнаружение OMP skills, допустимость, collision precedence, атомарный snapshot, смена revision после изменения каталога.
5. `routing.feature`: ожидаемый top-1/top-3 настоящего Router, names-only текущего хода, реальный `read skill://...`, отсутствие stale hint на следующем ходе.
6. `fail-open.feature`: install unavailable, bridge timeout/crash, malformed response, stale token, idle shutdown и один restart. OMP-ход обязан завершаться без кандидатов, а не падать.
7. `security.feature`: bind только `127.0.0.1`, неверный token отклонён, нет prompt/token в plugin-owned state/log/SQLite/dashboard/report, небезопасные имена отбрасываются.
8. `dashboard.feature`: старт/reuse, занятый `7531`, `/api/overview`, route row, browser URL, остановка при purge.
9. `windows-native.feature`: пути с пробелами и кириллицей, `.exe`, file locks, два одновременных OMP-процесса и один общий model process.
10. `docker-clean-user.feature`: пользователь без root, пустой home, отсутствие внешних зависимостей, online bootstrap, offline reuse и recovery после первой сетевой ошибки.

Команды верхнего уровня:

- `pnpm test:e2e:loader`
- `pnpm test:e2e:windows`
- `pnpm test:e2e:windows-sandbox`
- `pnpm test:e2e:docker`
- `pnpm test:e2e:release`

`pnpm check` остаётся быстрым уровнем и не выдаётся за полный E2E; release workflow явно запускает обязательные E2E jobs.

### 6. Нативная Windows-матрица

#### Автоматическая Windows x64

На `windows-latest` и локальной Windows 11 Pro:

- скачать standalone OMP `17.3.7` и последний стабильный OMP, проверить официальные SHA-256;
- использовать отдельные профили и `%TEMP%\OMP Skill Kit Е2Е\<run-id>`;
- установить точный плагин-кандидат штатной командой;
- выполнить full route с локальной моделью, команды, restart, dashboard HTTP и purge/reinstall;
- проверить, что установленный плагин загружается из `C:\...\.omp\plugins\node_modules\omp-skill-kit\dist\extension.js`, а не из `E:\repos\omp-skill-kit`.

Hosted runner содержит много предустановленных программ, поэтому дополнительно запускать с минимальным PATH и проверять, что плагин не обращался к ним. Этот тест не заменяет действительно чистую машину.

#### Windows Sandbox: чистый пользователь без зависимостей

Добавить PowerShell-оркестратор и `.wsb`-конфигурацию:

- хост готовит read-only input с `omp.exe`, архивом кандидата, checksum и test scripts;
- Windows Sandbox стартует с новым пользователем и пустым профилем;
- до запуска проверяется отсутствие Python, uv, mega-tron, Node, npm, pnpm, Bun и Git;
- PowerShell выполняет штатную установку, online bootstrap, full route, dashboard HTTP, restart, purge и повторную установку;
- результат и логи копируются в отдельный mapped output; runtime пользователя с хоста не монтируется.

Windows Sandbox — основной clean-user x64 proof на этой рабочей станции. Если компонент Sandbox недоступен, прогон остаётся красным; маскировка PATH на обычном хосте не считается эквивалентом.

#### Windows 11 arm64

Запустить тот же пакет сценариев на настоящем Windows 11 arm64 runner. Он обязан подтвердить заявленный путь x64-эмуляции для uv/Python/mega-tron. x64 runner или Docker с `--platform=linux/arm64` не заменяют этот результат. Пока настоящий runner отсутствует или сценарий красный, arm64 нельзя считать подтверждённой целью нового релиза.

### 7. Docker BDD в чистой среде

Добавить `tests/e2e/docker/Dockerfile` и orchestration script. Базовый glibc-образ закрепить по digest, а не по плавающему tag. Финальный слой содержит только:

- CA certificates;
- standalone OMP;
- распакованный точный кандидат плагина;
- системный shell;
- непривилегированного пользователя с пустым home.

Не устанавливать Python, uv, mega-tron, Node, npm, pnpm, Bun или Git. Test helpers запускаются встроенным runtime standalone OMP через `BUN_BE_BUN=1`.

Обязательные Docker-сценарии:

1. **Fresh online:** пустые volumes профиля и plugin home; зависимости отсутствуют; OMP стартует без ожидания bootstrap; затем состояние проходит до `ready`, bridge отвечает, rank выбирает fixture.
2. **Fresh offline:** пустой home и `--network none`; installer переходит в `degraded`, а настоящий OMP-ход через loopback model server завершается без skill hint и без падения.
3. **Recovery:** тот же home после возврата сети; `/omp-skill-kit:setup` доводит runtime до `ready` без ручной установки зависимостей.
4. **Warm offline:** runtime сначала полностью подготовлен в именованном volume, затем новый контейнер стартует с `--network none`; bridge, rank и dashboard работают без скачиваний.
5. **Read-only/unwritable home:** ошибка понятна в status/doctor, OMP остаётся работоспособным, записи вне `OMP_SKILL_KIT_HOME` отсутствуют.
6. **Concurrency:** два контейнерных процесса OMP используют один runtime volume; install lock оставляет один runtime/model process и целое состояние.
7. **Purge/reinstall:** удаляются только plugin-owned данные; следующий fresh start воспроизводит bootstrap.

Запускать Docker BDD:

- на Docker Desktop этой Windows-машины в режиме Linux containers;
- на GitHub `ubuntu-latest` для независимого воспроизведения;
- для `linux/arm64` — на нативном arm64 runner. Эмуляция допустима как дополнительный smoke, но не как доказательство заявленной native arm64 поддержки.

### 8. Негативные сценарии и защита от ложного зелёного результата

Каждый сценарий должен иметь преднамеренно сломанную контрольную ветку, подтверждающую, что проверка действительно ловит дефект:

- удалить `dist/extension.js` — list/doctor или startup обязаны стать красными;
- собрать без external host package — loader обязан поймать `pi_natives`;
- убрать `BUN_BE_BUN` — bootstrap-сценарий обязан увидеть `unknown flag: --home`;
- убить bridge и удалить endpoint — первый последующий запрос должен восстановить его один раз;
- занять `7531` чужим HTTP-server — dashboard обязан выбрать другой loopback port и не убить чужой процесс;
- подменить token — RPC отклоняет запрос;
- изменить runtime artifact или lock digest — установка не активирует новый runtime и сохраняет предыдущий healthy runtime;
- вставить уникальный sentinel в prompt — рекурсивный scan plugin home, логов, SQLite, dashboard API и отчётов не находит sentinel. Собственная session JSONL OMP исключается из этого утверждения, поскольку OMP по контракту хранит пользовательский диалог; плагин не должен копировать его в свои данные.

Timeout каждого процесса ограничен; teardown выполняется и при падении шага. После suite не остаются `omp`, Python bridge, mega-tron dashboard, test model server, контейнеры, volumes или профили с секретами.

## Матрица допуска нового релиза

| Среда | OMP | Что обязательно доказать |
|---|---|---|
| Windows 11 x64, рабочая станция | 17.3.7 + latest stable | Нативная установка, команды, route/read, restart, реальный browser dashboard, purge/reinstall |
| GitHub `windows-latest` | 17.3.7 + latest stable | Воспроизводимый process E2E, минимальный PATH, release archive |
| Windows Sandbox x64 | latest stable | Чистый непривилегированный пользователь без Python/uv/Node/Git |
| Настоящий Windows 11 arm64 | 17.3.7 + latest stable | Заявленная x64-эмуляция runtime, полный route/dashboard/purge |
| Docker Desktop на Windows, Linux amd64 | latest stable Linux OMP | Чистый container, online/offline/recovery/concurrency |
| GitHub Linux amd64 container | latest stable Linux OMP | Независимый Docker BDD повтор того же архива |
| Нативный Linux arm64 container runner | latest stable Linux OMP | Полный arm64 container bootstrap/rank/dashboard |

Существующие macOS проверки сохраняются для заявленной общей platform matrix. Ни Windows, ни Docker не дают права удалить их из release gate.

## Изменяемые файлы

Основные:

- `package.json`, `.gitignore`
- `.github/workflows/release.yml`
- `scripts/verify-release.mjs`
- `src/extension.ts`
- `src/dashboard.ts`
- `src/router-client.ts`
- `src/shared/spawn.ts`
- `src/installer.ts`
- `python/omp_skill_kit_bridge.py`
- `skills/mega-tron-dashboard/SKILL.md`
- `audit-reports/omp-skill-kit-omp-contract.md`
- `tests/extension.test.ts`
- `tests/bdd/features/*.feature`
- `tests/bdd/steps/repository.steps.ts`

Новые test-only файлы:

- `tests/e2e/support/openai-stub.ts`
- `tests/e2e/support/omp-process.ts`
- `tests/e2e/support/evidence.ts`
- `tests/e2e/fixtures/...`
- `tests/e2e/docker/Dockerfile`
- `tests/e2e/docker/run.mjs`
- `tests/e2e/windows-sandbox/omp-skill-kit.wsb`
- `scripts/e2e/windows.ps1`
- `scripts/e2e/windows-sandbox.ps1`

Не добавлять новый пользовательский framework и не делать отдельный dashboard: используется web-интерфейс закреплённого upstream mega-tron.

## Итоговое доказательство

Перед публикацией собрать `reports/e2e/<run-id>/manifest.json` и связанные безопасные receipts:

- версия/commit плагина, hash архива, версии и hashes OMP;
- OS/arch и способ запуска;
- `plugin list`/`doctor` без ошибок;
- доказательство загрузки extension штатным OMP;
- переходы bootstrap до `ready`;
- bridge `ping`, ожидаемый top-1, факт names-only insertion и настоящий `read skill://fixture`;
- отсутствие stale hint на втором ходе;
- один общий bridge при двух OMP-процессах и восстановление после kill/idle;
- dashboard URL, loopback bind, `/api/overview`, route receipt и screenshot Windows-браузера;
- privacy scan;
- purge, uninstall, fresh reinstall и повторный route smoke;
- результаты Windows, Sandbox и Docker BDD без skipped обязательных сценариев.

Работа завершена только когда все обязательные строки матрицы зелёные. Если недоступен настоящий Windows arm64 или native Linux arm64 runner, отчёт прямо помечает соответствующую цель неподтверждённой, а release gate не выдаёт общий зелёный статус.