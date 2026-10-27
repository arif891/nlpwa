export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }

  res.status(200).json({
    success: true,
    status: 'synced',
    timestamp: Date.now(),
    data: body || null,
  });
}
