import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseSource } from "../src/parsers/index.js";

const fixtures = path.dirname(fileURLToPath(import.meta.url)) + "/fixtures";

describe("OpenAPI parser", () => {
  it("extracts operations, servers, auth, and normalizes 3.0 nullable", async () => {
    const model = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });

    expect(model.sourceFormat).toBe("openapi");
    expect(model.title).toBe("Swagger Petstore");
    expect(model.servers).toEqual(["https://petstore.example.com/v1"]);

    const ops: Record<string, (typeof model.operations)[number]> = Object.fromEntries(
      model.operations.map((o) => [o.operationId, o]),
    );
    expect(Object.keys(ops).sort()).toEqual(["createPet", "getPetById", "listPets"]);

    expect(ops.getPetById!.method).toBe("GET");
    expect(ops.getPetById!.parameters.find((p) => p.in === "path")?.name).toBe("petId");

    // every operation inherits the root security requirement
    expect(ops.listPets!.security).toEqual(["apiKey"]);

    // 3.0 nullable -> JSON Schema 2020-12 type union
    const tag = (ops.createPet!.requestBody!.schema as any).properties.tag;
    expect(tag.type).toEqual(["string", "null"]);
    expect(tag.nullable).toBeUndefined();

    expect(model.securitySchemes[0]).toMatchObject({
      name: "apiKey",
      type: "apiKey",
      in: "header",
      paramName: "X-API-Key",
      envVars: ["API_KEY"],
    });
  });

  it("detects the client-credentials grant on a clientCredentials flow", async () => {
    const model = await parseSource({ specPath: `${fixtures}/oauth.openapi.yaml` });
    expect(model.securitySchemes[0]).toMatchObject({
      name: "oauthCc",
      type: "oauth2",
      tokenUrl: "https://widgets.example.com/oauth/token",
      grant: "client_credentials",
      envVars: ["API_CLIENT_ID", "API_CLIENT_SECRET"],
    });
  });

  it("detects the refresh-token grant on an authorizationCode flow (with API_TOKEN fallback)", async () => {
    const model = await parseSource({ specPath: `${fixtures}/oauth-refresh.openapi.yaml` });
    expect(model.securitySchemes[0]).toMatchObject({
      name: "oauthAc",
      type: "oauth2",
      tokenUrl: "https://gadgets.example.com/oauth/token",
      grant: "refresh_token",
      envVars: ["API_CLIENT_ID", "API_CLIENT_SECRET", "API_REFRESH_TOKEN", "API_TOKEN"],
    });
  });

  it("substitutes server variables with their declared defaults", async () => {
    const model = await parseSource({ specPath: `${fixtures}/server-vars.openapi.yaml` });
    expect(model.servers).toEqual([
      // both placeholders resolved from `variables[*].default`
      "http://HOSTNAME/api/v3",
      // declared variable resolved; undeclared one left intact rather than blanked
      "https://eu-west-1.example.com/{undeclared}",
      // no variables block: untouched
      "https://static.example.com/v1",
    ]);

    // only the first server's variables are recorded — that URL is the one that becomes the
    // generated project's default API_BASE_URL, so it is the one worth reporting.
    //
    // protocol resolves to http rather than https because that is what the fixture declares,
    // mirroring the real GitHub Enterprise Server description. The parser must not second-guess
    // a declared default; the enum below is what tells the reader https is also allowed.
    expect(model.serverVariables).toEqual({
      protocol: { default: "http", enum: ["http", "https"] },
      hostname: { default: "HOSTNAME" },
    });
  });

  it("records no server variables when the URL is not templated", async () => {
    const model = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    expect(model.serverVariables).toBeUndefined();
  });

  it("does not blow the stack on a self-referential schema", async () => {
    // Specs are dereferenced before normalization, so a self-$ref (Gmail's MessagePart.parts[]
    // -> MessagePart is the real-world case) arrives as a cyclic object graph.
    const spec = {
      openapi: "3.0.3",
      info: { title: "Recursive", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/parts": {
          post: {
            operationId: "createPart",
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Part" } },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        schemas: {
          Part: {
            type: "object",
            properties: {
              filename: { type: "string" },
              parts: { type: "array", items: { $ref: "#/components/schemas/Part" } },
            },
          },
        },
      },
    };

    const model = await parseSource({ spec: JSON.stringify(spec), format: "openapi" });
    const body = model.operations[0]!.requestBody!.schema as any;

    expect(body.properties.filename.type).toBe("string");
    // the cycle is cut, keeping the declared type as a hint
    expect(body.properties.parts.items).toEqual({ type: "object" });
    // and the result must be serializable -- generated tool files embed it via JSON.stringify
    expect(() => JSON.stringify(body)).not.toThrow();
  });

  it("prefers client_credentials when a scheme declares several flows", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Multi", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/x": { get: { operationId: "getX", responses: { "200": { description: "ok" } } } },
      },
      components: {
        securitySchemes: {
          oauth: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://a/authorize",
                tokenUrl: "https://a/ac-token",
                scopes: {},
              },
              clientCredentials: { tokenUrl: "https://a/cc-token", scopes: {} },
            },
          },
        },
      },
    };
    const model = await parseSource({ spec: JSON.stringify(spec), format: "openapi" });
    expect(model.securitySchemes[0]).toMatchObject({
      tokenUrl: "https://a/cc-token",
      grant: "client_credentials",
    });
  });
});

describe("Postman parser", () => {
  it("walks folders, infers body schema, and maps bearer auth", async () => {
    const model = await parseSource({ specPath: `${fixtures}/echo.postman.json` });

    expect(model.sourceFormat).toBe("postman");
    expect(model.title).toBe("Echo API");

    const byPath = model.operations.map((o) => `${o.method} ${o.path}`).sort();
    expect(byPath).toEqual(["GET /users", "GET /users/{userId}", "POST /users"]);

    const getUser = model.operations.find((o) => o.path === "/users/{userId}")!;
    expect(getUser.parameters.find((p) => p.in === "path")?.name).toBe("userId");
    expect(getUser.tags).toContain("Users by id");

    const createUser = model.operations.find((o) => o.method === "POST")!;
    const schema = createUser.requestBody!.schema as any;
    expect(schema.type).toBe("object");
    expect(schema.properties.name.type).toBe("string");
    expect(schema.properties.age.type).toBe("integer");

    expect(model.securitySchemes[0]).toMatchObject({
      name: "bearerAuth",
      type: "http",
      scheme: "bearer",
    });
  });

  it("coerces a Postman `{ content }` description object to a string", async () => {
    const spec = {
      info: {
        name: "Desc API",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        {
          name: "Ping",
          request: {
            method: "GET",
            url: { raw: "{{u}}/ping", path: ["ping"] },
            description: { content: "Ping the server", type: "text/markdown" },
          },
        },
      ],
    };
    const model = await parseSource({ spec: JSON.stringify(spec), format: "postman" });
    expect(model.operations[0]!.description).toBe("Ping the server");
  });
});
