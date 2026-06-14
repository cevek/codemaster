// Ambient style-module stubs (spec §5). CSS modules (`*.module.scss` / `*.module.css`)
// resolve to a class-name map; bare side-effect stylesheets (`*.scss` / `*.css` / `*.sass`)
// resolve to nothing importable. Lets every connection style compile with no `npm install`.

declare module '*.module.scss' {
  const classes: { readonly [name: string]: string };
  export default classes;
}
declare module '*.module.css' {
  const classes: { readonly [name: string]: string };
  export default classes;
}
declare module '*.scss';
declare module '*.css';
declare module '*.sass';
