# Запуск через Docker

Команды выполняются из `family-planner-bot`. Нужны работающий Docker Engine
с Linux-контейнерами и Docker Compose v2.

1. Создайте на сервере `server/.env` с `TELEGRAM_BOT_TOKEN`, `APP_ORIGIN` (HTTPS URL без пути) и `DEV_AUTH_ENABLED=false`. `OPENAI_API_KEY` нужен только для AI-разбора.
   Файл уже исключён из Git, а `.dockerignore` исключает его из контекста сборки.
   Compose передаёт переменные при запуске; файл не попадает в образ.
2. Соберите образ, подготовьте базу и запустите приложение. Первый переход на новую пустую БД:

   ```sh
   docker compose stop app
   docker compose build app
   docker compose run --rm --no-deps app npm run db:init
   docker compose up -d app
   docker compose ps
   docker compose logs --tail=100 app
   ```

   При последующих обновлениях вместо `db:init` выполните `db:migrate`:

   ```sh
   docker compose stop app
   docker compose build app
   docker compose run --rm --no-deps app npm run db:migrate
   docker compose up -d app
   ```

   `db:init` отказывается перезаписывать существующий файл. `db:migrate` сохраняет
   резервную копию перед новыми миграциями и не очищает данные. Не запускайте
   `up`, если подготовка БД завершилась ошибкой. После этапа 1 релиза на VPS нет:
   первое развёртывание предусмотрено после этапов 1–3.

Приложение доступно по HTTP на порту 3000. Проверка сервера:
`http://localhost:3000/api/health`. Frontend и API обслуживает один Express.
Compose фиксирует внутренний порт 3000 независимо от `PORT` в `server/.env`.
Для другого внешнего порта измените левую часть `3000:3000`.

В образе frontend находится в `/app/dist`, backend — в `/app/server/dist`.
Существующий путь Express `../../dist` корректно указывает на frontend.
Сборка использует существующие npm-скрипты и `npm ci` для обоих lock-файлов.
Корневые devDependencies нужны также для компиляции backend; в итоговом образе
остаются только production-зависимости backend и результаты обеих сборок.
Приложение запускается пользователем `node` и слушает `0.0.0.0`.

SQLite хранится в именованном томе `server-data`, подключённом к
`/app/server/data`. Данные сохраняются при `docker compose up -d --force-recreate`
и `docker compose down`. Команда `docker compose down -v` удаляет том и данные.
Существующая локальная база из `server/data` не переносится автоматически:
при первом запуске том содержит новую базу. Для переноса существующей базы
нужен отдельный перенос файлов при остановленном приложении. По решению пользователя
старые задачи не импортируются: `db:init` сохраняет копию старой базы в томе,
а новую создаёт по `/app/server/data/family-planner-v2.db`.

Compose задаёт `DATABASE_PATH=/app/server/data/family-planner-v2.db` и
`DATABASE_BACKUP_DIR=/app/server/data/backups`. Копии находятся в постоянном
томе вне файловой системы контейнера; их нужно также выгружать на отдельный
носитель. Ежедневное расписание и ротация относятся к этапу 10.
Инструкции проверки и восстановления: [docs/DATABASE.md](docs/DATABASE.md).

Nginx, Caddy и HTTPS в эту конфигурацию не включены.
