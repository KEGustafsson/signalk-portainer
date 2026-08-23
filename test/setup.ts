import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from 'node:util';

// jsdom does not provide these, though every browser has had them for years.
// The console decodes the shell's output with a TextDecoder, so without this
// the tests for it would be testing a different thing than the panel runs.
if (typeof globalThis.TextDecoder === 'undefined') {
  Object.assign(globalThis, { TextDecoder, TextEncoder });
}
