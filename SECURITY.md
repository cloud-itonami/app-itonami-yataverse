# Security

- Secrets (`sa-token`, `auth`) are read only from 0600 files or the environment, and are never
  printed, logged or returned by the CLI, `status`, or any MCP tool. `yataverse token` prints a
  short-lived Authorization value on purpose (for another tool's `auth-cmd`); treat its output as a secret.
- Writes never follow redirects; reads follow only same-parent-domain https redirects.
- The service-account secret is sent only to an allow-listed Authn host (`auth.kotoba.cloud`) over https.
- The auth command is executed as an argv array without a shell.

Report issues privately to the maintainers of kotoba-lang.
