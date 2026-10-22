/** Version of the CLI. Kept in sync with package.json (test/generated.test.ts checks it). */
export const VERSION = '0.1.0';
/** Name of the npm package. Kept in sync with package.json (test/generated.test.ts checks it). */
export const PACKAGE_NAME = '@funnelchat-hq/cli';
/** Product in the User-Agent: `@` and `/` are not valid in an HTTP token, so it is not the package name. */
export const USER_AGENT_PRODUCT = 'funnelchat-cli';
