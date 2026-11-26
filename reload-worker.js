// Observe only browser reloads of the app. All network responses come directly from the server.
const reloads = new Map();
const grants = new Map();
const lifetime = 10000;

function appPage(url) {
  const root = new URL('./', self.location.href);
  const page = new URL(url);
  return page.origin === root.origin &&
    (page.pathname === root.pathname || page.pathname === root.pathname + 'index.html');
}

function keep(map, id, record) {
  const expiry = performance.now() + lifetime;
  map.set(id, {...record, expiry});
  setTimeout(() => { if (map.get(id)?.expiry === expiry) map.delete(id); }, lifetime);
}

self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || event.request.destination !== 'document' ||
      !event.request.isReloadNavigation || !appPage(event.request.url)) return;
  // On Chromium a reload request is issued by the outgoing document's clientId.
  const from = event.replacesClientId || event.clientId;
  if (from && event.resultingClientId) keep(reloads, from, {to: event.resultingClientId});
});

self.addEventListener('message', event => {
  const source = event.source;
  if (!source || source.type !== 'window' || source.frameType !== 'top-level' || !appPage(source.url)) return;
  const message = event.data;
  if (!message || !message.ticket || !message.epoch) return;
  if (message.type === 'leave') {
    const reload = reloads.get(source.id);
    if (!reload || reload.expiry <= performance.now() || typeof message.token !== 'string' ||
        !Number.isFinite(message.until) || message.until <= Date.now()) return;
    reloads.delete(source.id);
    keep(grants, reload.to, {ticket: message.ticket, epoch: message.epoch, token: message.token, until: message.until});
  } else if (message.type === 'resume' && event.ports[0]) {
    const grant = grants.get(source.id);
    grants.delete(source.id);
    const valid = grant && grant.expiry > performance.now() && grant.until > Date.now() &&
      grant.ticket === message.ticket && grant.epoch === message.epoch;
    event.ports[0].postMessage(valid ? {token: grant.token, until: grant.until} : null);
  }
});
