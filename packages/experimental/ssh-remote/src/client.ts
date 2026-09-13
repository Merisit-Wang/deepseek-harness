/**
 * Type-only client outlet for the SSH remote workspace plugin. The browser
 * half imports the generated Remote contribution through the package's
 * `/remote` export and these wire types through `/client`; no runtime code
 * ships on this entry.
 *
 * @module @deepseek-ai/dsh-experimental-ssh-remote/client
 */

export type * from './types.ts'
