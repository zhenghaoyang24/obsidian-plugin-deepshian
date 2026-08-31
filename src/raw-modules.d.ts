// esbuild `?raw` imports: dsh-profile assets baked into main.js as strings so
// the plugin can provision the bridge profile without shipping extra files.
declare module "*.mjs?raw" {
  const content: string;
  export default content;
}
declare module "*.yml?raw" {
  const content: string;
  export default content;
}
declare module "*.json?raw" {
  const content: string;
  export default content;
}