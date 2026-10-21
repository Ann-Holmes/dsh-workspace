/**
 * Host half of the sidebar file download bundle.
 *
 * The capability is a browser gesture: read the previewed file through the
 * existing `workspaceFiles` Remote namespace and hand the bytes to the
 * browser's download manager. Nothing runs on the Host, so this entry exists
 * only to activate the package whose `dsh.client` half draws the controls.
 */
export function apply() {}
