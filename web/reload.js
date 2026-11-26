const script = new URL('../reload-worker.js', import.meta.url).href;
const ticketKey = 'my-day-reload-v1';

function controller() {
  const worker = navigator.serviceWorker?.controller;
  return worker?.scriptURL === script ? worker : null;
}

export function prepareReload() {
  try {
    if (!controller()) navigator.serviceWorker?.register(script).catch(() => {});
  } catch { /* Connection by button also works without service workers. */ }
}

export function leaveForReload(session, epoch) {
  try {
    const worker = controller();
    if (!worker || !epoch || !session || session.until <= Date.now()) return;
    const ticket = crypto.randomUUID();
    sessionStorage.setItem(ticketKey, ticket);
    worker.postMessage({type: 'leave', ticket, epoch, token: session.token, until: session.until});
  } catch { /* The next document reconnects by button. */ }
}

export function resumeReload(epoch) {
  try {
    const ticket = sessionStorage.getItem(ticketKey);
    if (!ticket) return null;
    sessionStorage.removeItem(ticketKey);
    const worker = controller();
    if (!worker || !epoch || performance.getEntriesByType('navigation')[0]?.type !== 'reload') return null;
    return new Promise(resolve => {
      const channel = new MessageChannel();
      const finish = value => {
        clearTimeout(timer);
        channel.port1.close();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 1500);
      channel.port1.onmessage = event => finish(event.data);
      try { worker.postMessage({type: 'resume', ticket, epoch}, [channel.port2]); }
      catch { finish(null); }
    });
  } catch { return null; }
}
