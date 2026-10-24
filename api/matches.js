import handler from '../server/index.js';

export default async function matchesEndpoint(req, res) {
  req.targetRoute = '/api/matches';
  return handler(req, res);
}
