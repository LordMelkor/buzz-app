import { describe, expect, it } from "vitest";
import {
  GatewayDescriptorError,
  type GatewayDescriptor,
  parseGatewayDescriptor,
  PROTECTED_HEADERS,
} from "./descriptor";
import VECTORS from "./descriptor-vectors.json";

type Case = { name: string; raw?: string; descriptor?: unknown };
const input = ({ raw, descriptor }: Case) => raw ?? JSON.stringify(descriptor);
/** What native compiles from a valid descriptor: the fields it enforces,
 * with only the upstreams of the harnesses it forwards. */
const nativeSubset = (descriptor: GatewayDescriptor) => ({
  gateway: descriptor.gateway,
  launcher_client: descriptor.launcher_client,
  headers: descriptor.headers,
  reserved_prefixes: descriptor.reserved_prefixes,
  upstreams: Object.fromEntries(
    Object.entries(descriptor.upstreams).filter(([key]) =>
      ["claude-code", "goose"].includes(key),
    ),
  ),
});
/** Every string value in a value, at any depth (not its keys, which the
 * fixed messages name). */
const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : typeof value === "object" && value !== null
      ? Object.values(value).flatMap(strings)
      : [];

describe("parseGatewayDescriptor", () => {
  it("holds the protected headers the shared vectors pin", () => {
    expect(PROTECTED_HEADERS).toEqual(VECTORS.protected);
  });

  it.each(VECTORS.off)("is off: $name", (vector) => {
    expect(parseGatewayDescriptor(input(vector))).toBeNull();
  });

  it.each(VECTORS.valid)("accepts $name", (vector) => {
    const parsed = parseGatewayDescriptor(input(vector));
    expect(parsed).toEqual(vector.expect);
    expect(parsed && nativeSubset(parsed)).toEqual(vector.expect_native);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each(VECTORS.invalid)("refuses $name as $error", (vector) => {
    let error: unknown;
    try {
      parseGatewayDescriptor(input(vector));
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(GatewayDescriptorError);
    expect((error as GatewayDescriptorError).code).toBe(vector.error);
    const message = (error as Error).message;
    expect(message).toMatch(/^BUZZ_AGENT_GATEWAY is invalid: /);
    // Fixed per code: no configured value is echoed.
    for (const value of strings(vector.descriptor ?? vector.raw))
      if (value.length > 3)
        expect(message.toLowerCase()).not.toContain(value.toLowerCase());
  });
});
