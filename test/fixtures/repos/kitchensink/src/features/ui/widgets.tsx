// trap T8 target (namespaced JSX): consumed as `import * as UI` then `<UI.Button/>` /
// `<UI.Icon/>` in features/misc/Showcase.tsx. Also a default export consumed by default
// import (M6). Stub components.
export function Button(props: { label: string }): JSX.Element {
  return <button>{props.label}</button>;
}

export function Icon(props: { name: string }): JSX.Element {
  return <i data-icon={props.name} />;
}

export default function Panelish(): JSX.Element {
  return <div />;
}
