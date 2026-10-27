export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.status(200).json({
    status: 'live',
    strategy: 'network-only',
    timestamp: Date.now(),
    iso: new Date().toISOString(),
    server: 'NLPWA Edge Server (Vercel Serverless)',
    message: 'Fresh real-time timestamp generated on demand.',
  });
}
