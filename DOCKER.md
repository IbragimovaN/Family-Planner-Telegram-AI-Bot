# Запуск через Docker

Команды выполняются из `family-planner-bot`. Нужны работающий Docker Engine
с Linux-контейнерами и Docker Compose v2.

1. Создайте на сервере `server/.env` с переменной `OPENAI_API_KEY`.
   Файл уже исключён из Git, а `.dockerignore` исключает его из контекста сборки.
   Compose передаёт переменные при запуске; файл не попадает в образ.
2. Соберите и запустите приложение:

   ```sh
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 app
   ```

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
нужна отдельная миграция данных при остановленном приложении.

Nginx, Caddy и HTTPS в эту конфигурацию не включены.
