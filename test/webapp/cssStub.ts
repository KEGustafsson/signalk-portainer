/**
 * Stands in for a stylesheet import.
 *
 * webpack inlines these as strings (`asset/source`); jest has no loader for
 * them, and the panel's behaviour does not depend on their contents.
 */
export default '.xterm { position: relative; }';
