import handler from '../server/index.js';

export default async function statusEndpoint(req, res) {
  req.targetRoute = '/api/status';
  return handler(req, res);
}
