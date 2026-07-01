# Security Policy

## Reporting a Vulnerability

Please do **not** file public GitHub issues for security vulnerabilities.

Report suspected vulnerabilities privately via GitHub Security Advisories:
<https://github.com/krishgok/mcp-api-translator/security/advisories/new>

You should expect an initial acknowledgement within 5 business days. Once a
fix is available, we will publish a security advisory crediting the reporter
(unless anonymity is requested).

## Scope

In scope:

- The `mcp-api-translator` MCP server itself (this repository).
- Code emitted by the generator when run against a trusted spec.

Out of scope:

- Vulnerabilities that only manifest when the generator is run against a
  deliberately malicious API spec — the [Security & trust model](README.md#security--trust-model)
  section of the README describes what is and is not defended against.
- Vulnerabilities in upstream dependencies — please report those to the
  respective projects.

## Supported Versions

Only the latest minor release on npm receives security fixes.
