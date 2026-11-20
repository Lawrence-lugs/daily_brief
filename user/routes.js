// user/routes.js
// HTTP route handlers for the config editor API.
//   GET  /api/config/:file        -> current config
//   GET  /api/config/:file/schema -> JSON Schema for the file
//   PUT  /api/config/:file        -> validate + save new config
//   POST /api/config/:file/reset  -> restore shipped defaults (with backup)
// All config-specific code lives under `user/`.
import { loadConfig, loadSchema, EDITABLE_FILES } from './config.js';
import { saveConfig, resetConfig } from './save.js';

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

export function handleConfigRoutes(req, res, routePath, dataDir) {
  const m = routePath.match(/^\/api\/config\/([^/]+)(\/schema|\/reset)?$/);
  if (!m) return false;

  const fileName = m[1];
  const action = m[2] ?? null;
  const isSchema = action === '/schema';

  if (!EDITABLE_FILES.includes(fileName)) {
    json(res, 404, { error: `unknown config file "${fileName}"` });
    return true;
  }

  if (req.method === 'GET') {
    if (isSchema) {
      const schema = loadSchema(fileName);
      if (!schema) { json(res, 404, { error: `no schema for "${fileName}"` }); return true; }
      json(res, 200, schema);
      return true;
    }
    if (action) { json(res, 405, { error: 'method not allowed' }); return true; }
    const data = loadConfig(dataDir, fileName);
    if (data === null) { json(res, 404, { error: `config file "${fileName}" not found` }); return true; }
    json(res, 200, data);
    return true;
  }

  if (req.method === 'POST' && action === '/reset') {
    try {
      const result = resetConfig(dataDir, fileName);
      if (!result.ok) {
        json(res, result.noDefaults ? 500 : 400, {
          error: result.noDefaults ? 'defaults not found' : 'reset failed',
          details: result.errors,
        });
        return true;
      }
      json(res, 200, {
        ok: true,
        backup: result.backup,
        path: result.path,
        data: result.data,
        note: 'reset to defaults; applies on next run',
      });
      return true;
    } catch (e) {
      json(res, 500, { error: `reset failed: ${e.message}` });
      return true;
    }
  }

  if (req.method === 'PUT' && !action) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let newData;
      try { newData = body ? JSON.parse(body) : {}; }
      catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const result = saveConfig(dataDir, fileName, newData);
      if (!result.ok) {
        return json(res, 400, { error: 'validation failed', details: result.errors });
      }
      return json(res, 200, { ok: true, backup: result.backup, note: 'saved; applies on next run' });
    });
    return true;
  }

  json(res, 405, { error: 'method not allowed' });
  return true;
}
