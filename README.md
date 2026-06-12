# DOC → PDF Конвертер

Веб-приложение для точной конвертации Word документов (.doc, .docx, .odt, .rtf) в PDF.
Использует LibreOffice для максимальной точности: сохраняет картинки, таблицы, шрифты, отступы.

## Структура

```
docx2pdf/
├── app.py              # Flask backend
├── templates/
│   └── index.html      # Frontend UI
├── requirements.txt
└── README.md
```

## Локальный запуск

```bash
pip install -r requirements.txt
python app.py
# Открыть http://localhost:5050
```

## Деплой на Railway

1. Создать новый проект на railway.app
2. Подключить GitHub репозиторий
3. Railway автоматически установит зависимости и запустит через gunicorn

**Важно:** LibreOffice нужно установить на сервере:

```bash
# Dockerfile или nixpacks.toml
apt-get install -y libreoffice
```

### Dockerfile для Railway/Render

```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    libreoffice \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .
CMD ["gunicorn", "app:app", "--bind", "0.0.0.0:$PORT", "--timeout", "120"]
```

## Деплой на Render

1. Создать Web Service
2. Build Command: `apt-get install -y libreoffice && pip install -r requirements.txt`
3. Start Command: `gunicorn app:app --timeout 120`

## Переменные среды

Нет. Всё работает из коробки.

## Технологии

- **Backend:** Python + Flask
- **Конвертация:** LibreOffice (headless)
- **Frontend:** Vanilla HTML/CSS/JS (без зависимостей)
- **Поддерживаемые форматы:** .doc, .docx, .odt, .rtf
- **Лимит файла:** 50 МБ
- **Автоочистка:** файлы удаляются через 10 минут
