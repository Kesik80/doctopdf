import formidable from 'formidable';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

export const config = { api: { bodyParser: false } };

const BASE = 'https://api.cloudconvert.com/v2';

function ccFetch(path, opts = {}) {
  const apiKey = process.env.CLOUDCONVERT_API_KEY;
  return fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

async function waitForJob(jobId) {
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await ccFetch(`/jobs/${jobId}`);
    const { data } = await res.json();
    if (data.status === 'finished') return data;
    if (data.status === 'error') {
      const errTask = data.tasks.find(t => t.status === 'error');
      throw new Error(errTask?.message || 'Ошибка конвертации');
    }
  }
  throw new Error('Таймаут конвертации');
}

async function uploadFile(uploadTask, filePath, fileName) {
  const { url, parameters } = uploadTask.result.form;
  const form = new FormData();
  for (const [k, v] of Object.entries(parameters)) form.append(k, v);
  form.append('file', fs.createReadStream(filePath), fileName);
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Ошибка загрузки файла на CloudConvert');
}

async function streamUrl(url, res, mime, filename) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Не удалось скачать результат с CloudConvert');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  r.body.pipe(res);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.CLOUDCONVERT_API_KEY) return res.status(500).json({ error: 'API ключ не настроен' });

  const form = formidable({ maxFileSize: 50 * 1024 * 1024, maxFiles: 20 });
  let fields, files;
  try {
    [fields, files] = await form.parse(req);
  } catch (err) {
    return res.status(400).json({ error: 'Ошибка чтения файла: ' + err.message });
  }

  const mode  = Array.isArray(fields.mode)  ? fields.mode[0]  : (fields.mode  || 'doc');
  const count = parseInt(Array.isArray(fields.count) ? fields.count[0] : (fields.count || '1'));

  const uploadedFiles = [];
  for (let i = 0; i < count; i++) {
    const key = `file_${i}`;
    const f = Array.isArray(files[key]) ? files[key][0] : files[key];
    if (f) uploadedFiles.push(f);
  }
  if (!uploadedFiles.length) return res.status(400).json({ error: 'Файлы не найдены' });

  try {
    // ── Build job definition ──────────────────────────────────────
    let jobDef;
    const baseName = uploadedFiles[0].originalFilename.replace(/\.[^.]+$/, '');

    if (mode === 'doc') {
      const ext = uploadedFiles[0].originalFilename.split('.').pop().toLowerCase();
      jobDef = { tasks: {
        'upload':  { operation: 'import/upload' },
        'convert': { operation: 'convert', input: 'upload', input_format: ext, output_format: 'pdf', engine: 'libreoffice' },
        'export':  { operation: 'export/url', input: 'convert' },
      }};

    } else if (mode === 'img') {
      const tasks = {};
      for (let i = 0; i < uploadedFiles.length; i++) {
        tasks[`upload_${i}`] = { operation: 'import/upload' };
      }
      if (uploadedFiles.length === 1) {
        const ext = uploadedFiles[0].originalFilename.split('.').pop().toLowerCase();
        tasks['convert'] = { operation: 'convert', input: 'upload_0', input_format: ext, output_format: 'pdf' };
        tasks['export']  = { operation: 'export/url', input: 'convert' };
      } else {
        for (let i = 0; i < uploadedFiles.length; i++) {
          const ext = uploadedFiles[i].originalFilename.split('.').pop().toLowerCase();
          tasks[`convert_${i}`] = { operation: 'convert', input: `upload_${i}`, input_format: ext, output_format: 'pdf' };
        }
        tasks['merge']  = { operation: 'merge', input: uploadedFiles.map((_, i) => `convert_${i}`), output_format: 'pdf' };
        tasks['export'] = { operation: 'export/url', input: 'merge' };
      }
      jobDef = { tasks };

    } else if (mode === 'pdf') {
      // PDF → JPG pages, packaged as ZIP in one job
      jobDef = { tasks: {
        'upload':  { operation: 'import/upload' },
        'convert': { operation: 'convert', input: 'upload', input_format: 'pdf', output_format: 'jpg', engine: 'mupdf' },
        'archive': { operation: 'archive', input: 'convert', output_format: 'zip' },
        'export':  { operation: 'export/url', input: 'archive' },
      }};

    } else if (mode === 'pdf2doc') {
      jobDef = { tasks: {
        'upload':  { operation: 'import/upload' },
        'convert': { operation: 'convert', input: 'upload', input_format: 'pdf', output_format: 'docx', engine: 'libreoffice' },
        'export':  { operation: 'export/url', input: 'convert' },
      }};
    }

    // ── Create job ────────────────────────────────────────────────
    const jobRes  = await ccFetch('/jobs', { method: 'POST', body: JSON.stringify(jobDef) });
    const jobData = await jobRes.json();
    if (!jobRes.ok) throw new Error(jobData.message || 'Ошибка создания задачи');
    const job = jobData.data;

    // ── Upload files ──────────────────────────────────────────────
    if (mode === 'doc' || mode === 'pdf' || mode === 'pdf2doc') {
      const t = job.tasks.find(t => t.name === 'upload');
      await uploadFile(t, uploadedFiles[0].filepath, uploadedFiles[0].originalFilename);
    } else {
      for (let i = 0; i < uploadedFiles.length; i++) {
        const t = job.tasks.find(t => t.name === `upload_${i}`);
        await uploadFile(t, uploadedFiles[i].filepath, uploadedFiles[i].originalFilename);
      }
    }

    // ── Wait & stream result ──────────────────────────────────────
    const finished   = await waitForJob(job.id);
    const exportTask = finished.tasks.find(t => t.name === 'export');
    const result     = exportTask.result.files[0];

    if (mode === 'pdf') {
      await streamUrl(result.url, res, 'application/zip', `${baseName}.zip`);
    } else if (mode === 'pdf2doc') {
      await streamUrl(result.url, res, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', `${baseName}.docx`);
    } else {
      await streamUrl(result.url, res, 'application/pdf', `${baseName}.pdf`);
    }

  } catch (err) {
    console.error('Convert error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}
