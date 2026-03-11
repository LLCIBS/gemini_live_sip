/**
 * Patches Node.js's https.request so that the `ws` library (used internally
 * by @google/genai for Live API WebSocket connections) tunnels through
 * the configured HTTP(S) proxy.
 *
 * The `ws` library calls https.request(opts) directly, bypassing undici's
 * ProxyAgent. This patch intercepts those calls and injects an
 * HttpsProxyAgent for requests targeting googleapis.com.
 *
 * Must be imported BEFORE any code that opens WebSocket connections.
 */
import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;

if (proxyUrl) {
  const agent = new HttpsProxyAgent(proxyUrl);
  const originalRequest = https.request.bind(https);

  (https as any).request = function patchedRequest(
    ...args: any[]
  ) {
    let options = args[0];

    if (typeof options === 'object' && options !== null && !(options instanceof URL)) {
      const host = options.host || options.hostname || '';
      if (host.includes('googleapis.com')) {
        options.agent = agent;
        delete options.createConnection;
      }
    }

    return originalRequest(...args);
  };

  console.log('WebSocket proxy patch applied (ws → https-proxy-agent).');
}
