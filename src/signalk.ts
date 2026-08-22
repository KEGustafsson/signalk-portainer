import type { Plugin, PluginConstructor, ServerAPI } from '@signalk/server-api';

/**
 * The slice of the Signal K server API this plugin uses, derived from the
 * server's own types rather than hand-written, so contract drift is a compile
 * error instead of a runtime surprise.
 */
export type SignalKApp = Pick<
  ServerAPI,
  'debug' | 'error' | 'setPluginStatus' | 'setPluginError' | 'handleMessage'
> &
  Partial<Pick<ServerAPI, 'registerPutHandler'>>;

export type { Plugin as SignalKPlugin, PluginConstructor };
