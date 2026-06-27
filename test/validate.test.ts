import { describe, it, expect } from "vitest";
import type { ApiModel } from "../src/ir/model.js";
import { validateApiModel, assertValidApiModel } from "../src/ir/validate.js";

function baseModel(): ApiModel {
  return {
    title: "Test API",
    version: "1.0.0",
    servers: ["https://api.example.com"],
    securitySchemes: [{ name: "apiKey", type: "apiKey", in: "header", envVars: ["API_KEY"] }],
    operations: [
      {
        toolName: "getThing",
        method: "GET",
        path: "/things/{id}",
        tags: [],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        security: ["apiKey"],
      },
    ],
    sourceFormat: "openapi",
  };
}

describe("validateApiModel", () => {
  it("accepts a well-formed model", () => {
    expect(validateApiModel(baseModel())).toEqual([]);
    expect(() => assertValidApiModel(baseModel())).not.toThrow();
  });

  it("rejects a tool name that is not a valid identifier", () => {
    const m = baseModel();
    m.operations[0]!.toolName = "1bad-name";
    const issues = validateApiModel(m);
    expect(issues.some((i) => i.includes("toolName"))).toBe(true);
  });

  it("rejects an unsupported HTTP method and a path without a leading slash", () => {
    const m = baseModel();
    m.operations[0]!.method = "FETCH";
    m.operations[0]!.path = "things";
    const issues = validateApiModel(m);
    expect(issues.some((i) => i.includes("method"))).toBe(true);
    expect(issues.some((i) => i.includes("path"))).toBe(true);
  });

  it("rejects a bad parameter location and a non-object schema", () => {
    const m = baseModel();
    // @ts-expect-error intentionally invalid
    m.operations[0]!.parameters[0]!.in = "body";
    // @ts-expect-error intentionally invalid
    m.operations[0]!.parameters[0]!.schema = null;
    const issues = validateApiModel(m);
    expect(issues.some((i) => i.includes(".in"))).toBe(true);
    expect(issues.some((i) => i.includes(".schema"))).toBe(true);
  });

  it("rejects a security scheme with no env vars", () => {
    const m = baseModel();
    m.securitySchemes[0]!.envVars = [];
    expect(() => assertValidApiModel(m)).toThrow(/envVars/);
  });
});
