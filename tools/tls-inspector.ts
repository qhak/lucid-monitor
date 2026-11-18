import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { checkServerIdentity, connect } from 'node:tls';
import { isPublicAddress, validateTarget } from '../server/probe.ts';

const allowed = process.env.OUTBOUND_HOSTS?.trim();
const token = process.env.TLS_METADATA_TOKEN;
if (!allowed || !token || token.length < 32) {
  throw new Error('Set OUTBOUND_HOSTS and a TLS_METADATA_TOKEN of at least 32 characters');
}
const expected = Buffer.from('Bearer ' + token);

async function inspect(hostname: string, signal: AbortSignal) {
  const records = await lookup(hostname, { all: true });
  signal.throwIfAborted();
  if (!records.length || records.some(({ address, family }) => !isPublicAddress(address, family === 4 ? 1 : 28))) {
    throw new Error('Destination is unavailable');
  }
  // Dial a validated literal address and send the original hostname through SNI.
  const { address } = records[0];
  return new Promise<string>((resolve, reject) => {
    const socket = connect({
      host: address, port: 443, servername: hostname, rejectUnauthorized: false,
    });
    const onAbort = () => socket.destroy(new Error('Timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('error', reject);
    socket.once('close', () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Peer closed the connection'));
    });
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      const expiresAt = Date.parse(certificate.valid_to);
      if (!certificate.raw || checkServerIdentity(hostname, certificate) || !Number.isFinite(expiresAt)) {
        socket.destroy(new Error('Peer certificate unavailable'));
        return;
      }
      resolve(new Date(expiresAt).toISOString());
      socket.destroy();
    });
  });
}

let active = 0;
const server = createServer({ requestTimeout: 5000, headersTimeout: 3000, maxHeaderSize: 8192 }, async (req, res) => {
  const reply = (status: number, body: object) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const supplied = Buffer.from(req.headers.authorization ?? '');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    reply(401, { error: 'Unauthorized' });
    return;
  }
  let hostname: string;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const target = url.searchParams.get('hostname');
    if (req.method !== 'GET' || url.pathname !== '/expiry' || !target ||
      !/^[a-z0-9.-]+$/.test(target) || validateTarget('https://' + target, allowed).hostname !== target) {
      throw new Error('Invalid request');
    }
    hostname = target;
  } catch {
    reply(400, { error: 'Invalid request' });
    return;
  }
  if (active >= 8) {
    reply(429, { error: 'Too many requests' });
    return;
  }
  active++;
  try {
    const signal = AbortSignal.timeout(3500);
    const deadline = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('Timeout')), { once: true }));
    const certificateExpiresAt = await Promise.race([inspect(hostname, signal), deadline]);
    reply(200, { hostname, certificateExpiresAt });
  } catch {
    reply(502, { error: 'Certificate unavailable' });
  } finally {
    active--;
  }
});
server.maxConnections = 32;
server.listen(Number(process.env.TLS_METADATA_PORT ?? '8788'), '127.0.0.1');
