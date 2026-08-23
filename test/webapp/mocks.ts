/**
 * Types for the mocks the panel tests install.
 *
 * A bare `jest.fn()` is a `jest.Mock<any, any>`, so every assertion made about
 * what it was called with — `mock.calls[0]?.[0]` — reads an `any` and is
 * checked by nothing. Declaring the call signature is what makes those
 * assertions mean something, and it is the difference between a test that
 * would notice a changed request and one that only looks like it would.
 */
export type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit?]>;

/** The `RequestInit` a call was made with, for tests that assert on the body. */
export const initOf = (call: [string, RequestInit?] | undefined): RequestInit => call?.[1] ?? {};

/** A request body as the test wrote it: these tests only ever send JSON strings. */
export const bodyOf = (call: [string, RequestInit?] | undefined): string =>
  typeof initOf(call).body === 'string' ? (initOf(call).body as string) : '';

/**
 * A stand-in Response.
 *
 * The panel reads `ok`, `status` and `json()` and nothing else, so a fixture
 * carrying those is the whole of what a test needs — but `mockResolvedValue`
 * asks for a Response, and the twelve members it is missing would each have to
 * be invented. This says that gap is deliberate, in one place.
 */
export const asResponse = (partial: Record<string, unknown>): Response =>
  partial as unknown as Response;

/** A `fetch` mock that remembers its calls under the type above. */
export const createFetchMock = (): FetchMock =>
  jest.fn<Promise<Response>, [string, RequestInit?]>();

/**
 * The JSON a request was sent with.
 *
 * `RequestInit['body']` is a union wide enough to include a Blob, so
 * `String(init.body)` is a stringification the rules rightly object to. These
 * tests only ever send a JSON string, and this says so once instead of at
 * every assertion.
 */
export const jsonBody = <T>(call: [string, RequestInit?] | undefined): T =>
  JSON.parse(bodyOf(call)) as T;
