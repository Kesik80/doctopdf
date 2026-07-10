import formidable from 'formidable';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

export const config = { api: { bodyParser: false } };

const BASE = 'https://api.cloudconvert.com/v2';

async function ccFetch(path, opts = {}) {
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
      throw new Error(errTask?.message || 'Ошибка конвертации на CloudConvert');
    }
  }
  throw new Error('Таймаут: конвертация заняла слишком много времени');
}

async function uploadFile(uploadTask, filePath, fileName) {
  const { url, parameters } = uploadTask.result.form;
  const form = new FormData();
  for (const [k, v] of Object.entries(parameters)) form.append(k, v);
  form.append('file', fs.createReadStream(filePath), fileName);
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Ошибка загрузки файла на CloudConvert');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.CLOUDCONVERT_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API ключ не настроен' });

  const form = formidable({ maxFileSize: 50 * 1024 * 1024, maxFiles: 20 });
  let fields, files;
  try {
    [fields, files] = await form.parse(req);
  } catch (err) {
    return res.status(400).json({ error: 'Ошибка чтения файла: ' + err.message });
  }

  const mode = (Array.isArray(fields.mode) ? fields.mode[0] : fields.mode) || 'doc';
  const count = parseInt((Array.isArray(fields.count) ? fields.count[0] : fields.count) || '1');

  // Collect uploaded files in order
  const uploadedFiles = [];
  for (let i = 0; i < count; i++) {
    const key = `file_${i}`;
    const f = Array.isArray(files[key]) ? files[key][0] : files[key];
    if (f) uploadedFiles.push(f);
  }

  if (!uploadedFiles.length) return res.status(400).json({ error: 'Файлы не найдены' });

  try {
    let jobDef;

    if (mode === 'doc') {
      // Single doc/docx → PDF
      const file = uploadedFiles[0];
      const ext = file.originalFilename.split('.').pop().toLowerCase();
      jobDef = {
        tasks: {
          'upload': { operation: 'import/upload' },
          'convert': { operation: 'convert', input: 'upload', input_format: ext, output_format: 'pdf', engine: 'libreoffice' },
          'export': { operation: 'export/url', input: 'convert' },
        }
      };

    } else if (mode === 'img') {
      // One or more images → single PDF (merge)
      const tasks = {};
      const uploadNames = [];
      for (let i = 0; i < uploadedFiles.length; i++) {
        const name = `upload_${i}`;
        tasks[name] = { operation: 'import/upload' };
        uploadNames.push(name);
      }
      if (uploadedFiles.length === 1) {
        const ext = uploadedFiles[0].originalFilename.split('.').pop().toLowerCase();
        tasks['convert'] = { operation: 'convert', input: uploadNames[0], input_format: ext, output_format: 'pdf' };
        tasks['export'] = { operation: 'export/url', input: 'convert' };
      } else {
        // Convert each image to PDF, then merge
        const convertNames = [];
        for (let i = 0; i < uploadedFiles.length; i++) {
          const ext = uploadedFiles[i].originalFilename.split('.').pop().toLowerCase();
          const name = `convert_${i}`;
          tasks[name] = { operation: 'convert', input: uploadNames[i], input_format: ext, output_format: 'pdf' };
          convertNames.push(name);
        }
        tasks['merge'] = { operation: 'merge', input: convertNames, output_format: 'pdf' };
        tasks['export'] = { operation: 'export/url', input: 'merge' };
      }
      jobDef = { tasks };

    } else if (mode === 'pdf') {
      // PDF → JPG (zip of pages)
      jobDef = {
        tasks: {
          'upload': { operation: 'import/upload' },
          'convert': { operation: 'convert', input: 'upload', input_format: 'pdf', output_format: 'jpg', engine: 'mupdf' },
          'export': { operation: 'export/url', input: 'convert', archive_multiple_files: true },
        }
      };
    } else if (mode === 'pdf2doc') {
      // PDF → DOCX via LibreOffice
      jobDef = {
        tasks: {
          'upload': { operation: 'import/upload' },
          'convert': { operation: 'convert', input: 'upload', input_format: 'pdf', output_format: 'docx', engine: 'libreoffice' },
          'export': { operation: 'export/url', input: 'convert' },
        }
      };
    }

    // Create job
    const jobRes = await ccFetch('/jobs', { method: 'POST', body: JSON.stringify(jobDef) });
    const jobData = await jobRes.json();
    if (!jobRes.ok) throw new Error(jobData.message || 'Ошибка создания задачи');

    const job = jobData.data;

    // Upload files
    if (mode === 'doc' || mode === 'pdf' || mode === 'pdf2doc') {
      const uploadTask = job.tasks.find(t => t.name === 'upload');
      await uploadFile(uploadTask, uploadedFiles[0].filepath, uploadedFiles[0].originalFilename);
    } else {
      for (let i = 0; i < uploadedFiles.length; i++) {
        const uploadTask = job.tasks.find(t => t.name === `upload_${i}`);
        await uploadFile(uploadTask, uploadedFiles[i].filepath, uploadedFiles[i].originalFilename);
      }
    }

    // Wait for result
    const finishedJob = await waitForJob(job.id);
    const exportTask = finishedJob.tasks.find(t => t.name === 'export');
    const resultFiles = exportTask.result.files;

    if (resultFiles.length === 1) {
      // Single file — stream directly
      const pdfRes = await fetch(resultFiles[0].url);
      if (!pdfRes.ok) throw new Error('Не удалось скачать результат');
      let mime, fname;
      if (mode === 'pdf') {
        // Single page PDF — wrap in zip for consistency
        mime = 'image/jpeg';
        fname = resultFiles[0].filename;
      } else if (mode === 'pdf2doc') {
        mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        fname = resultFiles[0].filename || 'document.docx';
      } else {
        mime = 'application/pdf';
        fname = resultFiles[0].filename;
      }
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      pdfRes.body.pipe(res);
    } else {
      // Multiple files (PDF pages) — download as ZIP via CloudConvert archive
      // Re-export as archive
      const archiveRes = await ccFetch('/jobs', {
        method: 'POST',
        body: JSON.stringify({
          tasks: {
            'import-result': { operation: 'import/url', url: resultFiles[0].url },
            'archive': { operation: 'archive', input: resultFiles.map((_, i) => `import-${i}`), output_format: 'zip' },
            'export-zip': { operation: 'export/url', input: 'archive' },
          }
        })
      });
      // Simpler: just redirect to first file or stream a zip manually
      // For now stream first file and note the rest
      const pdfRes = await fetch(resultFiles[0].url);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="pages.zip"`);

      // Use CloudConvert's built-in zip export
      const zipJobRes = await ccFetch('/jobs', {
        method: 'POST',
        body: JSON.stringify({
          tasks: {
            ...Object.fromEntries(resultFiles.map((f, i) => [`import_${i}`, { operation: 'import/url', url: f.url, filename: f.filename }])),
            'archive': { operation: 'archive', input: resultFiles.map((_, i) => `import_${i}`), output_format: 'zip' },
            'export': { operation: 'export/url', input: 'archive' },
          }
        })
      });
      const zipJob = await zipJobRes.json();
      const finishedZip = await waitForJob(zipJob.data.id);
      const zipExport = finishedZip.tasks.find(t => t.name === 'export');
      const zipUrl = zipExport.result.files[0].url;
      const zipRes = await fetch(zipUrl);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="pages.zip"');
      zipRes.body.pipe(res);
    }

  } catch (err) {
    console.error('Convert error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}
