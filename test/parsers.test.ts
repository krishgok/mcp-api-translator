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
});
