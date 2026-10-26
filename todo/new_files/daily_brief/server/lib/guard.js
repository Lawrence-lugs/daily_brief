// The server writes to the DB and spawns processes, so it must resist (a) DNS-rebinding and
// (b) cross-site POSTs from any web page the user happens to have open.
//  - Host must be exactly 127.0.0.1:<port> or localhost:<port>   (defeats DNS rebinding)
//  - Mutating requests need `X-Brief-Client: 1`: a custom header forces a CORS preflight, and we
//    never answer OPTIONS, so a foreign origin cannot send it.
//  - If an Origin header is present it must equal our own origin.
// Returns an error string, or null when the request is allowed.
export function guard(req, port, isWrite) {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'bad host';
  if (!isWrite) return null;
  if (req.headers['x-brief-client'] !== '1') return 'missing X-Brief-Client header';
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return 'bad origin';
  return null;
}
