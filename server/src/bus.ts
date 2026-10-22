import { EventEmitter } from 'node:events';
import type { Session } from '../../shared/protocol.js';

/**
 * In-process events between modules that shouldn't import each other
 * (the board follows session status without the session runtime knowing about boards).
 */
interface BusEvents {
  session: [Session];
  'session:deleted': [string];
  /** `signal` is set (non-zero) when the process was killed rather than exiting on its own. */
  'terminal:exit': [{ id: string; projectId: string; exitCode: number; signal: number }];
}

class Bus extends EventEmitter<BusEvents> {}

export const bus = new Bus();
bus.setMaxListeners(50);
