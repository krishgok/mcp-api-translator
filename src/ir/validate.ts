/**
 * Validation gate between parsing and emission.
 *
 * Parsers translate untrusted specs into an {@link ApiModel}; emitters then trust that model
 * completely (they interpolate parts of it into generated source). This gate enforces the
 * structural invariants emitters rely on, so a parser bug or a hostile spec fails loudly here
 * with a clear message instead of producing broken — or unsafe — generated code downstream.
 */
import type { ApiModel } from "./model.js";

const HTTP_METHODS = new Set(["GET", "PUT", "POST", "DELETE", "PATCH", "OPTIONS", "HEAD", "TRACE"]);
const PARAM_LOCATIONS = new Set(["path", "query", "header", "cookie"]);
const SCHEME_TYPES = new Set(["apiKey", "http", "oauth2", "openIdConnect", "mutualTLS"]);
/** Tool names are used verbatim as JS identifiers and file names in generated projects. */
const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TOOL_NAME_LENGTH = 64;

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect every structural problem with a parsed model. Empty result == valid. */
export function validateApiModel(model: ApiModel): string[] {
  const issues: string[] = [];

  if (typeof model.title !== "string" || model.title.trim() === "") {
    issues.push("title must be a non-empty string");
  }
  if (typeof model.version !== "string") {
    issues.push("version must be a string");
  }
  if (!Array.isArray(model.servers)) {
    issues.push("servers must be an array");
  } else {
    model.servers.forEach((s, i) => {
      if (typeof s !== "string" || s.trim() === "")
        issues.push(`servers[${i}] must be a non-empty string`);
    });
  }

  if (!Array.isArray(model.securitySchemes)) {
    issues.push("securitySchemes must be an array");
  } else {
    model.securitySchemes.forEach((s, i) => {
      const at = `securitySchemes[${i}]`;
      if (!s || typeof s.name !== "string" || s.name === "")
        issues.push(`${at}.name must be a non-empty string`);
      if (!SCHEME_TYPES.has(s?.type))
        issues.push(`${at}.type "${s?.type}" is not a known security scheme type`);
      if (!Array.isArray(s?.envVars) || s.envVars.length === 0) {
        issues.push(`${at}.envVars must be a non-empty array`);
      } else if (!s.envVars.every((v) => typeof v === "string" && v !== "")) {
        issues.push(`${at}.envVars must contain only non-empty strings`);
      }
    });
  }

  if (!Array.isArray(model.operations)) {
    issues.push("operations must be an array");
  } else {
    model.operations.forEach((op, i) => {
      const at = `operations[${i}]`;
      if (typeof op?.toolName !== "string" || !TOOL_NAME_RE.test(op.toolName)) {
        issues.push(
          `${at}.toolName "${op?.toolName}" is not a valid identifier (^[A-Za-z_][A-Za-z0-9_]*$)`,
        );
      } else if (op.toolName.length > MAX_TOOL_NAME_LENGTH) {
        issues.push(`${at}.toolName exceeds ${MAX_TOOL_NAME_LENGTH} characters`);
      }
      if (typeof op?.method !== "string" || !HTTP_METHODS.has(op.method)) {
        issues.push(`${at}.method "${op?.method}" is not a supported HTTP method`);
      }
      if (typeof op?.path !== "string" || !op.path.startsWith("/")) {
        issues.push(`${at}.path "${op?.path}" must be a string starting with "/"`);
      }
      if (!Array.isArray(op?.parameters)) {
        issues.push(`${at}.parameters must be an array`);
      } else {
        op.parameters.forEach((p, j) => {
          const pat = `${at}.parameters[${j}]`;
          if (typeof p?.name !== "string" || p.name === "")
            issues.push(`${pat}.name must be a non-empty string`);
          if (!PARAM_LOCATIONS.has(p?.in))
            issues.push(`${pat}.in "${p?.in}" is not a valid parameter location`);
          if (!isPlainObject(p?.schema)) issues.push(`${pat}.schema must be an object`);
        });
      }
      if (op?.requestBody !== undefined && !isPlainObject(op.requestBody?.schema)) {
        issues.push(`${at}.requestBody.schema must be an object`);
      }
      if (!Array.isArray(op?.security)) {
        issues.push(`${at}.security must be an array`);
      }
    });
  }

  return issues;
}

/** Throw a single, aggregated error if the model violates any emitter invariant. */
export function assertValidApiModel(model: ApiModel): void {
  const issues = validateApiModel(model);
  if (issues.length > 0) {
    throw new Error(
      `Parsed API model failed validation:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
    );
  }
}
