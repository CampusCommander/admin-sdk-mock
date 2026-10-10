import type { Io } from './main.ts';

const CONTROL =
  '  --control <url>   The control API. Default: MOCK_CONTROL_URL, then ADMIN_SDK_MOCK_CONTROL, then http://127.0.0.1:8080.';
const HELP_FLAG = '  --help            Print this usage.';

/**
 * The usage of the CLI. The key '' holds the top-level usage, and each command name holds
 * that command's usage. docs/reference/cli.md is generated from these texts.
 */
export const HELP: Readonly<Record<string, string>> = {
  '': `Usage: admin-sdk-mock <command> [options]

Run a local mock of the Google Admin SDK, and control a running mock.

Server commands:
  start              Start the mock from a configuration and run until a signal.
  init               Write a starter configuration and print the next steps.
  env                Print the client environment of a running mock.
  doctor             Check Node.js, the configuration, the data directory, the CA file, and the ports.
  config validate    Validate a configuration file and print every error.

Control commands:
  token              Mint an access token for a domain user.
  domain             Create, list, show, reset, or delete domains.
  credential         Issue a service account key with delegated scopes.
  settings           Change the settings of a domain.
  quota              Show the quota state of a domain.
  fault              Add, list, or clear the fault rules of a domain.
  index              Flush the search index of a domain.
  clock              Show or change the time scale and the delay switch.
  ca                 Print or save the CA certificate.

Run admin-sdk-mock <command> --help for the options of a command.
Control commands reach --control, then MOCK_CONTROL_URL, then ADMIN_SDK_MOCK_CONTROL, then http://127.0.0.1:8080.
Exit codes: 0 for success, 1 for a runtime failure, 2 for invalid usage or configuration.
For mockctl compatibility, domain, credential, settings, quota, fault, index, clock, and ca exit 1
when a customer ID or option value is missing or invalid.`,

  start: `Usage: admin-sdk-mock start [options]

Start the listeners, ensure the configured domains, and run until SIGTERM or SIGINT.
The mock logs one JSON line per event to standard output.

Options:
  --config <file>          The configuration file. Default: MOCK_CONFIG, then ./admin-sdk-mock.json,
                           then MOCK_CONFIG_DEFAULT.
  --data-dir <dir>         The data directory. Default: ./data.
  --google-host <host>     The Google listener host. Default: 127.0.0.1.
  --google-port <port>     The Google listener port. Default: 8443. 0 picks a free port.
  --control-host <host>    The control listener host. Default: 127.0.0.1.
  --control-port <port>    The control listener port. Default: 8080. 0 picks a free port.
  --proxy-host <host>      The proxy listener host. Default: 127.0.0.1.
  --proxy-port <port>      The proxy listener port. This option turns the proxy on.
  --passthrough            Tunnel proxy targets other than the Google hostnames.
  --scale <n>              The time scale, from 1 to 100000. Default: 1.
  --delays <on|off>        Turn the modeled delays on or off. Default: on.
  --ca-file <file>         The CA certificate file. Default: <data dir>/ca/ca.pem.
  --ready-file <file>      The file that receives the ready event.
${HELP_FLAG}

Options override MOCK_* environment variables, which override the configuration file.
A configuration, fixtures, or seed specification error exits with code 2.`,

  init: `Usage: admin-sdk-mock init [options]

Write a starter configuration with one small domain, a proxy, and a read-write service account.
Then print the next steps.

Options:
  --out <file>      The configuration file to write. Default: admin-sdk-mock.json.
  --force           Replace an existing file.
${HELP_FLAG}`,

  env: `Usage: admin-sdk-mock env [options]

Ask a running mock for its listeners, then print the client environment.
The environment holds the proxy, the CA variables, NO_PROXY, and the control URL.

Options:
  --format <sh|dotenv|json|github>   The output format. Default: sh. github appends to $GITHUB_ENV.
  --control <url>                    The control API. Default: MOCK_CONTROL_URL, then ADMIN_SDK_MOCK_CONTROL,
                                     then the control listener of the configuration.
  --config <file>                    The configuration file that names the control listener.
${HELP_FLAG}

Load the environment into a shell with: eval "$(admin-sdk-mock env)"`,

  doctor: `Usage: admin-sdk-mock doctor [options]

Check the Node.js version, the configuration, the data directory, the CA file, and the listener ports.
Print a PASS or FAIL line for each check. Exit with code 1 when a check fails.

Options:
  --config <file>   The configuration file. Default: MOCK_CONFIG, then ./admin-sdk-mock.json,
                    then MOCK_CONFIG_DEFAULT.
${HELP_FLAG}`,

  config: `Usage: admin-sdk-mock config validate <file>

Validate a configuration file and its fixtures files, and print every error.
Exit with code 2 when the file is not valid.

Options:
${HELP_FLAG}`,

  token: `Usage: admin-sdk-mock token <customerId> [options]

Mint an access token for a domain user without the OAuth token exchange.
Print the token response as JSON.

Options:
  --subject <email>                The user the token acts for. Default: the domain administrator.
  --scopes <read|read-write|a,b>   The scope set or a comma-separated scope list. Default: read-write.
  --ttl <seconds>                  The token lifetime, from 1 to 3600 seconds. Default: 3600.
  --raw                            Print only the access token.
${CONTROL}
${HELP_FLAG}`,

  domain: `Usage: admin-sdk-mock domain <create|list|show|reset|delete> [options]

Create, list, show, reset, or delete the domains of a running mock.

Commands:
  domain create --tier <tier> --seed <seed> [options]   Seed a new domain.
  domain list                                           List the domains with their entity counts.
  domain show <customerId>                              Show the record of a domain.
  domain reset <customerId>                             Seed a domain again from its specification.
  domain delete <customerId>                            Delete a domain and its data.

Options for create:
  --tier <small|medium|large|xlarge|empty>   The size tier.
  --seed <seed>                              The seed: 1 to 64 letters, digits, hyphens, or underscores.
  --name <name>                              The district name. Default: a name derived from the seed.
  --layout <role-first|school-first>         The organizational unit layout.
  --counts <json>                            Count overrides, for example {"students":30}.
  --rates <json>                             Rate overrides, for example {"suspended":0.1}.

Options:
${CONTROL}
${HELP_FLAG}`,

  credential: `Usage: admin-sdk-mock credential <customerId> [options]

Issue a service account key and grant it domain-wide delegation for the scopes.
Print the key file, or write it with mode 0600.

Options:
  --scopes <read|read-write|a,b>   The scope set or a comma-separated scope list. Default: read.
  --project <id>                   The project ID of the service account.
  --out <file>                     Write the key file instead of printing it.
${CONTROL}
${HELP_FLAG}`,

  settings: `Usage: admin-sdk-mock settings <customerId> --json <patch>

Merge a settings patch into a domain, and print the resulting settings.

Options:
  --json <patch>    The settings patch, for example {"quota":{"perMinute":60}}.
${CONTROL}
${HELP_FLAG}`,

  quota: `Usage: admin-sdk-mock quota <customerId>

Print the quota buckets and the in-flight requests of a domain.

Options:
${CONTROL}
${HELP_FLAG}`,

  fault: `Usage: admin-sdk-mock fault <add|list|clear> <customerId> [options]

Add, list, or clear the fault rules of a domain.

Commands:
  fault add <customerId> --json <rule>   Add a fault rule, for example {"kind":"reset","count":1}.
  fault list <customerId>                List the fault rules.
  fault clear <customerId>               Remove every fault rule.

Options:
  --json <rule>     The fault rule.
${CONTROL}
${HELP_FLAG}`,

  index: `Usage: admin-sdk-mock index flush <customerId>

Apply the pending search index writes of a domain, and end its group delays.

Options:
${CONTROL}
${HELP_FLAG}`,

  clock: `Usage: admin-sdk-mock clock [options]

Print the time scale and the delay switch. Change them with the options.

Options:
  --scale <n>         The time scale, from 1 to 100000.
  --delays <on|off>   Turn the modeled delays on or off.
${CONTROL}
${HELP_FLAG}`,

  ca: `Usage: admin-sdk-mock ca [options]

Print the CA certificate of the mock, or write it to a file.

Options:
  --out <file>      Write the certificate to the file.
${CONTROL}
${HELP_FLAG}`,
};

/** The usage for a command, with the program name the user ran. */
export function usage(command: string, program: string): string {
  return HELP[command].replaceAll('admin-sdk-mock ', `${program} `);
}

/** Print a problem and the usage of a command to standard error, and return exit code 2. */
export function usageFailure(
  io: Io,
  command: string,
  problem?: string,
): number {
  io.stderr(
    `${problem ? `${problem}\n\n` : ''}${usage(command, io.program)}\n`,
  );
  return 2;
}
