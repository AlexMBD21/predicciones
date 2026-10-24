import handler from '../server/index.js';

export default async function predictEndpoint(req, res) {
  req.targetRoute = '/api/predict';
  return handler(req, res);
}
