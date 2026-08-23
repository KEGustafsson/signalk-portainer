import { ConfigError, normalizeConfig, type RawConfig } from '../src/config';

const validInstance = {
  name: 'local',
  url: 'https://localhost:9443',
  apiKey: 'ptr_token',
};

describe('normalizeConfig', () => {
  it('bounds the poll interval at both ends', () => {
    // A floor alone is not enough: Math.max(5, NaN) is NaN, and setInterval
    // with NaN fires every millisecond. Anything past ~24.8 days overflows
    // Node's timer and does the same.
    const at = (intervalSeconds: unknown): number =>
      normalizeConfig({
        instances: [{ name: 'local', url: 'https://h', apiKey: 'ptr_x' }],
        telemetry: { intervalSeconds },
      } as never).telemetry.intervalSeconds;

    expect(at(1)).toBe(5);
    expect(at('abc')).toBe(30);
    expect(at(Number.NaN)).toBe(30);
    expect(at(9_000_000)).toBe(3600);
    expect(at(60)).toBe(60);
  });

  it('refuses a timeout large enough to abort instantly', () => {
    expect(() =>
      normalizeConfig({
        instances: [
          {
            name: 'local',
            url: 'https://h',
            apiKey: 'ptr_x',
            advanced: { timeoutMs: 3_000_000_000 },
          },
        ],
      }),
    ).toThrow(/between 1000 and 120000 ms/);
  });

  describe('the address', () => {
    const urlOf = (url: string): string | undefined =>
      normalizeConfig({ instances: [{ ...validInstance, url }] }).instances[0]?.baseUrl;

    it('is taken as one field, the way everybody writes it', () => {
      expect(urlOf('https://boat.local:9443')).toBe('https://boat.local:9443');
      expect(urlOf('http://192.168.1.10:9000')).toBe('http://192.168.1.10:9000');
    });

    it('keeps a proxy prefix and drops the slash it may end with', () => {
      expect(urlOf('https://boat.local:9443/portainer/')).toBe('https://boat.local:9443/portainer');
    });

    it("uses the scheme's own port when none is given", () => {
      // A Portainer behind a reverse proxy answers on 443, and typing a port
      // should not be the price of that being understood.
      expect(urlOf('https://portainer.example.com')).toBe('https://portainer.example.com');
    });

    it('keeps an IPv6 address in its brackets', () => {
      expect(urlOf('https://[fd00::1]:9443')).toBe('https://[fd00::1]:9443');
    });

    it('says so rather than connecting somewhere unintended', () => {
      expect(() => urlOf('boat.local')).toThrow(/not a URL/);
      // "boat.local:9443" parses as a URL with a scheme of "boat.local", which
      // is exactly the mistake this message has to name.
      expect(() => urlOf('boat.local:9443')).toThrow(/https:\/\/ or http:\/\//);
      expect(() => urlOf('ftp://boat.local')).toThrow(/https:\/\/ or http:\/\//);
      expect(() => normalizeConfig({ instances: [{ name: 'local', apiKey: 'ptr_x' }] })).toThrow(
        /has no address/,
      );
    });
  });

  it('rejects an empty instance list', () => {
    expect(() => normalizeConfig({ instances: [] })).toThrow(ConfigError);
    expect(() => normalizeConfig(undefined)).toThrow(/No Portainer instance configured/);
  });

  it('rejects duplicate instance names case-insensitively', () => {
    expect(() =>
      normalizeConfig({
        instances: [validInstance, { ...validInstance, name: 'LOCAL' }],
      }),
    ).toThrow(/Duplicate instance name/);
  });

  it('rejects names that would not be valid Signal K path segments', () => {
    expect(() => normalizeConfig({ instances: [{ ...validInstance, name: 'on board' }] })).toThrow(
      /path-safe/,
    );
    expect(() => normalizeConfig({ instances: [{ ...validInstance, name: 'a.b' }] })).toThrow(
      /path-safe/,
    );
  });

  it('requires a credential and names the mode that is short of one', () => {
    expect(() => normalizeConfig({ instances: [{ name: 'local', host: 'h' }] })).toThrow(
      /no API token/,
    );
    expect(() =>
      normalizeConfig({
        instances: [{ name: 'local', host: 'h', authMode: 'userPass', username: 'admin' }],
      }),
    ).toThrow(/username\/password but one of them is empty/);
  });

  it('rejects an implausible timeout', () => {
    expect(() => normalizeConfig({ instances: [{ ...validInstance, timeoutMs: 10 }] })).toThrow(
      /between 1000 and 120000 ms/,
    );
  });

  it('rejects a config whose every instance is disabled', () => {
    expect(() => normalizeConfig({ instances: [{ ...validInstance, enabled: false }] })).toThrow(
      /Every configured Portainer instance is disabled/,
    );
  });

  it('only sets TLS options that were actually chosen', () => {
    const plain = normalizeConfig({ instances: [validInstance] });
    expect(plain.instances[0]?.tls).toEqual({});

    const custom = normalizeConfig({
      instances: [
        {
          ...validInstance,
          advanced: { rejectUnauthorized: false, caCert: 'PEM', servername: 'pi' },
        },
      ],
    });
    expect(custom.instances[0]?.tls).toEqual({
      rejectUnauthorized: false,
      ca: 'PEM',
      servername: 'pi',
    });
  });

  it('clamps the poll interval and trims a trailing dot from the prefix', () => {
    const config = normalizeConfig({
      instances: [validInstance],
      telemetry: { intervalSeconds: 1, pathPrefix: 'system.docker.' },
    });
    expect(config.telemetry.intervalSeconds).toBe(5);
    expect(config.telemetry.pathPrefix).toBe('system.docker');
  });

  describe('telemetry level', () => {
    it('defaults to health — useful data without the identifying strings', () => {
      expect(normalizeConfig({ instances: [validInstance] }).telemetry.level).toBe('health');
    });

    it.each([['off'], ['health'], ['full']])('accepts %s', (level) => {
      expect(
        normalizeConfig({ instances: [validInstance], telemetry: { level } }).telemetry.level,
      ).toBe(level);
    });

    it('falls back to health rather than trusting an unknown value', () => {
      expect(
        normalizeConfig({ instances: [validInstance], telemetry: { level: 'everything' } })
          .telemetry.level,
      ).toBe('health');
    });

    it('reads the boolean this setting used to be', () => {
      // A configuration saved by an earlier build must not silently start
      // publishing again after the operator turned it off.
      expect(
        normalizeConfig({ instances: [validInstance], telemetry: { enabled: false } }).telemetry
          .level,
      ).toBe('off');
      expect(
        normalizeConfig({ instances: [validInstance], telemetry: { enabled: true } }).telemetry
          .level,
      ).toBe('full');
    });

    it('prefers the explicit level over the old boolean', () => {
      expect(
        normalizeConfig({
          instances: [validInstance],
          telemetry: { enabled: true, level: 'off' },
        }).telemetry.level,
      ).toBe('off');
    });
  });

  it('defaults control to the safe settings', () => {
    const config = normalizeConfig({ instances: [validInstance] });
    expect(config.control.allowDestructive).toBe(false);
    expect(config.control.allowSelfManagement).toBe(false);
    expect(config.control.allowPutControl).toBe(true);
  });

  it('attaches watchdog entries to the first enabled instance by default', () => {
    const raw: RawConfig = {
      instances: [
        { ...validInstance, name: 'disabled', enabled: false },
        { ...validInstance, name: 'boat' },
      ],
      control: { watchdog: [{ container: 'ais-logger' }, { container: '' }] },
    };
    const config = normalizeConfig(raw);
    expect(config.control.watchdog).toEqual([{ instance: 'boat', container: 'ais-logger' }]);
  });

  it('treats an omitted environment as auto-select', () => {
    const config = normalizeConfig({ instances: [validInstance] });
    expect(config.instances[0]?.environment).toEqual({ id: null, name: '' });
  });
  /**
   * The address used to be four fields, and the advanced settings sat flat
   * beside the ones an operator fills in every time. Both are still read: a
   * configuration written by an earlier build must keep connecting to the same
   * Portainer rather than coming up empty and having to be typed again.
   */
  describe('a configuration written by an earlier build', () => {
    const legacy = { name: 'local', host: 'localhost', apiKey: 'ptr_token' };

    it('still builds the address from protocol, host, port and base path', () => {
      const config = normalizeConfig({
        instances: [{ ...legacy, protocol: 'http', port: 9000, basePath: '/portainer/' }],
      });
      expect(config.instances[0]?.baseUrl).toBe('http://localhost:9000/portainer');
    });

    it('still defaults to https on 9443, and to 9000 for plain http', () => {
      expect(normalizeConfig({ instances: [legacy] }).instances[0]?.baseUrl).toBe(
        'https://localhost:9443',
      );
      expect(
        normalizeConfig({ instances: [{ ...legacy, protocol: 'http' }] }).instances[0]?.baseUrl,
      ).toBe('http://localhost:9000');
    });

    it('still rejects an invalid port and an unrooted base path', () => {
      expect(() => normalizeConfig({ instances: [{ ...legacy, port: 70000 }] })).toThrow(
        /invalid port/,
      );
      expect(() => normalizeConfig({ instances: [{ ...legacy, basePath: 'portainer' }] })).toThrow(
        /must start with/,
      );
    });

    it('still reads the advanced settings from where they used to live', () => {
      const config = normalizeConfig({
        instances: [{ ...legacy, timeoutMs: 25_000, caCert: 'PEM', rejectUnauthorized: false }],
      });
      expect(config.instances[0]?.timeoutMs).toBe(25_000);
      expect(config.instances[0]?.tls).toEqual({ ca: 'PEM', rejectUnauthorized: false });
    });

    it('prefers the new address and the new advanced block over the old fields', () => {
      const config = normalizeConfig({
        instances: [
          {
            ...legacy,
            url: 'https://boat.local:9443',
            timeoutMs: 25_000,
            advanced: { timeoutMs: 5_000 },
          },
        ],
      });
      expect(config.instances[0]?.baseUrl).toBe('https://boat.local:9443');
      expect(config.instances[0]?.timeoutMs).toBe(5_000);
    });
  });
});
