/**
 * The slice of the Signal K server plugin API this plugin uses. Declared
 * locally so the plugin carries no runtime dependency on the server package.
 */
export interface SignalKApp {
  debug: (message: string) => void;
  error: (message: string) => void;
  setPluginStatus?: (message: string) => void;
  setPluginError?: (message: string) => void;
}

export interface SignalKPlugin {
  id: string;
  name: string;
  description: string;
  schema: unknown;
  start: (options: unknown) => void;
  stop: () => void;
  registerWithRouter?: (router: import('express').Router) => void;
}
