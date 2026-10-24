import handler from '../server/index.js';

export default async function matchEndpoint(req, res) {
  req.targetRoute = '/api/match';
  return handler(req, res);
}
