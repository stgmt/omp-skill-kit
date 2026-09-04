# Ревью MEGA Tron + OMP + presentation-reels

Дата проверки: 2026-09-03

## Итог

Текущий `omp-skill-kit` действительно выполняет умную маршрутизацию skills в одном узком сценарии: реальный OMP 18.1.6 получает names-only подсказку с релевантным skill. Но текущая проверка не доказывает рабочий feedback loop, обновление качества по результатам использования или корректную аналитику для `presentation-reels`.

Главная ошибка предыдущего ревью: экономия токенов была поставлена на первое место. Для MEGA Tron это вторичная метрика. Основной продуктовый цикл:

```text
единый каталог skills
  -> семантический выбор для текущего запроса
  -> реальное использование skill
  -> оценка результата
  -> изменение будущего ранжирования
```

Сейчас в OMP-переходе реализованы первые два пункта и часть проверки names-only. Последние два пункта отсутствуют.

## Источники и версия

| Факт | Доказательство |
|---|---|
| Локальный OMP | `omp/18.1.6`, `C:\\Users\\stigm\\.local\\bin\\omp.exe` |
| Локальный package source | `node_modules/@oh-my-pi/pi-coding-agent`, версия `18.1.6` |
| Установленный mega-tron | `runtime-manifest.json:37-40`, commit `0ed290a1df1739af5cf4291d0ad8155afc7af16b` |
| GitHub main mega-tron | `https://api.github.com/repos/mega-edo/mega-tron/git/trees/main?recursive=1`, тот же tree SHA `0ed290a1df1739af5cf4291d0ad8155afc7af16b` |
| Продуктовая цель upstream | GitHub `README.md`: “one pool, one router, one feedback loop”; отдельные разделы `Unify`, `Optimize`, `Evolve`, `Observe` |
| Feedback upstream | GitHub `README.md`: Stop/AfterAgent ищет `<skill-used name=... verdict=... reason=...>` и различает `informed_use`, `silent_use`, `claimed_use` |

GitHub `main` не содержит снимка экрана самого dashboard. В репозитории есть графики benchmark feedback loop (`1_hit_rate.png`, `2_score_gap.png`), но не UI-снимок. Установленный dashboard — фактически dashboard из этого же upstream commit.

## Что доказано реальным OMP E2E

Команда:

```text
pnpm run test:e2e:windows
```

Результат: `PASSED`.

Evidence:

```text
reports/e2e/win-e2e-1788476346996/manifest.json
```

Доказано:

- использован реальный `omp/18.1.6`, а не прямой импорт расширения;
- plugin был установлен через `omp plugin link` в отдельный профиль;
- `omp plugin list --json` и `omp plugin doctor --json` прошли;
- реальный OMP `-p` получил names-only hint;
- релевантный fixture skill `e2e-valid-skill` был выбран;
- description/path/body не попали в системную подсказку;
- второй нерелевантный turn не получил старую подсказку;
- реальный bridge был поднят;
- реальный upstream dashboard был поднят и ответил на `/api/overview`;
- purge и очистка прошли.

Receipt первого turn:

```json
{
  "hintNames": ["e2e-valid-skill", "mega-tron-dashboard"],
  "hasDescription": false,
  "hasPath": false,
  "hasBody": false
}
```

### Что этот E2E не доказывает

- Это не тест skills из `presentation-reels`; используются синтетические `e2e-*` fixtures.
- Это не тест feedback loop: verdict не создаётся и не влияет на следующий rank.
- Это не тест dashboard data contract: проверяется только наличие объекта `/api/overview`.
- Не проверяется появление `omp` в `by_host`.
- Не проверяется `used > 0` после фактического использования skill.
- Не проверяются route latency, selected/empty/unavailable ratio, scores или причина выбора.
- Положительный turn получает также `mega-tron-dashboard`; тест проверяет только наличие целевого skill и не проверяет отсутствие лишних false-positive кандидатов.
- `tests/e2e/lifecycle.ts` проверяет только запуск фонового installer: lock, первый lifecycle event и ранний progress. Затем installer намеренно завершается. `ready`, полный bridge и реальный route этим тестом не доказаны.
- `tests/e2e/loader.ts` проверяет наличие `dist/extension.js`, link, list и doctor; extension handler через реальный turn там не проверяется.
- BDD `tests/bdd/features/routing.feature` использует mock bridge и не заменяет native Windows E2E.

Следовательно, прежняя формулировка “реальный E2E подтвердил всю маршрутизацию и dashboard” была слишком широкой. Правильная формулировка: native Windows E2E подтвердил один synthetic positive route и names-only границу.

## Live dashboard и пользовательские данные

Проверены UI всех трёх вкладок, HTTP API, SQLite и журналы.

SQLite:

```text
C:\\Users\\stigm\\.omp\\skill-kit\\xdg\\data\\mega-tron\\store.db
```

### Routes

- 24 rows;
- 5 session ids;
- 12 уникальных `query_hash`;
- 1 служебная запись `installer-fixture`;
- повторяющиеся query hash до 7 раз;
- все 24 записи имеют `picked_names_json = []`;
- все 24 имеют `k = 0`, `k_reason = "abs-floor"`, `total_tok = 0`;
- все записи имеют `host = "omp"`.

Extension log:

```text
C:\\Users\\stigm\\.omp\\skill-kit\\logs\\extension.log
```

Найдено:

- 5 `route.unavailable` с причиной `rpc timeout`;
- 4 `route.empty`;
- 0 `route.matched`.

Это не подтверждение экономии. Это подтверждение, что в наблюдавшихся пользовательских вызовах не было успешного выбора skill.

### Dashboard API

`/api/overview?days=30` возвращал:

```json
{
  "total": 100,
  "used": 0,
  "unused": 100,
  "by_host": {
    "codex": 0,
    "claude": 0,
    "gemini": 0,
    "hermes": 0,
    "agents": 0,
    "user": 0
  },
  "net_harmful_count": 0,
  "noise_verdict_count": 0,
  "orphan_count": 0,
  "unknown_host_count": 100,
  "hidden_skill_count": 0
}
```

`/api/verdicts` пустой. `/api/orphans` пустой.

В UI наблюдались расхождения одного и того же состояния:

- Context savings: 96 distinct skills;
- Skills overview: 101 skills;
- raw overview API: 100 skills;
- актуальный OMP catalog: 111 entries.

Это несколько разных источников каталога без общей версии снимка.

## Найденные дефекты

### BLOCKER-1: OMP не является отдельным dashboard host

`mega_tron/dashboard/api.py:34-40` задаёт `_DISPLAY_HOSTS` без `omp`:

```python
("codex", "claude", "gemini", "hermes", "agents", "user")
```

OMP bridge пишет `host="omp"` в `python/omp_skill_kit_bridge.py:193-194`. Dashboard отправляет эти события в unknown/other.

Последствие: live OMP маршрутизация не отображается как OMP-маршрутизация.

### BLOCKER-2: Dashboard не видит проектный OMP catalog как источник данных

`mega_tron/config.py:421-486` ищет стандартные пользовательские каталоги и plugin cache, но не получает текущий OMP `cwd` и не знает путь текущего project catalog.

При этом `src/extension.ts:675-683` каждый turn строит каталог из `loadEligibleCatalog(ctx.cwd)` и публикует его в:

```text
<OMP_SKILL_KIT_HOME>/catalogs/<revision>/catalog.json
```

Последствие: OMP rank работает с одним каталогом, а dashboard считает другой.

### BLOCKER-3: Нет OMP feedback loop

`src/extension.ts:647-737` регистрирует только `session_start` и `before_agent_start`. Код:

- выбирает skill names;
- добавляет names-only prompt hint;
- пишет `route.matched`, `route.empty`, `route.unavailable`, `route.failed`.

В extension нет обработки фактического использования skill, `<skill-used>` verdict, session-end evaluation или записи `HELPFUL/HARMFUL/NEUTRAL`.

Поэтому реальный E2E мог показать `e2e-valid-skill`, но dashboard всё равно показывает `used=0`: dashboard понимает usage через verdict data, а OMP adapter verdict data не создаёт.

### HIGH-1: `0 tok` является неверной интерпретацией OMP результата

`mega_tron/hosts/_route_log.py:51-63` считает:

```python
total_tok = sum(getattr(r.skill, "desc_tok", 0) for r in ranked)
```

Но OMP extension вставляет только имена skills (`src/extension.ts:720-727`). Описания не вставляются.

Даже если route начнёт выбирать skills, dashboard будет считать tokens описаний, а не размер фактического OMP hint.

### HIGH-2: Нет разделения no-match, timeout и реальной экономии

Все 24 route rows дают нулевой `total_tok`. Dashboard не показывает:

- сколько было timeout;
- сколько было no-match;
- сколько было selected;
- сколько было fail-open;
- сколько занял rank;
- какой был top score.

### HIGH-3: Тест проверяет положительный synthetic route, но не качество выбора

Receipt E2E:

```json
["e2e-valid-skill", "mega-tron-dashboard"]
```

Тест проверяет только наличие `e2e-valid-skill`. Не проверяется, что `mega-tron-dashboard` не является лишним кандидатом. Нет проверки precision, false positives, score threshold или dynamic-K reason.

### MEDIUM-1: Invocation count загрязнён дублями и fixture

24 rows не равны 24 независимым пользовательским turn. Нет request id / dedup key / source classification.

### MEDIUM-2: Token estimates неточны

`dashboard.log` и `bridge.log` предупреждают: `tiktoken` не установлен, используется оценка `chars//4`.

### MEDIUM-3: Dashboard — это verdict review, а не routing observability

Вкладка Human-in-the-loop позволяет вручную редактировать verdicts и удалять skills, но не отвечает на вопросы:

- почему skill был выбран;
- почему skill не был выбран;
- сколько было timeout;
- что происходило с конкретным reels run;
- был ли skill реально загружен моделью;
- повлиял ли skill на принятие видео.

## presentation-reels: что уже есть и что реально нужно развивать

В локальном проекте есть шесть project-local skills:

```text
developer-rules
incident-search
incident-visual-report
regression-node
universal-reel-philosophy
video-production-patterns
```

В текущем OMP catalog уже есть специализированные reels skills для:

- проверки готовности и доставки;
- typography и transitions;
- source-grounded visual relevance;
- reuse/recompose вместо полного запуска;
- provider и budget контроля;
- identity lock и submission-unknown расследований.

Пока нельзя честно сказать, какой из них “нужно добавить” или “какой потерян”: система не записывает полную цепочку route → actual use → result.

Нужны следующие проектные измерения:

```text
project = presentation-reels
run_id
candidate_id
pipeline_phase
skill_name
route_status
score
k_reason
latency_ms
catalog_revision
actual_use
issue_type
acceptance_status
```

Сырые пользовательские prompts хранить не нужно; достаточно hash и безопасных имён skills.

Минимальные reels-срезы:

| Срез | Что измерять |
|---|---|
| Reuse | Доля случаев, когда `presentation-reels-reuse-first-router` выбрал повторное использование вместо полного запуска |
| Delivery | Сколько раз `presentation-reels-delivery-review-gate` заблокировал неподтверждённый результат и сколько результатов прошло |
| Typography | Сколько дефектов нашёл `reel-typography-audit`, сколько исправлено и сколько повторилось |
| Transitions | Какие стыки чаще всего требуют `presentation-reels-transition-speed-audit` |
| Budget | Разница между расчётным и фактическим расходом через `reel-candidate-budget-audit` |
| Evidence | Сколько инцидентов закрыто с правильной связью run/candidate через `incident-evidence-identity-lock` |

Это не повод немедленно добавлять новые skills. Сначала нужно сделать существующие skills измеримыми.

## Рекомендуемый порядок исправления

1. **OMP catalog adapter для dashboard.** Dashboard должен принимать `omp`, `cwd/project label`, catalog revision и считать именно OMP catalog.
2. **Корректная запись route event.** Добавить `request_id`, `route_status`, `selected_count`, `k_reason`, `latency_ms`, top score и catalog revision; raw prompt не записывать.
3. **Исправить metric.** Для OMP считать фактический names-only hint. `empty` и `unavailable` отображать как `N/A`, а не как экономию `0 tok`.
4. **Сделать production-like E2E.** Использовать копию реальных `presentation-reels/.omp/skills`, два реальных OMP turn, edit skill между turn’ами и проверить новую catalog revision/новое решение.
5. **Добавить feedback collector.** Сначала ground exact OMP 18.1.6 event contract; затем связать фактическое использование skill с результатом turn/session и verdict. Нельзя копировать Stop hook mega-tron без проверки OMP API.
6. **Добавить Reels Lens в dashboard.** Показывать route health, selected/missed skills, actual use, issue/acceptance and run/candidate slices.
7. **Только после этого настраивать пороги.** Нельзя просто понижать `abs-floor`: сначала нужны score distribution и контроль false positives.

## Acceptance для следующей реализации

- Реальный OMP turn в копии `presentation-reels` создаёт событие с `host=omp`.
- Dashboard показывает OMP отдельно, без `unknown_host_count` для OMP catalog.
- Релевантный reels skill появляется в selected list с score, latency и catalog revision.
- Нерелевантный skill не считается успешным только потому, что он был в top-K.
- Edit `SKILL.md` между двумя turn’ами создаёт новую revision и влияет на второй rank.
- Timeout, no-match и selected отображаются раздельно.
- Dashboard не показывает `0 tok` как положительную экономию при пустом или недоступном rank.
- После фактического использования skill появляется actual-use/verdict event.
- Verdict меняет следующий rank или явно фиксируется как неактивный feedback path.
- Все E2E проходят через реальный OMP loader и реальные turn’ы; mock bridge остаётся только unit/BDD тестом.

## Status review

**PASS:** реальный OMP loader, plugin link, real OMP turn, names-only prompt boundary, stale-hint cleanup, bridge startup, dashboard HTTP startup, purge cleanup.

**FAIL:** production `presentation-reels` route proof, OMP dashboard host mapping, project catalog visibility in dashboard, actual-use tracking, verdict feedback loop, dashboard route health analytics, valid token-cost measurement.

**Не утверждать:** что текущий green Windows E2E доказывает, что smart router работает на реальных reels skills; что `0 tok` означает успешную экономию; что dashboard показывает фактическое использование skills.
