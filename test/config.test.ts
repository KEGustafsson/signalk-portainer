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

  it('drops a duplicate instance name case-insensitively, keeping the first', () => {
    // The duplicate carries a different address, so keeping the wrong row is
    // visible: comparing names alone passes either way, since both normalise
    // to the same one.
    const config = normalizeConfig({
      instances: [
        validInstance,
        { ...validInstance, name: 'LOCAL', url: 'https://impostor.test:9443' },
      ],
    });

    expect(config.instances).toHaveLength(1);
    expect(config.instances[0]?.name).toBe('local');
    expect(config.instances[0]?.baseUrl).toContain('localhost');
    expect(config.instances[0]?.baseUrl).not.toContain('impostor.test');
    expect(config.problems.join(' ')).toMatch(/Duplicate instance name/);
  });

  /**
   * One unusable row must not take the working ones with it. The admin UI
   * writes the schema's defaults the moment "+" is pressed, so an operator
   * preparing a second Portainer saves a half-filled row beside a working one
   * — and the whole configuration used to throw, leaving the boat's own
   * Portainer with no registry, no poller, no PUT handlers and no deltas.
   */
  describe('an instance that does not validate', () => {
    const halfFilled = { name: 'local', enabled: true, url: '' };

    it('is dropped, and the working instance still starts', () => {
      const config = normalizeConfig({
        instances: [{ ...validInstance, name: 'boat' }, halfFilled],
      });

      expect(config.instances.map((instance) => instance.name)).toEqual(['boat']);
      expect(config.problems).toHaveLength(1);
      expect(config.problems[0]).toMatch(/has no address/);
    });

    it('is reported whichever position it was saved in', () => {
      const config = normalizeConfig({
        instances: [halfFilled, { ...validInstance, name: 'boat' }],
      });

      expect(config.instances.map((instance) => instance.name)).toEqual(['boat']);
      expect(config.problems[0]).toMatch(/has no address/);
    });

    it('fails the configuration only when no instance is left', () => {
      expect(() => normalizeConfig({ instances: [halfFilled] })).toThrow(
        /No Portainer instance could be used/,
      );
      expect(() => normalizeConfig({ instances: [halfFilled] })).toThrow(/has no address/);
    });

    it('drops the watchdog entries that watched it, rather than failing', () => {
      // Failing here would undo the point of dropping the instance: the boat's
      // own telemetry would stop because a row it does not depend on is
      // half-filled.
      const config = normalizeConfig({
        instances: [
          { ...validInstance, name: 'boat' },
          { name: 'shore', enabled: true, url: '' },
        ],
        control: {
          watchdog: [
            { instance: 'boat', container: 'ais-logger' },
            { instance: 'shore', container: 'weather' },
          ],
        },
      });

      expect(config.control.watchdog).toEqual([{ instance: 'boat', container: 'ais-logger' }]);
      expect(config.problems.join(' ')).toMatch(/watchdog entry for "weather"/);
    });

    it('still refuses a watchdog naming an instance that was never configured', () => {
      expect(() =>
        normalizeConfig({
          instances: [validInstance],
          control: { watchdog: [{ instance: 'typo', container: 'ais-logger' }] },
        }),
      ).toThrow(/not a configured, enabled instance/);
    });
  });

  it('never validates a disabled instance', () => {
    // Switching an instance off is how an operator parks one they have not
    // finished filling in; validating it anyway makes the switch useless.
    const config = normalizeConfig({
      instances: [
        { ...validInstance, name: 'boat' },
        { name: 'shore', enabled: false, url: 'nonsense', apiKey: '' },
      ],
    });

    expect(config.instances.map((instance) => instance.name)).toEqual(['boat']);
    expect(config.problems).toEqual([]);
  });

  it('still rejects a configuration whose every instance is disabled', () => {
    expect(() =>
      normalizeConfig({
        instances: [
          { ...validInstance, enabled: false },
          { ...validInstance, name: 'other', enabled: false },
        ],
      }),
    ).toThrow(/Every configured Portainer instance is disabled/);
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

  /**
   * The prefix was the only Signal K path segment that reached a delta
   * unnormalised, while instance names and container keys both went through
   * strict rules.
   */
  describe('the telemetry path prefix', () => {
    const prefixOf = (pathPrefix: unknown): string =>
      normalizeConfig({
        instances: [validInstance],
        telemetry: { pathPrefix },
      } as never).telemetry.pathPrefix;

    it('normalises each segment the way every other path segment is normalised', () => {
      expect(prefixOf('my docker')).toBe('my_docker');
      expect(prefixOf('System.Docker')).toBe('system.docker');
    });

    it('drops empty segments rather than emitting an empty one', () => {
      expect(prefixOf('.system.docker')).toBe('system.docker');
      expect(prefixOf('system..docker')).toBe('system.docker');
      expect(prefixOf('system.docker.')).toBe('system.docker');
    });

    it('falls back to the default rather than collapsing to nothing', () => {
      // A prefix of "." used to leave an empty string, which silently moved
      // every path the plugin publishes.
      expect(prefixOf('.')).toBe('system.docker');
      expect(prefixOf('')).toBe('system.docker');
      expect(prefixOf(undefined)).toBe('system.docker');
    });

    it('leaves nothing in a path that Signal K would read as a separator', () => {
      expect(prefixOf('boat/docker')).toBe('boat_docker');
      expect(prefixOf('  spaced  ')).toBe('spaced');
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
