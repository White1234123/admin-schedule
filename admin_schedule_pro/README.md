# Общий график администраторов

Важно: этот проект использует Netlify Functions + Netlify Blobs для общего хранения данных.
**Не деплойте его через обычный Netlify Drop.** Подключите папку/репозиторий через GitHub к Netlify или используйте Netlify CLI.

## Самый простой способ
1. Создайте новый репозиторий на GitHub.
2. Загрузите в него все файлы этой папки, сохранив структуру `netlify/functions/schedule.mjs`.
3. В Netlify: Add new project → Import an existing project → GitHub.
4. Выберите этот репозиторий.
5. Build command оставьте пустым.
6. Publish directory: `.`
7. Functions directory: `netlify/functions`.
8. Deploy.

После деплоя на самом сайте сверху должно быть:
`🟢 Общий график сохранён на сервере`

Если написано `🔴 Нет связи с сервером графика`, значит Functions не задеплоились — данные сохраняться не будут.
