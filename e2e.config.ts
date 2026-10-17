import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{
    engine: web(),
    app: {
      url: process.env.APP_URL ?? 'http://localhost:4021',
      // Without APP_URL, the runner starts Coin Slot offline (simulated Airwallex and Metal).
      ...(process.env.APP_URL ? {} : { command: { executable: 'npm', args: ['run', 'serve:offline'] } }),
    },
  }],
} satisfies E2EConfig;
