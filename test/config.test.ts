import { ConfigError, normalizeConfig, type RawConfig } from '../src/config';

const validInstance = {
  name: 'local',
  host: 'localhost',
  apiKey: 'ptr_token',
};

describe('normalizeConfig', () => {
  it('builds a base URL from protocol, host, port and base path', () => {
    const config = normalizeConfig({
      instances: [{ ...validInstance, protocol: 'http', port: 9000, basePath: '/portainer/' }],
    });
    expect(config.instances[0]?.baseUrl).toBe('http://localhost:9000/portainer');
  });

  it('defaults to https on 9443', () => {
    const config = normalizeConfig({ instances: [validInstance] });
    expect(config.instances[0]?.baseUrl).toBe('https://localhost:9443');
  });

  it('defaults to port 9000 for plain http', () => {
    const config = normalizeConfig({ instances: [{ ...validInstance, protocol: 'http' }] });
    expect(config.instances[0]?.baseUrl).toBe('http://localhost:9000');
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

  it('rejects an invalid port and an implausible timeout', () => {
    expect(() => normalizeConfig({ instances: [{ ...validInstance, port: 70000 }] })).toThrow(
      /invalid port/,
    );
    expect(() => normalizeConfig({ instances: [{ ...validInstance, timeoutMs: 10 }] })).toThrow(
      /at least 1000 ms/,
    );
  });

  it('rejects a base path that is not rooted', () => {
    expect(() =>
      normalizeConfig({ instances: [{ ...validInstance, basePath: 'portainer' }] }),
    ).toThrow(/must start with/);
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
      instances: [{ ...validInstance, rejectUnauthorized: false, caCert: 'PEM', servername: 'pi' }],
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
});
