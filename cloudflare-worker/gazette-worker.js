import { runMediaAutomation } from './worker.js';

export default {
  async fetch() {
    return new Response('Not found', { status: 404 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runMediaAutomation(env));
  }
};
