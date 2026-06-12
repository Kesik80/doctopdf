import os
import uuid
import subprocess
import shutil
import threading
import time
from flask import Flask, request, send_file, jsonify, render_template
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB
app.config['UPLOAD_FOLDER'] = '/tmp/docx2pdf_uploads'
app.config['OUTPUT_FOLDER'] = '/tmp/docx2pdf_outputs'

ALLOWED_EXTENSIONS = {'doc', 'docx', 'odt', 'rtf'}
SOFFICE = '/mnt/skills/public/docx/scripts/office/soffice.py'

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
os.makedirs(app.config['OUTPUT_FOLDER'], exist_ok=True)


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def cleanup_old_files():
    """Delete files older than 10 minutes"""
    while True:
        time.sleep(60)
        now = time.time()
        for folder in [app.config['UPLOAD_FOLDER'], app.config['OUTPUT_FOLDER']]:
            for fname in os.listdir(folder):
                fpath = os.path.join(folder, fname)
                try:
                    if os.path.getmtime(fpath) < now - 600:
                        if os.path.isdir(fpath):
                            shutil.rmtree(fpath)
                        else:
                            os.remove(fpath)
                except Exception:
                    pass


# Start cleanup thread
threading.Thread(target=cleanup_old_files, daemon=True).start()


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/convert', methods=['POST'])
def convert():
    if 'file' not in request.files:
        return jsonify({'error': 'Файл не найден'}), 400

    file = request.files['file']

    if file.filename == '':
        return jsonify({'error': 'Файл не выбран'}), 400

    if not allowed_file(file.filename):
        return jsonify({'error': 'Поддерживаются только .doc, .docx, .odt, .rtf файлы'}), 400

    job_id = str(uuid.uuid4())
    job_upload_dir = os.path.join(app.config['UPLOAD_FOLDER'], job_id)
    job_output_dir = os.path.join(app.config['OUTPUT_FOLDER'], job_id)
    os.makedirs(job_upload_dir, exist_ok=True)
    os.makedirs(job_output_dir, exist_ok=True)

    original_name = secure_filename(file.filename)
    input_path = os.path.join(job_upload_dir, original_name)
    file.save(input_path)

    # Convert .doc → .docx first if needed
    ext = original_name.rsplit('.', 1)[1].lower()
    if ext == 'doc':
        result = subprocess.run(
            ['python3', SOFFICE, '--headless', '--convert-to', 'docx',
             '--outdir', job_upload_dir, input_path],
            capture_output=True, text=True, timeout=60
        )
        docx_name = original_name.rsplit('.', 1)[0] + '.docx'
        docx_path = os.path.join(job_upload_dir, docx_name)
        if os.path.exists(docx_path):
            input_path = docx_path
        elif result.returncode != 0:
            return jsonify({'error': f'Ошибка конвертации .doc: {result.stderr[:200]}'}), 500

    # Convert to PDF
    result = subprocess.run(
        ['python3', SOFFICE, '--headless', '--convert-to', 'pdf',
         '--outdir', job_output_dir, input_path],
        capture_output=True, text=True, timeout=120
    )

    if result.returncode != 0:
        return jsonify({'error': f'Ошибка конвертации: {result.stderr[:300]}'}), 500

    # Find the output PDF
    pdf_files = [f for f in os.listdir(job_output_dir) if f.endswith('.pdf')]
    if not pdf_files:
        return jsonify({'error': 'PDF не был создан'}), 500

    pdf_path = os.path.join(job_output_dir, pdf_files[0])
    pdf_name = original_name.rsplit('.', 1)[0] + '.pdf'

    return send_file(
        pdf_path,
        as_attachment=True,
        download_name=pdf_name,
        mimetype='application/pdf'
    )


if __name__ == '__main__':
    app.run(debug=True, port=5050)
