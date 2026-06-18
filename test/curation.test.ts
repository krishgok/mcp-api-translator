import { describe, it, expect } from "vitest";
import { sanitizeToolName, uniqueToolName, nameFromMethodPath } from "../src/curation/naming.js";
import { applyFilters } from "../src/curation/filter.js";
import type { Operation } from "../src/ir/model.js";

function op(over: Partial<Operation>): Operation {
  return {
    toolName: "x",
    method: "GET",
    path: "/x",
    tags: [],
    parameters: [],
    security: [],
    ...over,
  };
}

describe("naming", () => {
  it("sanitizes and bounds names", () => {
    expect(sanitizeToolName("Get Pet/By Id!")).toBe("Get_Pet_By_Id");
    expect(sanitizeToolName("123abc")).toBe("op_123abc");
    expect(sanitizeToolName("")).toBe("operation");
  });

  it("derives names from method+path", () => {
    expect(nameFromMethodPath("GET", "/pets/{petId}")).toBe("get_pets_by_petId");
  });

  it("de-duplicates deterministically", () => {
    const taken = new Set<string>();
    expect(uniqueToolName("get", taken)).toBe("get");
    expect(uniqueToolName("get", taken)).toBe("get_2");
    expect(uniqueToolName("get", taken)).toBe("get_3");
  });
});

describe("filters", () => {
  const ops = [
    op({ method: "GET", path: "/pets", tags: ["pets"], operationId: "listPets" }),
    op({ method: "POST", path: "/pets", tags: ["pets"], operationId: "createPet" }),
    op({ method: "GET", path: "/admin/stats", tags: ["admin"], operationId: "stats" }),
  ];

  it("filters by method", () => {
    expect(applyFilters(ops, { methods: ["get"] }).map((o) => o.operationId)).toEqual([
      "listPets",
      "stats",
    ]);
  });

  it("filters by tag and path glob and exclusion", () => {
    expect(applyFilters(ops, { includeTags: ["pets"] }).length).toBe(2);
    expect(applyFilters(ops, { pathGlob: "/admin/**" }).map((o) => o.operationId)).toEqual([
      "stats",
    ]);
    expect(applyFilters(ops, { excludeOperations: ["createPet"] }).length).toBe(2);
  });
});
