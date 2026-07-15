# Security model

## Equivalent host authority

Code Mode is not a security sandbox. Generated JavaScript has the same filesystem, network, environment, process, and child-process authority as the `pi-code-mode-mcp` Node process. `node:vm` is used for context creation and synchronous timeout interruption only.

This is deliberate: adding a Code Mode-only capability sandbox would not constrain an agent that already has equivalent unrestricted authority through its surrounding Pi tools.

Run Pi and this server inside the operating-system, container, account, and credential boundary you intend the agent to have.

## Fault containment

The standalone stdio process keeps malformed generated code out of the Pi process. Synchronous loops are interrupted by `node:vm`; async code receives cancellation through `signal` and nested MCP calls. If an async continuation blocks the event loop, the outer MCP client must terminate and restart the server process.

No disposable process or isolate is created per execution. That may change only if operational evidence shows the stdio boundary is insufficient.

## Protocol decisions

- Elicitation responses come from the outer client. Missing support or failed interaction returns `cancel`, never an invented `accept` or `decline`.
- Sampling and roots are forwarded only when advertised by the outer client.
- Nested cancellation and progress are preserved.
- Upstream tool errors remain inspectable MCP results; transport and execution failures return structured error output.

## Data handling

The server does not automatically persist:

- tool arguments or results;
- screenshots or app state;
- generated code;
- console output;
- intermediate values;
- in-memory session values.

Text truncation is in memory and never spills full output to disk.

Authorization-code OAuth requires a loopback callback. OAuth tokens, dynamic client registration, PKCE verifiers, and discovery metadata are persisted as mode-0600 files under the configured state directory. Config files may themselves reference secrets; keep them private and prefer environment expansion.

Standard output is reserved for MCP. The server writes fatal diagnostics to standard error without config contents, credentials, generated code, or tool payloads.

## Reporting

Do not include credentials, private tool output, screenshots, generated code containing secrets, or OAuth authorization URLs in public reports. Report implementation vulnerabilities through the repository's private security-reporting channel when available.
