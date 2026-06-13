import formidable from 'formidable';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.CLOUDCONVERT_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API ключ не настроен на сервере' });
  }

  // Parse uploaded file
  const form = formidable({ maxFileSize: 50 * 1024 * 1024 });
  let fields, files;
  try {
    [fields, files] = await form.parse(req);
  } catch (err) {
    return res.status(400).json({ error: 'Ошибка чтения файла: ' + err.message });
  }

  const file = Array.isArray(files.file) ? files.file[0] : files.file;
  if (!file) {
    return res.status(400).json({ error: 'Файл не найден' });
  }

  const originalName = file.originalFilename || 'document.docx';
  const ext = originalName.split('.').pop().toLowerCase();
  const allowed = ['doc', 'docx', 'odt', 'rtf'];
  if (!allowed.includes(ext)) {
    return res.status(400).json({ error: 'Поддерживаются только .doc, .docx, .odt, .rtf' });
  }

  const BASE = 'https://api.cloudconvert.com/v2';
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Create job
    const jobRes = await fetch(`${BASE}/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tasks: {
          'upload-file': {
            operation: 'import/upload',
          },
          'convert-file': {
            operation: 'convert',
            input: 'upload-file',
            input_format: ext,
            output_format: 'pdf',
            engine: 'libreoffice',
          },
          'export-file': {
            operation: 'export/url',
            input: 'convert-file',
          },
        },
      }),
    });

    const job = await jobRes.json();
    if (!jobRes.ok) {
      throw new Error(job.message || 'Ошибка создания задачи');
    }

    // 2. Upload file
    const uploadTask = job.data.tasks.find(t => t.name === 'upload-file');
    const uploadUrl = uploadTask.result.form.url;
    const uploadParams = uploadTask.result.form.parameters;

    const formData = new FormData();
    for (const [key, val] of Object.entries(uploadParams)) {
      formData.append(key, val);
    }
    formData.append('file', fs.createReadStream(file.filepath), originalName);

    const uploadRes = await fetch(uploadUrl, { method: 'POST', body: formData });
    if (!uploadRes.ok) {
      throw new Error('Ошибка загрузки файла на CloudConvert');
    }

    // 3. Wait for job to finish (poll)
    const jobId = job.data.id;
    let resultUrl = null;
    let pdfName = originalName.replace(/\.[^.]+$/, '') + '.pdf';

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const statusRes = await fetch(`${BASE}/jobs/${jobId}`, { headers });
      const status = await statusRes.json();
      const jobData = status.data;

      if (jobData.status === 'finished') {
        const exportTask = jobData.tasks.find(t => t.name === 'export-file');
        resultUrl = exportTask.result.files[0].url;
        pdfName = exportTask.result.files[0].filename || pdfName;
        break;
      }

      if (jobData.status === 'error') {
        const errTask = jobData.tasks.find(t => t.status === 'error');
        throw new Error(errTask?.message || 'Ошибка конвертации');
      }
    }

    if (!resultUrl) {
      throw new Error('Таймаут: конвертация заняла слишком много времени');
    }

    // 4. Download PDF and stream to client
    const pdfRes = await fetch(resultUrl);
    if (!pdfRes.ok) {
      throw new Error('Не удалось скачать PDF с CloudConvert');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${pdfName}"`);
    pdfRes.body.pipe(res);

  } catch (err) {
    console.error('CloudConvert error:', err);
    res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  }
}
