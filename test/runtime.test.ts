import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseSource } from "../src/parsers/index.js";
import { executePlan, type FetchLike } from "../src/runtime/client.js";
import { ApiProxy } from "../src/runtime/server.js";
import { parseServeArgs } from "../src/runtime/cli.js";
import { clearTokenCache } from "../src/runtime/oauth.js";
import type { RequestPlanData } from "../src/emitters/templates.js";

const fixtures = path.dirname(fileURLToPath(import.meta.url)) + "/fixtures";

/** A fetch stub that records the last request and returns a canned response. */
function recorder(status = 200, bodyText = "{}") {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "ERR",
      text: async () => bodyText,
    };
  };
  return { calls, fetchImpl };
}

describe("executePlan", () => {
  const plan: RequestPlanData = {
    method: "GET",
    pathTemplate: "/pets/{petId}",
    pathParams: ["petId"],
    queryParams: ["limit"],
    headerParams: [],
    cookieParams: [],
    bodyParam: null,
    contentType: null,
    security: ["apiKey"],
  };

  it("substitutes path params (encoded), adds query, and injects apiKey header from env", async () => {
    const { calls, fetchImpl } = recorder(200, '{"ok":true}');
    const out = await executePlan(
      plan,
      { petId: "a/b c", limit: 5 },
      {
        baseUrl: "https://api.example.com/v1",
        securitySchemes: [
          {
            name: "apiKey",
            type: "apiKey",
            in: "header",
            paramName: "X-API-Key",
            envVars: ["API_KEY"],
          },
        ],
        env: { API_KEY: "secret123" },
      },
      fetchImpl,
    );
    expect(out).toBe('{"ok":true}');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example.com/v1/pets/a%2Fb%20c?limit=5");
    expect(calls[0]!.headers["X-API-Key"]).toBe("secret123");
  });

  it("omits the credential when the env var is unset", async () => {
    const { calls, fetchImpl } = recorder();
    await executePlan(
      plan,
      { petId: "1" },
      {
        baseUrl: "https://api.example.com",
        securitySchemes: [
          {
            name: "apiKey",
            type: "apiKey",
            in: "header",
            paramName: "X-API-Key",
            envVars: ["API_KEY"],
          },
        ],
        env: {},
      },
      fetchImpl,
    );
    expect(calls[0]!.headers["X-API-Key"]).toBeUndefined();
  });

  it("throws with status and body on a non-2xx response", async () => {
    const { fetchImpl } = recorder(404, "not found");
    await expect(
      executePlan(
        plan,
        { petId: "1" },
        { baseUrl: "https://api.example.com", securitySchemes: [], env: {} },
        fetchImpl,
      ),
    ).rejects.toThrow(/HTTP 404 .*not found/);
  });

  it("requires a base URL", async () => {
    const { fetchImpl } = recorder();
    await expect(
      executePlan(plan, { petId: "1" }, { baseUrl: "", securitySchemes: [], env: {} }, fetchImpl),
    ).rejects.toThrow(/base URL is not set/);
  });
});

describe("ApiProxy", () => {
  it("mounts a spec, lists its tools, and executes one against the upstream", async () => {
    const model = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    const proxy = new ApiProxy();
    const result = proxy.mount(model);
    expect(result.mounted).toBe(3);
    expect(
      proxy
        .listTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["createPet", "getPetById", "listPets"]);
    // Each tool advertises a raw JSON-Schema input.
    expect(proxy.listTools()[0]!.inputSchema).toMatchObject({ type: "object" });

    const { calls, fetchImpl } = recorder(200, '{"id":7}');
    const out = await proxy.call("getPetById", { petId: 7 }, { API_KEY: "k" }, fetchImpl);
    expect(out).toBe('{"id":7}');
    expect(calls[0]!.url).toContain("/pets/7");
    expect(calls[0]!.headers["X-API-Key"]).toBe("k");
  });

  it("honors API_BASE_URL as a runtime override of the spec server", async () => {
    const model = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    const proxy = new ApiProxy();
    proxy.mount(model);
    const { calls, fetchImpl } = recorder();
    await proxy.call("listPets", {}, { API_BASE_URL: "https://staging.local" }, fetchImpl);
    expect(calls[0]!.url.startsWith("https://staging.local/")).toBe(true);
  });

  it("aggregates multiple APIs and dedupes tool names across mounts", async () => {
    const petstore = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    const echo = await parseSource({ specPath: `${fixtures}/echo.postman.json` });
    const proxy = new ApiProxy();
    const a = proxy.mount(petstore);
    const b = proxy.mount(echo);
    expect(proxy.size).toBe(a.mounted + b.mounted);
    // No name collisions across the two mounted APIs.
    expect(new Set(proxy.listTools().map((t) => t.name)).size).toBe(proxy.size);
  });
});

describe("per-API auth namespacing", () => {
  const plan: RequestPlanData = {
    method: "GET",
    pathTemplate: "/x",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    cookieParams: [],
    bodyParam: null,
    contentType: null,
    security: ["apiKey"],
  };
  const schemes = [
    {
      name: "apiKey",
      type: "apiKey" as const,
      in: "header" as const,
      paramName: "X-API-Key",
      envVars: ["API_KEY"],
    },
  ];

  it("prefers the namespaced credential over the bare one", async () => {
    const { calls, fetchImpl } = recorder();
    await executePlan(
      plan,
      {},
      {
        baseUrl: "https://h",
        securitySchemes: schemes,
        env: { PETSTORE_API_KEY: "ns", API_KEY: "bare" },
        sourceNamespace: "PETSTORE",
      },
      fetchImpl,
    );
    expect(calls[0]!.headers["X-API-Key"]).toBe("ns");
  });

  it("falls back to the bare credential when the namespaced one is unset", async () => {
    const { calls, fetchImpl } = recorder();
    await executePlan(
      plan,
      {},
      {
        baseUrl: "https://h",
        securitySchemes: schemes,
        env: { API_KEY: "bare" },
        sourceNamespace: "PETSTORE",
      },
      fetchImpl,
    );
    expect(calls[0]!.headers["X-API-Key"]).toBe("bare");
  });

  it("routes each aggregated API to its own base URL via <NS>_API_BASE_URL", async () => {
    const petstore = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    const echo = await parseSource({ specPath: `${fixtures}/echo.postman.json` });
    const proxy = new ApiProxy();
    proxy.mount(petstore);
    const echoMount = proxy.mount(echo);
    const env = {
      SWAGGER_PETSTORE_API_BASE_URL: "https://pets.local",
      ECHO_API_API_BASE_URL: "https://echo.local",
    };

    const pets = recorder();
    await proxy.call("listPets", {}, env, pets.fetchImpl);
    expect(pets.calls[0]!.url.startsWith("https://pets.local/")).toBe(true);

    const echoTool = echoMount.toolNames[0]!;
    const ech = recorder();
    await proxy.call(echoTool, {}, env, ech.fetchImpl);
    expect(ech.calls[0]!.url.startsWith("https://echo.local/")).toBe(true);
  });

  it("reports the source namespace and per-source env vars from mount()", async () => {
    const petstore = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    const proxy = new ApiProxy();
    const res = proxy.mount(petstore);
    expect(res.sourceNamespace).toBe("SWAGGER_PETSTORE");
    expect(res.envVars).toContain("SWAGGER_PETSTORE_API_BASE_URL");
    expect(res.envVars).toContain("SWAGGER_PETSTORE_API_KEY");
  });
});

describe("oauth client-credentials", () => {
  const scheme = {
    name: "oauthCc",
    type: "oauth2" as const,
    tokenUrl: "https://auth.example/token",
    envVars: ["API_CLIENT_ID", "API_CLIENT_SECRET"],
  };
  const plan: RequestPlanData = {
    method: "GET",
    pathTemplate: "/w",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    cookieParams: [],
    bodyParam: null,
    contentType: null,
    security: ["oauthCc"],
  };

  /** A fetch stub that answers the token endpoint and records API requests separately. */
  function oauthIo() {
    const tokenBodies: (string | undefined)[] = [];
    const apiCalls: Array<{ url: string; auth?: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.toString().includes("/token")) {
        tokenBodies.push(init.body);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ access_token: "tok-123", expires_in: 3600 }),
        };
      }
      apiCalls.push({ url: url.toString(), auth: init.headers["authorization"] });
      return { ok: true, status: 200, statusText: "OK", text: async () => "{}" };
    };
    return { tokenBodies, apiCalls, fetchImpl };
  }

  it("fetches a bearer token via client-credentials and caches it", async () => {
    clearTokenCache();
    const io = oauthIo();
    const ctx = {
      baseUrl: "https://api.example",
      securitySchemes: [scheme],
      env: { API_CLIENT_ID: "id", API_CLIENT_SECRET: "secret" },
    };
    await executePlan(plan, {}, ctx, io.fetchImpl);
    await executePlan(plan, {}, ctx, io.fetchImpl);
    expect(io.apiCalls.map((c) => c.auth)).toEqual(["Bearer tok-123", "Bearer tok-123"]);
    expect(io.tokenBodies).toHaveLength(1); // second call served from cache
    expect(io.tokenBodies[0]).toContain("grant_type=client_credentials");
    expect(io.tokenBodies[0]).toContain("client_id=id");
  });

  it("skips auth when the client id/secret are unset", async () => {
    clearTokenCache();
    const io = oauthIo();
    await executePlan(
      plan,
      {},
      { baseUrl: "https://api.example", securitySchemes: [scheme], env: {} },
      io.fetchImpl,
    );
    expect(io.apiCalls[0]!.auth).toBeUndefined();
    expect(io.tokenBodies).toHaveLength(0);
  });
});

describe("parseServeArgs", () => {
  it("parses specs and filters", () => {
    const args = parseServeArgs([
      "--spec",
      "a.yaml",
      "--spec",
      "b.json",
      "--methods",
      "GET,POST",
      "--include-tag",
      "pets",
      "--path-glob",
      "/v1/**",
    ]);
    expect(args.specs).toEqual(["a.yaml", "b.json"]);
    expect(args.filters.methods).toEqual(["GET", "POST"]);
    expect(args.filters.includeTags).toEqual(["pets"]);
    expect(args.filters.pathGlob).toBe("/v1/**");
  });

  it("requires at least one --spec", () => {
    expect(() => parseServeArgs([])).toThrow(/requires at least one --spec/);
  });

  it("rejects an unknown option", () => {
    expect(() => parseServeArgs(["--nope"])).toThrow(/Unknown serve option/);
  });
});
