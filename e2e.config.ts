import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  // Offline runs the full suite on seeded data; against a deployed APP_URL only the read-only live checks run.
  tests: process.env.APP_URL ? ['tests/live.e2e.ts'] : ['tests/**/*.e2e.ts', '!tests/live.e2e.ts'],
  targets: [{
    engine: web(),
    app: {
      url: process.env.APP_URL ?? 'http://localhost:4021',
      // Without APP_URL, the runner starts Sayso offline (simulated Airwallex and Metal).
      ...(process.env.APP_URL ? {} : { command: { executable: 'npm', args: ['run', 'serve:offline'] } }),
    },
  }],
} satisfies E2EConfig;
