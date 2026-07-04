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
