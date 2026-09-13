/**
 * Experimental SSH remote workspace Web profile layer. The package exists to
 * carry `cordis.patch.yml` (see `dsh.bundle.patch`), which composes the host
 * controller and the browser panel as an opt-in layer over the web profile.
 *
 * @module @deepseek-ai/dsh-experimental-ssh-remote-web-profile
 */

/**
 * Empty apply: composition happens entirely through the bundle patch.
 */
export function apply(): void {}
