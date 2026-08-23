/**
 * Stylesheets are inlined as strings by webpack's `asset/source`, so an import
 * of one is a string rather than a side effect.
 */
declare module '*.css' {
  const content: string;
  export default content;
}
