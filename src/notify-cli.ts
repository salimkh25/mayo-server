// Send a Pushover notification from the command line — used during go-live so Claude (or you)
// can ping your iPhone the moment a step needs your attention.
//   npm run notify -- "Your message here"
import { notify, notifyConfigured } from './notify.js';

const message = process.argv.slice(2).join(' ') || 'Test notification from NAYO';

if (!notifyConfigured()) {
  console.error('Pushover is not configured. Set PUSHOVER_TOKEN and PUSHOVER_USER in your env / .env.');
  process.exit(1);
}

notify(message, { title: 'NAYO', priority: 1 }).then((ok) => {
  console.log(ok ? '✓ Sent to your phone.' : '✗ Failed — check your Pushover credentials.');
  process.exit(ok ? 0 : 1);
});
