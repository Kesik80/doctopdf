FROM python:3.11-slim

# Install LibreOffice for accurate document conversion
RUN apt-get update && apt-get install -y \
    libreoffice \
    libreoffice-writer \
    fonts-liberation \
    fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create temp directories
RUN mkdir -p /tmp/docx2pdf_uploads /tmp/docx2pdf_outputs

# Use gunicorn for production, with 120s timeout for large files
CMD ["gunicorn", "app:app", \
     "--bind", "0.0.0.0:8080", \
     "--workers", "2", \
     "--timeout", "120", \
     "--max-requests", "1000", \
     "--max-requests-jitter", "100"]
