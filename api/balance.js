import fetch from 'node-fetch';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.CLOUDCONVERT_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API ключ не настроен' });
  }

  try {
    const r = await fetch('https://api.cloudconvert.com/v2/users/me', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'Ошибка запроса');

    const credits = data.data?.credits ?? null;
    res.status(200).json({ credits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
