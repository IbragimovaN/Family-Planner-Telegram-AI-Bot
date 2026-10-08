# Этап 4: мобильная оболочка

Добавлены hash-навигация без перезагрузки, Telegram BackButton, темы Telegram с браузерным fallback, safe-area и стабильная высота WebView. Модальные подтверждения используют native dialog с удержанием фокуса, Escape и возвратом фокуса. Главная сохраняет три раздела; gap и padding `.home-sections` — 10px.

Локальная проверка: `npm run lint`, `npm run build`, `npm run build --prefix server`, `npm run typecheck --prefix server`, `npm test --prefix server`.

Для ручной приёмки запустить `npm run server-dev:auth --prefix server` и `npm run dev`. На ширинах 320, 375 и 430px проверить главную, настройки, формы и подтверждение удаления участника. Проверить Tab, Escape, возврат фокуса, системную светлую/тёмную тему и браузерную кнопку назад.

В реальном Telegram проверить BackButton на вложенных экранах, смену темы во время работы, поворот устройства, safe-area и клавиатуру. Локальные сборки не заменяют проверку Android/iOS. Использованы поля и CSS-переменные из https://core.telegram.org/bots/webapps.
