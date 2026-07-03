# Licensing

`mcp-api-translator` is **dual-licensed**. You may use it under **either** of the licenses below.

> This document explains the licensing model in plain language. It is not legal advice, and the
> plain-language summaries are subordinate to the actual license texts. For commercial terms, a
> signed agreement governs.

## 1. Open-source license — GNU AGPL-3.0-or-later

The source code is offered under the **GNU Affero General Public License, version 3 or later**
([LICENSE](LICENSE)). Key obligation to be aware of:

- If you **modify** `mcp-api-translator` and **run it to provide a service over a network**, the
  AGPL requires you to make the **complete corresponding source** of your modified version available
  to the users of that service, under the AGPL.

If that obligation works for you (e.g. internal use, open-source projects, or you're happy to share
your modifications), the AGPL is free to use — no need to contact anyone.

## 2. Commercial license

If you **cannot or do not want to comply with the AGPL** — for example, you want to:

- embed `mcp-api-translator` in a **proprietary or closed-source** product,
- offer it as part of a **hosted/SaaS** product without releasing your modifications, or
- receive **warranty, indemnity, or support** terms,

then a separate **commercial license** is available that removes the AGPL's copyleft obligations.

**Contact for commercial licensing:** `licensing@` your domain (replace with a real address, e.g.
open a GitHub issue titled "Commercial license inquiry" or email the maintainer).

## 3. Generated-output exception

**Code produced by running this tool is yours.**

When you use `mcp-api-translator` to generate an MCP-server project, the emitted files necessarily
contain small, standard code fragments copied from this project's templates. As an explicit,
irrevocable exception to the AGPL:

> The copyright holders grant every user an unlimited, irrevocable, royalty-free license to use,
> modify, and distribute the **Generated Output** (including any template-derived code it contains)
> under terms of the user's choosing. Generated Output is **not** considered a derivative work of
> `mcp-api-translator` for the purposes of the AGPL, and the AGPL's copyleft obligations do **not**
> extend to it.

This exception applies **only** to the output of the tool. It grants no rights in
`mcp-api-translator`'s own source code, which remains under the AGPL (Section 1) or a commercial
license (Section 2). Running the tool as a service still falls under Section 1/2 for the tool
itself; only the _generated project files_ are exempted.

## SPDX

The npm-published package declares `AGPL-3.0-or-later` in its `license` field. The commercial option
is offered separately and is not expressed as an SPDX identifier on the public artifact.
