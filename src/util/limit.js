// Tiny concurrency gate. Without it, a burst of inbound webhooks fans out into an unbounded number
// of simultaneous LLM calls — which is how you get timeouts, rate limits and a surprise bill.
export function createLimiter(max = 3, { queueLimit = 200 } = {}) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    const { fn, resolve, reject } = queue.shift();
    active++;
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  const run = (fn) => new Promise((resolve, reject) => {
    if (queue.length >= queueLimit) return reject(new Error('Too busy — AI queue is full, try again shortly'));
    queue.push({ fn, resolve, reject });
    next();
  });
  run.stats = () => ({ active, queued: queue.length, max });
  return run;
}
